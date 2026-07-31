/* ==========================================================================
   player.js - o espelho: decodifica H.264 e devolve o controle ao aparelho
   --------------------------------------------------------------------------
   O servidor entrega os pacotes exatamente como o MediaCodec do celular
   produziu (Annex-B). Aqui eles vao direto para o WebCodecs - nenhum
   re-encode, nenhuma imagem intermediaria. Cada frame decodificado e desenhado
   no canvas e liberado na hora (VideoFrame precisa de close() manual).

   Entrada -> saida:
     mouse   -> mensagem de toque (down/move/up) no espaco de coordenadas do video
     roda    -> mensagem de scroll
     teclado -> teclas de controle viram keycode do Android; texto normal vai
                como "inject text" (assim acento e c-cedilha funcionam)
   ========================================================================== */

import { h, clear, toast } from '../core/kit.js';
import { api } from '../core/api.js';

export const webcodecsSupported = typeof window.VideoDecoder === 'function';

// KeyboardEvent.code que devem virar keycode do Android (o resto vai como texto)
const CONTROL_KEYS = new Set([
  'Backspace', 'Tab', 'Enter', 'NumpadEnter', 'Escape', 'Space',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'CapsLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12',
]);

const META = { SHIFT: 0x01, ALT: 0x02, CTRL: 0x1000, META: 0x10000 };
const BUTTON = { PRIMARY: 1, SECONDARY: 2, TERTIARY: 4 };

function metaStateOf(e) {
  return (e.shiftKey ? META.SHIFT : 0) | (e.altKey ? META.ALT : 0)
    | (e.ctrlKey ? META.CTRL : 0) | (e.metaKey ? META.META : 0);
}

export class MirrorPlayer {
  constructor(options = {}) {
    this.options = options;
    this.canvas = h('canvas', { width: 1, height: 1, tabindex: '0', 'aria-label': 'Tela do aparelho' });
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.socket = null;
    this.decoder = null;
    this.codecString = '';
    this.pendingConfig = null;
    this.width = 0;
    this.height = 0;
    this.state = 'idle';          // idle | connecting | live | error | closed
    this.error = '';
    this.controlEnabled = true;
    this.pointerDown = false;
    this.stats = { frames: 0, bytes: 0, fps: 0, kbps: 0, decoded: 0, dropped: 0, since: 0 };
    this._statTimer = null;
    this._lastFrames = 0;
    this._lastBytes = 0;
    this._bound = false;
  }

  /* ---------------------------------------------------------- conexao ---- */
  connect(serial, opts = {}) {
    this.close();
    this.state = 'connecting';
    this.error = '';
    this._emit();

    const params = { serial };
    if (opts.maxSize) params.maxSize = opts.maxSize;
    if (opts.bitrate) params.bitrate = opts.bitrate;
    if (opts.maxFps) params.maxFps = opts.maxFps;
    if (opts.codec) params.codec = opts.codec;

    const sock = api.socket('/ws/mirror', params);
    sock.binaryType = 'arraybuffer';
    this.socket = sock;

    sock.onopen = () => { this.stats.since = Date.now(); this._startStats(); };

    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') return this._onJson(ev.data);
      this._onPacket(new Uint8Array(ev.data));
    };

    sock.onerror = () => { };
    sock.onclose = () => {
      this._stopStats();
      if (this.state !== 'error' && this.state !== 'closed') {
        this.state = 'closed';
        this._emit();
      }
    };

    if (!this._bound) { this._bindInput(); this._bound = true; }
  }

  close() {
    this._stopStats();
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      try { s.onclose = null; s.close(); } catch (_) { }
    }
    if (this.decoder) {
      try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch (_) { }
      this.decoder = null;
    }
    this.codecString = '';
    this.pendingConfig = null;
    this.state = 'closed';
  }

  send(obj) {
    if (this.socket && this.socket.readyState === 1) {
      try { this.socket.send(JSON.stringify(obj)); return true; } catch (_) { }
    }
    return false;
  }

  requestKeyFrame() { this.send({ t: 'keyframe' }); }

  /* ------------------------------------------------------------ mensagens - */
  _onJson(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    switch (msg.t) {
      case 'meta':
        if (msg.width && msg.height && (msg.width !== this.width || msg.height !== this.height)) {
          this.width = msg.width;
          this.height = msg.height;
          this.canvas.width = msg.width;
          this.canvas.height = msg.height;
          this._resetDecoder();
        }
        this.deviceName = msg.deviceName || this.deviceName;
        this.codec = msg.codec || this.codec;
        this.options.onMeta?.(msg);
        break;
      case 'error':
        this.state = 'error';
        this.error = msg.message || 'falha no espelhamento';
        this._emit();
        break;
      case 'clipboard':
        this.options.onClipboard?.(msg.text || '');
        break;
      case 'log':
        this.options.onLog?.(msg.line);
        break;
      default: break;
    }
  }

  _onPacket(buf) {
    if (buf.length < 5) return;
    const flags = buf[0];
    const isConfig = (flags & 1) !== 0;
    const isKey = (flags & 2) !== 0;
    const ptsMs = (buf[1] << 24 | buf[2] << 16 | buf[3] << 8 | buf[4]) >>> 0;
    const payload = buf.subarray(5);

    this.stats.frames++;
    this.stats.bytes += payload.length;

    if (!webcodecsSupported) return;

    if (isConfig) {
      // SPS/PPS: guarda para colar no proximo keyframe (o WebCodecs em modo
      // Annex-B espera os parametros junto do frame)
      this.pendingConfig = payload.slice();
      const codec = codecStringFromSps(payload);
      if (codec && codec !== this.codecString) {
        this.codecString = codec;
        this._resetDecoder();
      }
      return;
    }

    if (!this.decoder || this.decoder.state !== 'configured') {
      if (!this._ensureDecoder()) return;
    }

    let data = payload;
    if (isKey && this.pendingConfig) {
      data = new Uint8Array(this.pendingConfig.length + payload.length);
      data.set(this.pendingConfig, 0);
      data.set(payload, this.pendingConfig.length);
      this.pendingConfig = null;
    } else if (!isKey && this.stats.decoded === 0) {
      return;   // ainda nao veio keyframe: nao adianta decodificar
    }

    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: ptsMs * 1000,
        data,
      }));
    } catch (e) {
      this.stats.dropped++;
      this._resetDecoder();
      this.requestKeyFrame();
    }
  }

  /* ------------------------------------------------------------ decoder --- */
  _ensureDecoder() {
    if (this.decoder && this.decoder.state === 'configured') return true;
    if (!this.codecString) return false;
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this._draw(frame),
        error: (e) => {
          this.stats.dropped++;
          console.warn('decoder:', e.message);
          this._resetDecoder();
          this.requestKeyFrame();
        },
      });
      this.decoder.configure({
        codec: this.codecString,
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference',
      });
      return true;
    } catch (e) {
      this.state = 'error';
      this.error = 'nao consegui iniciar o decodificador de video: ' + e.message;
      this._emit();
      return false;
    }
  }

  _resetDecoder() {
    if (this.decoder) {
      try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch (_) { }
      this.decoder = null;
    }
    this.stats.decoded = 0;
    this._ensureDecoder();
  }

  _draw(frame) {
    try {
      if (frame.displayWidth && frame.displayWidth !== this.canvas.width) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
        this.width = frame.displayWidth;
        this.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      this.stats.decoded++;
      if (this.state !== 'live') { this.state = 'live'; this._emit(); }
    } catch (_) {
    } finally {
      frame.close();   // sem isso a memoria de video acaba em segundos
    }
  }

  /* ------------------------------------------------------- estatisticas --- */
  _startStats() {
    this._stopStats();
    this._statTimer = setInterval(() => {
      const df = this.stats.frames - this._lastFrames;
      const db = this.stats.bytes - this._lastBytes;
      this._lastFrames = this.stats.frames;
      this._lastBytes = this.stats.bytes;
      this.stats.fps = df;
      this.stats.kbps = Math.round((db * 8) / 1000);
      this.options.onStats?.(this.stats);
    }, 1000);
  }
  _stopStats() { clearInterval(this._statTimer); this._statTimer = null; }
  _emit() { this.options.onState?.(this.state, this.error); }

  /* ------------------------------------------------------------- entrada -- */
  // converte a posicao do mouse no canvas para o espaco de coordenadas do video
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    return {
      x: Math.max(0, Math.min(this.canvas.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.canvas.height - 1, Math.round(y))),
    };
  }

  _bindInput() {
    const c = this.canvas;

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      if (!this.controlEnabled) return;
      c.focus();
      e.preventDefault();
      if (e.button === 2) return this.send({ t: 'back', a: 'down' });
      if (e.button === 1) { this.tapKey(3); return; }   // botao do meio = Inicio
      const p = this._pos(e);
      this.pointerDown = true;
      c.setPointerCapture(e.pointerId);
      this.send({ t: 'touch', a: 'down', x: p.x, y: p.y, pr: e.pressure || 1, b: BUTTON.PRIMARY });
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.controlEnabled || !this.pointerDown) return;
      const p = this._pos(e);
      this.send({ t: 'touch', a: 'move', x: p.x, y: p.y, pr: e.pressure || 1, b: BUTTON.PRIMARY });
    });

    const up = (e) => {
      if (!this.controlEnabled) return;
      if (e.button === 2) return this.send({ t: 'back', a: 'up' });
      if (!this.pointerDown) return;
      this.pointerDown = false;
      const p = this._pos(e);
      this.send({ t: 'touch', a: 'up', x: p.x, y: p.y, b: 0 });
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', (e) => { if (this.pointerDown) up(e); });

    c.addEventListener('wheel', (e) => {
      if (!this.controlEnabled) return;
      e.preventDefault();
      const p = this._pos(e);
      // deltaMode 0 = pixels, 1 = linhas
      const factor = e.deltaMode === 1 ? 1 : 1 / 40;
      this.send({
        t: 'scroll', x: p.x, y: p.y,
        h: -e.deltaX * factor, v: -e.deltaY * factor,
      });
    }, { passive: false });

    c.addEventListener('keydown', (e) => this._onKey(e, 'down'));
    c.addEventListener('keyup', (e) => this._onKey(e, 'up'));
  }

  _onKey(e, action) {
    if (!this.controlEnabled) return;
    if (e.key === 'F11') return;                 // reservado para tela cheia
    const meta = metaStateOf(e);

    // combinacoes com Ctrl vao como keycode (Ctrl+A/C/V/X funcionam no Android)
    const isCombo = e.ctrlKey || e.metaKey || e.altKey;

    if (CONTROL_KEYS.has(e.code) || isCombo) {
      e.preventDefault();
      this.send({ t: 'key', a: action, k: e.code, m: meta, r: e.repeat ? 1 : 0 });
      return;
    }

    // texto normal: injeta como texto para nao perder acento/cedilha
    if (action === 'down' && e.key.length === 1) {
      e.preventDefault();
      this.send({ t: 'text', s: e.key });
    }
  }

  /* ------------------------------------------------------------- acoes ---- */
  tapKey(keycode, meta) {
    this.send({ t: 'key', a: 'down', k: keycode, m: meta || 0 });
    this.send({ t: 'key', a: 'up', k: keycode, m: meta || 0 });
  }

  back() { this.send({ t: 'back', a: 'down' }); this.send({ t: 'back', a: 'up' }); }
  home() { this.tapKey(3); }
  recents() { this.tapKey(187); }
  power() { this.tapKey(26); }
  volumeUp() { this.tapKey(24); }
  volumeDown() { this.tapKey(25); }
  rotate() { this.send({ t: 'rotate' }); }
  notifications() { this.send({ t: 'notifications' }); }
  screenOff() { this.send({ t: 'power', on: false }); }
  screenOn() { this.send({ t: 'power', on: true }); }
  typeText(text) { if (text) this.send({ t: 'text', s: text }); }
  pasteToDevice(text) { this.send({ t: 'clipboard-set', s: text, paste: true, seq: Date.now() % 2147483647 }); }
  copyFromDevice() { this.send({ t: 'clipboard-get', copy: 1 }); }

  snapshot() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }
}

/* ---------------------------------------------------------------- SPS ----- */
// Le profile/constraints/level do SPS para montar a string 'avc1.PPCCLL'
export function codecStringFromSps(bytes) {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const isStart3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const isStart4 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!isStart3 && !isStart4) continue;
    const nalIdx = i + (isStart4 ? 4 : 3);
    if ((bytes[nalIdx] & 0x1f) !== 7) continue;   // 7 = SPS
    if (nalIdx + 3 >= bytes.length) return '';
    const hex = (n) => n.toString(16).padStart(2, '0');
    return 'avc1.' + hex(bytes[nalIdx + 1]) + hex(bytes[nalIdx + 2]) + hex(bytes[nalIdx + 3]);
  }
  return '';
}

/* ------------------------------------------------------------- fallback --- */
/**
 * Modo simples: quando o navegador nao tem WebCodecs ou o scrcpy nao esta
 * disponivel, cai para prints sequenciais (o metodo da versao anterior).
 * Sem controle, mas continua mostrando a tela.
 */
export class SimpleMirror {
  constructor(options = {}) {
    this.options = options;
    this.img = h('img', { alt: 'Tela do aparelho', style: { maxWidth: '100%', display: 'block' } });
    this.timer = null;
    this.url = '';
    this.busy = false;
  }

  start(serial, intervalMs = 1200) {
    this.stop();
    this.serial = serial;
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        const blob = await api.blob('/api/capture/screenshot', { serial: this.serial, inline: 1, t: Date.now() });
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(blob);
        this.img.src = this.url;
        this.options.onFrame?.();
      } catch (e) {
        this.options.onError?.(e.message);
      } finally { this.busy = false; }
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
  }
}
