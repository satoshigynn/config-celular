// ============================================================================
//  routes/system.cjs - versao, atualizacao online, preferencias, logs e limpeza
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { PATHS, settings, util, logs, run } = require('../core.cjs');
const dist = require('../scrcpy/dist.cjs');

const log = logs.create('rotas:sistema');

// Impressao digital do codigo do servidor no momento em que ele subiu. Se algo
// mudar no disco (uma atualizacao foi baixada), avisamos que precisa reiniciar.
const BOOT_HASH = (function () {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(cjs|js|html|css)$/i.test(e.name)) files.push(p);
    }
  };
  walk(PATHS.painel);
  files.sort();
  const parts = files.map((f) => { try { return f + ':' + util.sha256(fs.readFileSync(f)); } catch (_) { return f + ':?'; } });
  return util.sha256(Buffer.from(parts.join('\n')));
})();

function currentHash() {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(cjs|js|html|css)$/i.test(e.name)) files.push(p);
    }
  };
  walk(PATHS.painel);
  files.sort();
  const parts = files.map((f) => { try { return f + ':' + util.sha256(fs.readFileSync(f)); } catch (_) { return f + ':?'; } });
  return util.sha256(Buffer.from(parts.join('\n')));
}

// ------------------------------------------------------------- download ----
function httpGetBuffer(url, cb, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) return cb(new Error('muitos redirecionamentos'));
  let lib;
  try { lib = url.toLowerCase().startsWith('https:') ? https : http; } catch (e) { return cb(e); }
  // Sem estes cabecalhos, o raw.githubusercontent entrega a resposta guardada
  // na borda por alguns minutos. Na pratica: minutos depois de publicar, o
  // painel ainda anunciava a contagem e as notas ANTIGAS, e clicar em
  // "Verificar" repetia a mesma resposta velha - parecia que a publicacao nao
  // tinha acontecido. Pedir explicitamente conteudo fresco resolve, e nao
  // atrapalha o download dos arquivos (cada um e conferido por sha256 depois).
  const req = lib.get(url, {
    headers: {
      'User-Agent': 'ConfigCelular-Updater',
      'Cache-Control': 'no-cache, max-age=0',
      'Pragma': 'no-cache',
    },
  }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      let next;
      try { next = new URL(r.headers.location, url).toString(); } catch (e) { return cb(e); }
      return httpGetBuffer(next, cb, redirects + 1);
    }
    if (r.statusCode !== 200) { r.resume(); return cb(new Error('HTTP ' + r.statusCode)); }
    const chunks = [];
    r.on('data', (d) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  req.on('error', cb);
  req.setTimeout(30000, () => req.destroy(new Error('tempo esgotado')));
}
const getBuffer = (url) => new Promise((res, rej) => httpGetBuffer(url, (e, b) => (e ? rej(e) : res(b))));

function readBaseUrl() {
  try {
    const c = JSON.parse(util.stripBom(fs.readFileSync(PATHS.updateCfg, 'utf8')));
    return (c.baseUrl || '').trim().replace(/\/+$/, '');
  } catch (_) { return ''; }
}
const baseConfigurado = (b) => !!b && !/SEU-|USUARIO|EXEMPLO|coloque/i.test(b);
function versaoLocal() {
  try { return (fs.readFileSync(PATHS.versaoLocal, 'utf8').trim()) || '0'; } catch (_) { return '0'; }
}

// So aceita arquivos-texto do programa, sempre dentro da pasta base.
function caminhoSeguro(rel) {
  if (typeof rel !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(rel) || rel.includes('..')) return null;
  if (!/\.(ps1|cjs|js|mjs|html|css|json|txt|bat|md)$/i.test(rel)) return null;
  const abs = path.resolve(PATHS.base, rel);
  if (!abs.startsWith(path.resolve(PATHS.base) + path.sep)) return null;
  return abs;
}

// ------------------------------------------------------------- manutencao --
function dirSize(dir) {
  let total = 0, count = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; count++; } catch (_) { } }
    }
  };
  walk(dir);
  return { bytes: total, count };
}

function scanMaintenance() {
  const items = [];

  // sobras de extracao interrompida (.part)
  try {
    for (const f of fs.readdirSync(PATHS.apks)) {
      if (!/\.part$/i.test(f)) continue;
      const p = path.join(PATHS.apks, f);
      items.push({ id: 'part:' + f, kind: 'arquivo', path: p, label: `apks/${f}`, sizeMB: Number(util.bytesToMB(fs.statSync(p).size)), hint: 'sobra de uma extracao interrompida' });
    }
  } catch (_) { }

  // logs antigos por aparelho (mantem os 10 mais novos)
  try {
    const files = fs.readdirSync(PATHS.logs)
      .filter((f) => /^.+_\d{4}-\d{2}-\d{2}T.+\.txt$/.test(f))
      .map((f) => ({ f, p: path.join(PATHS.logs, f), at: fs.statSync(path.join(PATHS.logs, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const old = files.slice(10);
    if (old.length) {
      items.push({
        id: 'logs-antigos', kind: 'grupo', paths: old.map((o) => o.p),
        label: `${old.length} log(s) de execucao antigos`,
        sizeMB: Number(util.bytesToMB(old.reduce((s, o) => s + fs.statSync(o.p).size, 0))),
        hint: 'os 10 mais recentes sao mantidos',
      });
    }
  } catch (_) { }

  // arquivos temporarios de envio
  const tmp = path.join(PATHS.base, '.tmp-envios');
  if (fs.existsSync(tmp)) {
    const s = dirSize(tmp);
    if (s.count) items.push({ id: 'tmp-envios', kind: 'pasta', path: tmp, label: 'arquivos temporarios de envio', sizeMB: Number(util.bytesToMB(s.bytes)), hint: `${s.count} arquivo(s)` });
  }

  // APKs desativados
  const desativados = path.join(PATHS.base, 'apks-desativados');
  if (fs.existsSync(desativados)) {
    const s = dirSize(desativados);
    if (s.count) items.push({ id: 'apks-desativados', kind: 'pasta', path: desativados, label: 'pasta apks-desativados', sizeMB: Number(util.bytesToMB(s.bytes)), hint: `${s.count} APK(s) fora de uso - so remova se tiver certeza` });
  }

  return items.sort((a, b) => b.sizeMB - a.sizeMB);
}

function register(router) {
  // ------------------------------------------------------------- versao ----
  router.get('/api/version', (ctx) => {
    ctx.json({ versao: versaoLocal(), stale: currentHash() !== BOOT_HASH });
  });

  router.get('/api/system/info', async (ctx) => {
    await dist.resolve();
    ctx.json({
      ok: true,
      versao: versaoLocal(),
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      base: PATHS.base,
      scrcpy: dist.status(),
      stale: currentHash() !== BOOT_HASH,
    });
  });

  // ---------------------------------------------------------- preferencias -
  router.get('/api/settings', (ctx) => ctx.json({ ok: true, settings: settings.all(), defaults: settings.defaults }));

  router.post('/api/settings', async (ctx) => {
    const patch = await ctx.body();
    delete patch.known;   // a lista de conhecidos e gerenciada pelo registro
    ctx.json({ ok: true, settings: settings.patch(patch) });
  });

  router.any('/api/settings/reset', (ctx) => {
    const keep = settings.get('known', []);
    try { fs.unlinkSync(PATHS.settings); } catch (_) { }
    settings.patch(Object.assign({}, settings.defaults, { known: keep }));
    ctx.json({ ok: true, settings: settings.all() });
  });

  // ---------------------------------------------------------------- logs ---
  router.get('/api/logs', (ctx) => ctx.json({ ok: true, entries: logs.recent(ctx.qInt('n', 250)) }));

  router.any('/api/logs/open', async (ctx) => {
    await run('explorer.exe', [PATHS.appLogs], { timeout: 6000 });
    ctx.json({ ok: true, dir: PATHS.appLogs });
  });

  // ---------------------------------------------------------- manutencao ---
  router.get('/api/maintenance/scan', (ctx) => {
    const items = scanMaintenance();
    ctx.json({ ok: true, items, totalMB: Number(items.reduce((s, i) => s + i.sizeMB, 0).toFixed(1)) });
  });

  router.any('/api/maintenance/clean', async (ctx) => {
    const wanted = new Set(ctx.q('ids').split(',').filter(Boolean));
    if (!wanted.size) return ctx.fail('nada selecionado');
    const items = scanMaintenance().filter((i) => wanted.has(i.id));
    let freed = 0;
    const removed = [];
    for (const it of items) {
      const targets = it.paths || [it.path];
      for (const p of targets) {
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) { freed += dirSize(p).bytes; fs.rmSync(p, { recursive: true, force: true }); }
          else { freed += st.size; fs.unlinkSync(p); }
          removed.push(p);
        } catch (e) { log.warn('nao removeu ' + p, e.message); }
      }
    }
    log.info(`limpeza: ${removed.length} item(ns), ${util.bytesToMB(freed)} MB`);
    ctx.json({ ok: true, removed: removed.length, freedMB: util.bytesToMB(freed) });
  });

  // ==================================================== atualizacao online ==
  router.get('/api/update-check', async (ctx) => {
    const base = readBaseUrl();
    if (!baseConfigurado(base)) return ctx.json({ configured: false });
    let man;
    try { man = JSON.parse(util.stripBom((await getBuffer(base + '/versao.json')).toString('utf8'))); }
    catch (e) { return ctx.json({ configured: true, ok: false, err: e.message }); }

    const arquivos = Array.isArray(man.arquivos) ? man.arquivos : [];
    const pendentes = [];
    for (const a of arquivos) {
      const abs = caminhoSeguro(a.caminho || '');
      if (!abs) continue;
      let h = '';
      try { h = util.sha256(fs.readFileSync(abs)); } catch (_) { }
      if (h.toLowerCase() !== String(a.sha256 || '').toLowerCase()) pendentes.push(a.caminho);
    }
    ctx.json({
      configured: true, ok: true, versaoLocal: versaoLocal(),
      versaoRemota: man.versao || '?', notas: man.notas || '', pendentes, total: pendentes.length,
    });
  });

  router.get('/api/update-run', async (ctx) => {
    const es = ctx.sse();
    const base = readBaseUrl();
    if (!baseConfigurado(base)) { es.line('[!] Atualizacao online nao configurada (update.json).'); return es.done(1); }

    es.line('>> Verificando atualizacoes...');
    let man;
    try { man = JSON.parse(util.stripBom((await getBuffer(base + '/versao.json')).toString('utf8'))); }
    catch (e) { es.line('[!] Nao consegui buscar o manifesto: ' + e.message); return es.done(1); }

    const alvos = [];
    for (const a of (Array.isArray(man.arquivos) ? man.arquivos : [])) {
      const abs = caminhoSeguro(a.caminho || '');
      if (!abs) { es.line('[--] ignorado (caminho invalido): ' + (a.caminho || '')); continue; }
      let h = '';
      try { h = util.sha256(fs.readFileSync(abs)); } catch (_) { }
      if (h.toLowerCase() !== String(a.sha256 || '').toLowerCase()) {
        alvos.push({ rel: a.caminho, abs, sha: String(a.sha256 || '').toLowerCase() });
      }
    }
    if (!alvos.length) {
      try {
        const vr = String(man.versao || '').trim();
        if (vr && vr !== versaoLocal()) fs.writeFileSync(PATHS.versaoLocal, vr + '\n', 'utf8');
      } catch (_) { }
      es.line(`>> Ja esta na versao mais recente (${man.versao || '?'}). Nada a baixar.`);
      return es.done(0);
    }

    es.line(`>> Baixando ${alvos.length} arquivo(s)...`);
    for (const a of alvos) {
      if (es.closed) return;
      let data;
      try { data = await getBuffer(base + '/' + a.rel); }
      catch (e) { es.line(`[!] Falha ao baixar ${a.rel}: ${e.message}`); return es.done(1); }
      if (a.sha && util.sha256(data).toLowerCase() !== a.sha) {
        es.line(`[!] ${a.rel}: verificacao (hash) falhou. Abortado por seguranca.`);
        return es.done(1);
      }
      try {
        fs.mkdirSync(path.dirname(a.abs), { recursive: true });
        fs.writeFileSync(a.abs, data);
        es.line('[ok] ' + a.rel);
      } catch (e) { es.line(`[!] Nao consegui gravar ${a.rel}: ${e.message}`); return es.done(1); }
    }
    try { fs.writeFileSync(PATHS.versaoLocal, String(man.versao || '').trim() + '\n', 'utf8'); } catch (_) { }
    es.line(`>> Atualizado para a versao ${man.versao || '?'}.`);
    es.line('>> IMPORTANTE: FECHE e ABRA o painel de novo para aplicar.');
    es.done(0);
  });

  // APKs curados da nuvem
  router.get('/api/update-apks-cloud', async (ctx) => {
    const es = ctx.sse();
    const base = readBaseUrl();
    if (!baseConfigurado(base)) { es.line('[!] Atualizacao nao configurada (update.json).'); return es.done(1); }

    es.line('>> Verificando APKs na nuvem...');
    let man;
    try { man = JSON.parse(util.stripBom((await getBuffer(base + '/apks.json')).toString('utf8'))); }
    catch (e) { es.line('[!] Nenhum catalogo de APKs publicado ainda (apks.json): ' + e.message); return es.done(1); }

    const alvos = [];
    for (const a of (Array.isArray(man.apks) ? man.apks : [])) {
      if (!/^[A-Za-z0-9_.-]+\.apk$/i.test(a.arquivo || '')) continue;
      let h = '';
      try { h = util.sha256(fs.readFileSync(path.join(PATHS.apks, a.arquivo))); } catch (_) { }
      if (h.toLowerCase() !== String(a.sha256 || '').toLowerCase()) alvos.push(a);
    }
    if (!alvos.length) { es.line('>> APKs ja estao na versao mais recente. Nada a baixar.'); return es.done(0); }

    es.line(`>> Baixando ${alvos.length} APK(s) atualizado(s)...`);
    try { fs.mkdirSync(PATHS.apks, { recursive: true }); } catch (_) { }
    for (const a of alvos) {
      if (es.closed) return;
      es.line(`  baixando ${a.arquivo} (v${a.versionName || '?'})...`);
      let data;
      try { data = await getBuffer(a.url); }
      catch (e) { es.line(`[!] Falha ao baixar ${a.arquivo}: ${e.message}`); return es.done(1); }
      if (!(data.length > 4 && data[0] === 0x50 && data[1] === 0x4b)) {
        es.line(`[!] ${a.arquivo}: nao parece um APK (ZIP). Abortado.`);
        return es.done(1);
      }
      if (a.sha256 && util.sha256(data).toLowerCase() !== String(a.sha256).toLowerCase()) {
        es.line(`[!] ${a.arquivo}: verificacao (hash) falhou. Abortado.`);
        return es.done(1);
      }
      try { fs.writeFileSync(path.join(PATHS.apks, a.arquivo), data); es.line('  [ok] ' + a.arquivo); }
      catch (e) { es.line(`[!] Nao gravou ${a.arquivo}: ${e.message}`); return es.done(1); }
    }
    es.line('>> APKs atualizados com sucesso.');
    es.done(0);
  });
}

module.exports = { register };
