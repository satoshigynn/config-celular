// ============================================================================
//  routes/devices.cjs - dispositivos, selecao e conexao Wi-Fi
// ============================================================================
'use strict';

const { settings, util, logs } = require('../core.cjs');
const adb = require('../adb.cjs');

const log = logs.create('rotas:dispositivos');

function register(router) {
  // lista completa (a UI tambem recebe isso por WebSocket, sem precisar pedir)
  router.get('/api/devices', (ctx) => {
    ctx.json({
      ok: true,
      devices: adb.registry.snapshot(),
      selected: adb.getTarget(),
      adb: adb.registry.adbOk,
      known: settings.get('known', []),
    });
  });

  // detalhes completos de um aparelho (leitura direta, sem cache)
  router.get('/api/devices/info', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const info = await adb.deviceInfo(serial);
    const dev = adb.registry.get(serial);
    if (dev) { dev.info = info; dev.infoAt = Date.now(); }
    ctx.json({ ok: true, serial, transport: dev ? dev.transport : 'usb', info });
  });

  // escolhe o aparelho-alvo (afeta tambem os scripts .ps1 via ANDROID_SERIAL)
  router.any('/api/devices/select', (ctx) => {
    const serial = ctx.q('serial');
    if (serial && !util.isSerial(serial)) return ctx.fail('serial invalido');
    if (serial) {
      const dev = adb.registry.get(serial);
      if (!dev || dev.state !== 'device') return ctx.fail('aparelho nao esta online');
    }
    adb.setTarget(serial);
    adb.registry.emitChange();
    ctx.ok({ selected: adb.getTarget() });
  });

  // renomear o aparelho (apelido do usuario). Nome vazio volta ao original.
  router.any('/api/devices/rename', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');

    const bruto = ctx.method === 'POST' ? ((await ctx.body()).name || '') : ctx.q('name');
    // tira caracteres de controle e limita o tamanho; o resto e livre (o
    // apelido nunca vira caminho de arquivo sem passar pelo safeName)
    const nome = String(bruto).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);

    const dev = adb.registry.get(serial);
    if (!dev) return ctx.fail('aparelho nao encontrado');
    if (!dev.info) return ctx.fail('aguarde a leitura do aparelho terminar e tente de novo');

    if (!adb.registry.setAlias(serial, nome)) return ctx.fail('nao consegui salvar o apelido');
    log.info(`aparelho ${serial} renomeado para "${nome || '(original)'}"`);
    ctx.ok({
      serial,
      alias: nome,
      name: adb.registry.displayName(serial),
      realName: dev.info.name,
    });
  });

  // ------------------------------------------------------------------ wifi --
  // Liga o modo TCP/IP no aparelho e ja conecta pelo IP dele.
  router.any('/api/wifi/enable', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const port = ctx.qInt('port', settings.get('wifi.port', 5555));

    const ip = await adb.ipOf(serial);
    if (!ip) return ctx.fail('o aparelho nao esta numa rede Wi-Fi (sem IP em wlan0)');

    const t = await adb.tcpip(serial, port);
    if (!t.ok) return ctx.fail('falha ao ligar o modo TCP/IP: ' + t.out);

    // o adbd reinicia em modo TCP; da um tempo antes de conectar
    await util.sleep(1400);
    const address = `${ip}:${t.port}`;
    let r = await adb.connect(address);
    if (!r.ok) { await util.sleep(1200); r = await adb.connect(address); }
    if (!r.ok) return ctx.fail('modo TCP/IP ligado, mas a conexao falhou: ' + r.out, 200);

    settings.patch({ wifi: { port: t.port } });
    log.info('Wi-Fi ligado em ' + address);
    ctx.ok({ address, ip, port: t.port, out: r.out });
  });

  // conecta num endereco informado a mao (ip ou ip:porta)
  router.any('/api/wifi/connect', async (ctx) => {
    let address = ctx.q('address').trim();
    if (!/^[\w.:-]{5,64}$/.test(address)) return ctx.fail('endereco invalido');
    if (!/:\d+$/.test(address)) address += ':' + settings.get('wifi.port', 5555);
    const r = await adb.connect(address);
    if (!r.ok) return ctx.fail(r.out || 'nao consegui conectar');
    ctx.ok({ address, out: r.out });
  });

  router.any('/api/wifi/disconnect', async (ctx) => {
    const address = ctx.q('address').trim();
    if (!address) return ctx.fail('endereco invalido');
    const r = await adb.disconnect(address);
    ctx.ok({ out: r.out });
  });

  // volta o aparelho para o modo USB
  router.any('/api/wifi/usb', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const r = await adb.exec(serial, ['usb'], { timeout: 12000 });
    ctx.ok({ out: (r.stdout + r.stderr).trim() });
  });

  // aparelhos conhecidos (reconexao automatica)
  router.get('/api/wifi/known', (ctx) => ctx.json({ ok: true, known: settings.get('known', []) }));

  router.any('/api/wifi/forget', (ctx) => {
    const id = ctx.q('id');
    const known = settings.get('known', []).filter((k) => k.id !== id && k.serial !== id && k.address !== id);
    settings.patch({ known });
    ctx.ok({ known });
  });
}

module.exports = { register };
