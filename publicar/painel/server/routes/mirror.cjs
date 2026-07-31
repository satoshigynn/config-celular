// ============================================================================
//  routes/mirror.cjs - espelhamento: sessoes da engine + WebSocket de video
// ----------------------------------------------------------------------------
//  Formato do WebSocket /ws/mirror:
//    servidor -> cliente
//       TEXTO  : JSON de estado  {t:'meta'|'state'|'error'|'clipboard'|'log'}
//       BINARIO: [u8 flags][u32BE ptsMs][payload H.264 Annex-B]
//                flags bit0 = pacote de configuracao (SPS/PPS)
//                      bit1 = keyframe
//    cliente -> servidor
//       TEXTO  : JSON de evento  {t:'touch'|'key'|'scroll'|'text'|'back'|...}
//                (traduzido em control.cjs para o protocolo binario do scrcpy)
// ============================================================================
'use strict';

const { settings, logs } = require('../core.cjs');
const adb = require('../adb.cjs');
const dist = require('../scrcpy/dist.cjs');
const { manager } = require('../scrcpy/session.cjs');
const native = require('../scrcpy/native.cjs');

const log = logs.create('rotas:espelho');

function parseOptions(ctx) {
  const o = {};
  const maxSize = ctx.qInt('maxSize', null);
  const bitrate = ctx.qInt('bitrate', null);
  const maxFps = ctx.qInt('maxFps', null);
  const codec = ctx.q('codec');
  if (maxSize !== null) o.maxSize = Math.max(0, Math.min(4096, maxSize));
  if (bitrate !== null) o.bitrate = Math.max(200000, Math.min(100000000, bitrate));
  if (maxFps !== null) o.maxFps = Math.max(1, Math.min(120, maxFps));
  if (codec === 'h264' || codec === 'h265') o.codec = codec;
  if (ctx.q('crop')) o.crop = ctx.q('crop');
  const angle = ctx.qInt('angle', null);
  if (angle !== null) o.angle = angle;
  return o;
}

function register(router) {
  // estado do scrcpy no PC (versao, pasta, embutido ou nao)
  router.get('/api/scrcpy/status', async (ctx) => {
    await dist.resolve();
    ctx.json(Object.assign({ sessions: manager.list(), processes: native.list() }, dist.status()));
  });

  router.get('/api/scrcpy/encoders', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    ctx.json(Object.assign({ ok: true }, await dist.listEncoders(serial)));
  });

  router.get('/api/mirror/sessions', (ctx) => ctx.json({ ok: true, sessions: manager.list() }));

  // aplica novas opcoes numa sessao viva (reinicia o servidor no aparelho:
  // resolucao/fps/bitrate sao parametros de inicializacao do MediaCodec)
  router.any('/api/mirror/configure', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const opts = parseOptions(ctx);
    settings.patch({
      mirror: Object.assign({}, opts.maxSize !== undefined ? { maxSize: opts.maxSize } : {},
        opts.bitrate !== undefined ? { bitrate: opts.bitrate } : {},
        opts.maxFps !== undefined ? { maxFps: opts.maxFps } : {},
        opts.codec !== undefined ? { codec: opts.codec } : {}),
    });
    if (!manager.has(serial)) return ctx.ok({ applied: opts, restarted: false });
    await manager.restart(serial, opts);
    ctx.ok({ applied: opts, restarted: true });
  });

  router.any('/api/mirror/stop', async (ctx) => {
    const serial = ctx.q('serial');
    const s = manager.get(serial);
    if (s) await s.stop('pedido do painel');
    ctx.ok({});
  });

  // acoes pontuais sem precisar do WebSocket (botoes da barra do espelho)
  router.any('/api/mirror/action', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const action = ctx.q('action');
    const s = manager.get(serial);
    if (!s || s.state !== 'running') return ctx.fail('nao ha espelhamento ativo neste aparelho');
    const ev = {
      rotate: { t: 'rotate' },
      back: { t: 'key', k: 'Escape' },
      home: { t: 'key', k: 3 },
      apps: { t: 'key', k: 187 },
      power: { t: 'key', k: 26 },
      notifications: { t: 'notifications' },
      collapse: { t: 'collapse' },
      volup: { t: 'key', k: 24 },
      voldown: { t: 'key', k: 25 },
      keyframe: { t: 'reset' },
      'screen-on': { t: 'power', on: true },
      'screen-off': { t: 'power', on: false },
    }[action];
    if (!ev) return ctx.fail('acao desconhecida: ' + action);
    if (ev.t === 'key') { s.sendEvent(Object.assign({ a: 'down' }, ev)); s.sendEvent(Object.assign({ a: 'up' }, ev)); }
    else s.sendEvent(ev);
    ctx.ok({ action });
  });

  // ------------------------------------------------------- janela nativa ----
  router.any('/api/mirror/window', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const dev = adb.registry.get(serial);
    const rec = await native.openWindow(serial, Object.assign(parseOptions(ctx), {
      fullscreen: ctx.qBool('fullscreen'),
      alwaysOnTop: ctx.qBool('alwaysOnTop'),
      borderless: ctx.qBool('borderless'),
      audio: !ctx.qBool('noAudio'),
      turnScreenOff: ctx.qBool('turnScreenOff'),
      title: (dev && dev.info ? dev.info.name : serial) + ' - Config Celular',
    }));
    ctx.ok({ process: rec });
  });

  router.any('/api/mirror/window/stop', async (ctx) => {
    const r = await native.stop(ctx.q('id'));
    ctx.json(Object.assign({ ok: true }, r));
  });
}

// ---------------------------------------------------------------- WebSocket -
// Liga um cliente do navegador a uma sessao da engine.
async function attach(conn, url) {
  const requested = url.searchParams.get('serial') || '';
  const serial = adb.registry.resolve(requested);
  if (!serial) {
    conn.sendJson({ t: 'error', message: 'nenhum aparelho selecionado' });
    return conn.close(1008, 'sem aparelho');
  }

  const opts = {};
  const int = (k, min, max) => {
    const v = parseInt(url.searchParams.get(k), 10);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : undefined;
  };
  const maxSize = int('maxSize', 0, 4096); if (maxSize !== undefined) opts.maxSize = maxSize;
  const bitrate = int('bitrate', 200000, 100000000); if (bitrate !== undefined) opts.bitrate = bitrate;
  const maxFps = int('maxFps', 1, 120); if (maxFps !== undefined) opts.maxFps = maxFps;
  const codec = url.searchParams.get('codec'); if (codec === 'h264' || codec === 'h265') opts.codec = codec;

  let session = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (session) {
      session.off('video', onVideo);
      session.off('resize', onResize);
      session.off('device-message', onDeviceMsg);
      session.off('error-state', onError);
      session.off('log', onLog);
      session.off('closed', onClosed);
    }
    manager.release(serial);
  };

  // Quando a sessao termina no servidor (aparelho desconectou, encerramos pelo
  // painel, o scrcpy-server caiu), o WebSocket PRECISA fechar. Sem isso o
  // navegador continuava com o ultimo quadro na tela achando que estava tudo
  // certo - o espelho congelava em silencio e nada religava.
  const onClosed = (reason) => {
    conn.sendJson({ t: 'closed', reason: reason || '' });
    conn.close(1012, 'sessao encerrada');
  };

  const sendPacket = (p) => {
    const head = Buffer.allocUnsafe(5);
    head[0] = (p.config ? 1 : 0) | (p.key ? 2 : 0);
    head.writeUInt32BE(Math.max(0, Math.round((p.pts || 0) / 1000)) >>> 0, 1);
    // dropIfBusy: se o socket do navegador engasgar, perder frame e melhor
    // do que acumular atraso (nao vale para config/keyframe)
    conn.sendBinary(Buffer.concat([head, p.data]), !p.config && !p.key);
  };

  const onVideo = (p) => sendPacket(p);
  const onResize = (r) => conn.sendJson({ t: 'meta', width: r.width, height: r.height, codec: session.codec, deviceName: session.deviceName });
  const onDeviceMsg = (m) => conn.sendJson({ t: m.type === 'clipboard' ? 'clipboard' : 'device', text: m.text || '', raw: m });
  const onError = (message) => conn.sendJson({ t: 'error', message });
  const onLog = (line) => conn.sendJson({ t: 'log', line });

  try {
    session = await manager.acquire(serial, opts);
  } catch (e) {
    conn.sendJson({ t: 'error', message: e.message || String(e) });
    return conn.close(1011, 'falha ao iniciar');
  }

  conn.on('close', release);
  conn.on('error', release);

  session.on('video', onVideo);
  session.on('resize', onResize);
  session.on('device-message', onDeviceMsg);
  session.on('error-state', onError);
  session.on('log', onLog);
  session.once('closed', onClosed);

  conn.sendJson({
    t: 'meta',
    serial,
    codec: session.codec,
    width: session.width,
    height: session.height,
    deviceName: session.deviceName,
    options: session.options,
  });
  // Um cliente que entra no MEIO do fluxo precisa de SPS/PPS + um keyframe novo.
  // Quem entra junto com a sessao nao precisa de nada: o proprio scrcpy-server
  // manda config + keyframe ao iniciar (e pedir reset cedo demais derruba a
  // sessao - ver o comentario em requestKeyFrame).
  if (session.configPacket) {
    sendPacket({ config: true, key: false, pts: 0, data: session.configPacket });
    session.requestKeyFrame();
  }

  conn.on('json', (ev) => {
    if (!ev || typeof ev.t !== 'string') return;
    if (ev.t === 'ping') return conn.sendJson({ t: 'pong', at: Date.now() });
    if (ev.t === 'keyframe') return session.requestKeyFrame();
    if (ev.t === 'stats') {
      return conn.sendJson({ t: 'stats', stats: session.stats, state: session.state });
    }
    session.sendEvent(ev);
  });
}

module.exports = { register, attach };
