// ============================================================================
//  routes/apks.cjs - manter a pasta apks\ atualizada
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const { PATHS, settings, util, logs } = require('../core.cjs');
const apks = require('../apks.cjs');

const log = logs.create('rotas:apks');

function register(router) {
  // estado de cada APK: fonte, se entra no automatico, tamanho, versao, data
  router.get('/api/apks/status', (ctx) => ctx.json(apks.estado()));

  // atualiza tudo (ou so os ids pedidos), transmitindo o log por SSE
  router.get('/api/apks/update', async (ctx) => {
    const es = ctx.sse();
    const somente = ctx.q('ids').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const r = await apks.atualizar((l) => es.line(l), somente);
      es.done(r && r.falhas && r.falhas.length ? 1 : 0);
    } catch (e) {
      es.line('[!] ' + e.message);
      es.done(1);
    }
  });

  // liga/desliga um app da atualizacao automatica
  router.any('/api/apks/auto', (ctx) => {
    const id = ctx.q('id');
    const ligado = ctx.q('on') !== '0';
    if (!apks.definirAuto(id, ligado)) return ctx.fail('app nao encontrado: ' + id);
    ctx.ok({ id, auto: ligado });
  });

  // preferencias do agendador
  router.any('/api/apks/schedule', (ctx) => {
    const patch = {};
    if (ctx.query.has('on')) patch.autoAtualizar = ctx.q('on') !== '0';
    if (ctx.query.has('horas')) {
      const h = Math.max(1, Math.min(720, ctx.qInt('horas', 24)));
      patch.intervaloHoras = h;
    }
    if (Object.keys(patch).length) {
      settings.patch({ apks: patch });
      apks.iniciarAgendador();
      log.info('agendamento de APKs: ' + JSON.stringify(patch));
    }
    ctx.ok({
      autoAtualizar: !!settings.get('apks.autoAtualizar', false),
      intervaloHoras: Number(settings.get('apks.intervaloHoras', 24)) || 24,
      ultimaAtualizacao: Number(settings.get('apks.ultimaAtualizacao', 0)) || 0,
    });
  });

  // liga/desliga a exigencia de assinatura igual
  router.any('/api/apks/verify-toggle', (ctx) => {
    const cfg = apks.lerFontes();
    cfg.verificarAssinatura = ctx.q('on') !== '0';
    apks.salvarFontes(cfg);
    log.info('verificacao de assinatura: ' + (cfg.verificarAssinatura ? 'ligada' : 'DESLIGADA'));
    ctx.ok({ verificarAssinatura: cfg.verificarAssinatura });
  });

  // le o certificado de assinatura de um APK da pasta (para conferencia manual)
  router.get('/api/apks/cert', async (ctx) => {
    const rel = ctx.q('arquivo');
    if (!rel || !/^[A-Za-z0-9_.\- ]+$/.test(rel)) return ctx.fail('arquivo invalido');
    let alvo = path.resolve(PATHS.apks, rel);
    if (!alvo.startsWith(path.resolve(PATHS.apks) + path.sep)) return ctx.fail('caminho invalido');

    // bundle: usa o base.apk de dentro da pasta
    try {
      if (fs.statSync(alvo).isDirectory()) {
        const arquivos = fs.readdirSync(alvo).filter((f) => /\.apk$/i.test(f));
        const base = arquivos.find((f) => /base\.apk$/i.test(f)) || arquivos[0];
        if (!base) return ctx.fail('a pasta nao tem APK dentro');
        alvo = path.join(alvo, base);
      }
    } catch (_) { return ctx.fail('arquivo nao encontrado'); }

    const r = await apks.certificadoDe(alvo);
    if (!r.ok) return ctx.fail(r.err);
    ctx.ok({ arquivo: rel, sha256: r.sha256 });
  });
}

module.exports = { register };
