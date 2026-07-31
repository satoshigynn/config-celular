// ============================================================================
//  scrcpy/session.cjs - ENGINE NATIVA: o programa fala o protocolo do scrcpy
// ----------------------------------------------------------------------------
//  Nao e "abrir o scrcpy.exe". O fluxo aqui e o mesmo do cliente oficial:
//
//   1. envia o scrcpy-server.jar para /data/local/tmp        (dist.ensureServer)
//   2. abre o tunel:  adb forward tcp:0 localabstract:scrcpy_<scid>
//   3. sobe o servidor:  app_process / com.genymobile.scrcpy.Server <versao> ...
//   4. conecta 2 sockets no tunel: VIDEO e CONTROLE (nessa ordem - e a ordem
//      em que o servidor da accept())
//   5. le do socket de video:  [byte dummy][nome do aparelho 64B][codec 4B]
//      e depois um fluxo de pacotes com cabecalho de 12 bytes
//   6. escreve mensagens de controle (toque/tecla/scroll) no socket de controle
//
//  O video sai daqui em H.264 puro e vai para o navegador por WebSocket, onde
//  o WebCodecs decodifica. Nenhum frame e re-encodado: latencia baixa e CPU
//  quase zero no PC.
// ============================================================================
'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { ADB, logs, settings, util } = require('../core.cjs');
const adb = require('../adb.cjs');
const dist = require('./dist.cjs');
const control = require('./control.cjs');

const log = logs.create('scrcpy');

const CODEC_NAMES = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
  0x00767038: 'vp8',
  0x00767039: 'vp9',
};

const PTS_MASK = (1n << 61n) - 1n;
const CONNECT_ATTEMPTS = 120;      // ~12s esperando o servidor subir
const CONNECT_INTERVAL = 100;

// Fila de bytes que evita concat a cada chunk (o video chega em rajadas).
class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; }
  push(buf) { this.chunks.push(buf); this.length += buf.length; }
  // devolve os primeiros n bytes e os remove; null se ainda nao ha n bytes
  take(n) {
    if (this.length < n) return null;
    if (this.chunks[0].length >= n) {
      const head = this.chunks[0];
      const out = head.subarray(0, n);
      if (head.length === n) this.chunks.shift();
      else this.chunks[0] = head.subarray(n);
      this.length -= n;
      return out;
    }
    const parts = [];
    let need = n;
    while (need > 0) {
      const head = this.chunks[0];
      if (head.length <= need) { parts.push(head); need -= head.length; this.chunks.shift(); }
      else { parts.push(head.subarray(0, need)); this.chunks[0] = head.subarray(need); need = 0; }
    }
    this.length -= n;
    return Buffer.concat(parts, n);
  }
}

function connectWithRetry(port, wantDummyByte) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOnce = () => {
      attempts++;
      const socket = net.connect({ port, host: '127.0.0.1' });
      let settled = false;
      const retry = (why) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) { }
        if (attempts >= CONNECT_ATTEMPTS) return reject(new Error('o scrcpy-server nao respondeu (' + why + ')'));
        setTimeout(tryOnce, CONNECT_INTERVAL);
      };
      const guard = setTimeout(() => retry('tempo esgotado'), wantDummyByte ? 700 : 1500);

      socket.once('error', () => { clearTimeout(guard); retry('erro de conexao'); });
      socket.once('close', () => { clearTimeout(guard); retry('conexao fechada'); });

      if (!wantDummyByte) {
        socket.once('connect', () => {
          // sem o byte dummy nao da para saber na hora se o servidor aceitou;
          // uma janela curta detecta o close imediato do adb
          setTimeout(() => {
            if (settled || socket.destroyed) return;
            settled = true;
            clearTimeout(guard);
            socket.removeAllListeners('close');
            socket.removeAllListeners('error');
            resolve({ socket, first: null });
          }, 120);
        });
        return;
      }

      socket.once('data', (chunk) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        // o primeiro byte e o dummy do servidor; o resto ja e stream
        resolve({ socket, first: chunk.length > 1 ? chunk.subarray(1) : null });
      });
    };
    tryOnce();
  });
}

class ScrcpySession extends EventEmitter {
  constructor(serial, options) {
    super();
    this.setMaxListeners(40);
    this.serial = serial;
    this.options = Object.assign({
      maxSize: settings.get('mirror.maxSize', 1280),
      bitrate: settings.get('mirror.bitrate', 8000000),
      maxFps: settings.get('mirror.maxFps', 60),
      codec: settings.get('mirror.codec', 'h264'),
      stayAwake: settings.get('mirror.stayAwake', true),
      powerOn: settings.get('mirror.powerOn', true),
      showTouches: settings.get('mirror.showTouches', false),
      displayId: 0,
      control: true,
      crop: '',
      angle: 0,
    }, options || {});

    this.state = 'idle';       // idle | starting | running | stopping | error
    this.error = '';
    this.deviceName = '';
    this.codec = '';
    this.width = 0;
    this.height = 0;
    this.configPacket = null;  // SPS/PPS: todo cliente novo precisa disso
    this.lastKeyAt = 0;
    this.stats = { frames: 0, bytes: 0, startedAt: 0, lastFrameAt: 0 };
    this.clients = 0;

    this._child = null;
    this._video = null;
    this._control = null;
    this._forward = '';
    this._queue = new ByteQueue();
    this._phase = 'name';
    this._pending = null;
    this._ctlBuf = Buffer.alloc(0);
    this._logTail = [];
  }

  get info() {
    return {
      serial: this.serial,
      state: this.state,
      error: this.error,
      deviceName: this.deviceName,
      codec: this.codec,
      width: this.width,
      height: this.height,
      clients: this.clients,
      options: this.options,
      stats: Object.assign({}, this.stats),
    };
  }

  // ---------------------------------------------------------------- start --
  async start() {
    if (this.state === 'running' || this.state === 'starting') return this;
    this.state = 'starting';
    this.error = '';
    try {
      const d = await dist.ensureServer(this.serial);
      const scid = (Math.floor(Math.random() * 0x7fffffff)).toString(16).padStart(8, '0');
      const socketName = 'localabstract:scrcpy_' + scid;

      // tcp:0 faz o adb escolher uma porta livre e imprimi-la
      const fwd = await adb.exec(this.serial, ['forward', 'tcp:0', socketName], { timeout: 10000 });
      const port = parseInt(String(fwd.stdout).trim(), 10);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error('nao consegui abrir o tunel adb: ' + (fwd.stdout + fwd.stderr).trim());
      }
      this._forward = 'tcp:' + port;

      const o = this.options;
      const serverArgs = [
        d.version,
        'scid=' + scid,
        'log_level=info',
        'video=true',
        'audio=false',
        'control=' + (o.control ? 'true' : 'false'),
        'tunnel_forward=true',
        'send_dummy_byte=true',
        'send_device_meta=true',
        'send_frame_meta=true',
        'send_stream_meta=true',
        'video_codec=' + (o.codec === 'h265' ? 'h265' : 'h264'),
        'max_size=' + Math.max(0, Math.round(o.maxSize || 0)),
        'video_bit_rate=' + Math.max(100000, Math.round(o.bitrate || 8000000)),
        'max_fps=' + Math.max(1, Math.round(o.maxFps || 60)),
        'display_id=' + (o.displayId || 0),
        'stay_awake=' + (o.stayAwake ? 'true' : 'false'),
        'power_on=' + (o.powerOn ? 'true' : 'false'),
        'show_touches=' + (o.showTouches ? 'true' : 'false'),
        'clipboard_autosync=true',
        'downsize_on_error=true',
        'cleanup=true',
      ];
      if (o.crop) serverArgs.push('crop=' + o.crop);
      if (o.angle) serverArgs.push('angle=' + o.angle);

      log.info(`iniciando engine em ${this.serial} (scid ${scid}, porta ${port}, ${o.codec} ${o.maxSize}px ${o.maxFps}fps)`);

      this._child = spawn(ADB, [
        '-s', this.serial, 'shell',
        'CLASSPATH=' + dist.DEVICE_JAR,
        'app_process', '/', 'com.genymobile.scrcpy.Server',
      ].concat(serverArgs), { windowsHide: true });

      const onServerLine = (b) => {
        b.toString('utf8').split(/\r?\n/).forEach((l) => {
          if (!l.trim()) return;
          this._logTail.push(l);
          if (this._logTail.length > 60) this._logTail.shift();
          this.emit('log', l);
          if (/ERROR|Exception|does not match/i.test(l)) log.warn(`[${this.serial}] ${l}`);
        });
      };
      this._child.stdout.on('data', onServerLine);
      this._child.stderr.on('data', onServerLine);
      this._child.on('close', (code) => {
        if (this.state === 'running' || this.state === 'starting') {
          this._fail('o scrcpy-server encerrou (codigo ' + code + ')' +
            (this._logTail.length ? ' - ' + this._logTail.slice(-2).join(' | ') : ''));
        }
      });

      // socket de VIDEO (recebe o byte dummy), depois o de CONTROLE
      const v = await connectWithRetry(port, true);
      this._video = v.socket;
      this._video.setNoDelay(true);
      this._video.on('data', (c) => this._onVideoData(c));
      this._video.on('error', () => this._fail('conexao de video perdida'));
      this._video.on('close', () => { if (this.state === 'running') this._fail('conexao de video fechada'); });
      if (v.first && v.first.length) this._onVideoData(v.first);

      if (o.control) {
        const c = await connectWithRetry(port, false);
        this._control = c.socket;
        this._control.setNoDelay(true);
        this._control.on('data', (chunk) => this._onControlData(chunk));
        this._control.on('error', () => { });
      }

      this.state = 'running';
      this.stats.startedAt = Date.now();
      this.emit('state', this.info);
      return this;
    } catch (e) {
      this._fail(e.message || String(e));
      throw e;
    }
  }

  _fail(message) {
    if (this.state === 'stopping' || this.state === 'idle') return;
    this.error = message;
    this.state = 'error';
    log.warn(`[${this.serial}] ${message}`);
    this.emit('error-state', message);
    this.emit('state', this.info);
    this._cleanup();
  }

  // ------------------------------------------------------------- recepcao --
  _onVideoData(chunk) {
    this._queue.push(chunk);
    for (;;) {
      if (this._phase === 'name') {
        const buf = this._queue.take(64);
        if (!buf) return;
        this.deviceName = buf.toString('utf8').replace(/\0.*$/, '').trim();
        this._phase = 'codec';
      } else if (this._phase === 'codec') {
        const buf = this._queue.take(4);
        if (!buf) return;
        const id = buf.readUInt32BE(0);
        this.codec = CODEC_NAMES[id] || ('0x' + id.toString(16));
        this._phase = 'header';
        this.emit('ready', { deviceName: this.deviceName, codec: this.codec });
      } else if (this._phase === 'header') {
        const buf = this._queue.take(12);
        if (!buf) return;
        const hi = buf.readUInt32BE(0);
        if (hi & 0x80000000) {
          // pacote de sessao: so informa o tamanho do video (nao tem payload)
          this.width = buf.readUInt32BE(4);
          this.height = buf.readUInt32BE(8);
          this.emit('resize', { width: this.width, height: this.height });
          continue;
        }
        const size = buf.readUInt32BE(8);
        if (size > 32 * 1024 * 1024) return this._fail('pacote de video invalido');
        this._pending = {
          config: (hi & 0x40000000) !== 0,
          key: (hi & 0x20000000) !== 0,
          pts: Number(buf.readBigUInt64BE(0) & PTS_MASK),
          size,
        };
        this._phase = 'payload';
      } else {
        const data = this._queue.take(this._pending.size);
        if (!data) return;
        const p = this._pending;
        this._pending = null;
        this._phase = 'header';
        this.stats.frames++;
        this.stats.bytes += data.length;
        this.stats.lastFrameAt = Date.now();
        if (p.config) this.configPacket = data;
        if (p.key) this.lastKeyAt = Date.now();
        this.emit('video', { config: p.config, key: p.key, pts: p.pts, data });
      }
    }
  }

  _onControlData(chunk) {
    this._ctlBuf = this._ctlBuf.length ? Buffer.concat([this._ctlBuf, chunk]) : chunk;
    const { messages, rest } = control.parseDeviceMessages(this._ctlBuf);
    this._ctlBuf = rest;
    for (const m of messages) this.emit('device-message', m);
  }

  // -------------------------------------------------------------- controle --
  send(buffer) {
    if (!this._control || this._control.destroyed || !buffer) return false;
    try { this._control.write(buffer); return true; } catch (_) { return false; }
  }

  sendEvent(ev) {
    const buf = control.fromClientEvent(ev, { width: this.width, height: this.height });
    return buf ? this.send(buf) : false;
  }

  // Pede um novo keyframe (usado quando um cliente novo entra no meio do fluxo).
  //
  // ATENCAO: o RESET_VIDEO so pode ser enviado depois que o encoder do aparelho
  // terminou de subir. O scrcpy-server chama surfaceCapture.getCaptureControl()
  // sem checar nulo, e esse objeto so existe apos SurfaceEncoder.run() rodar
  // capture.init(...). Mandar cedo demais derruba a sessao inteira com
  // NullPointerException. Como o proprio servidor ja manda config + keyframe ao
  // iniciar, quem entra no comeco nao precisa de reset nenhum.
  requestKeyFrame() {
    if (this.state !== 'running' || !this.stats.frames || !this.configPacket) return false;
    return this.send(control.msg.resetVideo());
  }

  // ---------------------------------------------------------------- stop ---
  async stop(reason) {
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.state = 'stopping';
    log.info(`encerrando engine em ${this.serial}${reason ? ' (' + reason + ')' : ''}`);
    await this._cleanup();
    this.state = 'idle';
    this.emit('state', this.info);
    this.emit('closed', reason || '');
  }

  async _cleanup() {
    for (const s of [this._video, this._control]) {
      if (s) { try { s.destroy(); } catch (_) { } }
    }
    this._video = this._control = null;
    if (this._child) { try { this._child.kill(); } catch (_) { } this._child = null; }
    if (this._forward) {
      const f = this._forward; this._forward = '';
      try { await adb.forwardRemove(this.serial, f); } catch (_) { }
    }
    this._queue = new ByteQueue();
    this._phase = 'name';
    this._pending = null;
    // O scrcpy-server roda com cleanup=true e, ao sair, APAGA o proprio .jar de
    // /data/local/tmp (CleanUp.unlinkSelf). Se mantivessemos o cache de envio,
    // a proxima sessao subiria apontando para um arquivo inexistente e o
    // app_process abortaria (exit 134). Entao esquecemos o envio aqui.
    dist.forgetDevice(this.serial);
  }
}

// ---------------------------------------------------------------- gerente ---
// Uma sessao por aparelho, compartilhada por todos os clientes (o painel pode
// ter varias abas/janelas). Encerra sozinha alguns segundos depois que o
// ultimo cliente sai, para nao ficar consumindo bateria do celular.
const GRACE_MS = 4000;

class SessionManager extends EventEmitter {
  constructor() { super(); this.sessions = new Map(); this.timers = new Map(); }

  has(serial) { return this.sessions.has(serial); }
  get(serial) { return this.sessions.get(serial) || null; }
  list() { return [...this.sessions.values()].map((s) => s.info); }

  async acquire(serial, options) {
    clearTimeout(this.timers.get(serial));
    this.timers.delete(serial);

    let s = this.sessions.get(serial);
    if (s && options && this._optionsDiffer(s.options, options)) {
      await this.restart(serial, options);
      s = this.sessions.get(serial);
    }
    if (!s) {
      s = new ScrcpySession(serial, options);
      this.sessions.set(serial, s);
      s.on('closed', () => { if (this.sessions.get(serial) === s) this.sessions.delete(serial); });
      s.on('state', () => this.emit('change', this.list()));
      try {
        await s.start();
      } catch (e) {
        this.sessions.delete(serial);
        throw e;
      }
      this.emit('change', this.list());
    }
    s.clients++;
    return s;
  }

  release(serial) {
    const s = this.sessions.get(serial);
    if (!s) return;
    s.clients = Math.max(0, s.clients - 1);
    if (s.clients > 0) return;
    clearTimeout(this.timers.get(serial));
    this.timers.set(serial, setTimeout(() => {
      const cur = this.sessions.get(serial);
      if (cur && cur.clients === 0) {
        cur.stop('sem clientes').catch(() => { });
        this.sessions.delete(serial);
        this.emit('change', this.list());
      }
      this.timers.delete(serial);
    }, GRACE_MS));
  }

  _optionsDiffer(a, b) {
    return ['maxSize', 'bitrate', 'maxFps', 'codec', 'displayId', 'crop', 'angle']
      .some((k) => b[k] !== undefined && a[k] !== b[k]);
  }

  // Trocar resolucao/FPS/bitrate exige subir o servidor de novo: sao opcoes de
  // inicializacao do MediaCodec no aparelho.
  async restart(serial, options) {
    const old = this.sessions.get(serial);
    const clients = old ? old.clients : 0;
    if (old) { await old.stop('reconfigurando'); this.sessions.delete(serial); }
    const merged = Object.assign({}, old ? old.options : {}, options || {});
    const s = new ScrcpySession(serial, merged);
    this.sessions.set(serial, s);
    s.clients = clients;
    s.on('closed', () => { if (this.sessions.get(serial) === s) this.sessions.delete(serial); });
    s.on('state', () => this.emit('change', this.list()));
    try { await s.start(); } catch (e) { this.sessions.delete(serial); throw e; }
    this.emit('change', this.list());
    return s;
  }

  async stopAll() {
    for (const [serial, s] of this.sessions) {
      await s.stop('encerrando o painel').catch(() => { });
      this.sessions.delete(serial);
    }
  }
}

const manager = new SessionManager();

module.exports = { ScrcpySession, manager, CODEC_NAMES };
