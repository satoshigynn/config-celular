// ============================================================================
//  routes/files.cjs - transferencia: instalar APK, enviar, exportar e navegar
// ----------------------------------------------------------------------------
//  Suporta arrastar-e-soltar: o navegador manda o arquivo cru para /upload
//  (gravado em disco em streaming, sem carregar 150 MB na memoria) e depois
//  chama /install ou /push, que transmitem o progresso por SSE.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, util, logs, ensureDir } = require('../core.cjs');
const adb = require('../adb.cjs');
const apks = require('../apks.cjs');

const log = logs.create('rotas:arquivos');
const TMP = path.join(PATHS.base, '.tmp-envios');
const uploads = new Map();   // id -> {id,name,path,size}

ensureDir(TMP);

// limpa envios antigos ao subir (sobras de sessoes anteriores)
try {
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600 * 1000) fs.unlinkSync(p);
  }
} catch (_) { }

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function isSafeDevicePath(p) {
  return typeof p === 'string' && p.startsWith('/') && p.length < 512 && !/[\r\n\0]/.test(p);
}

// APK simples, pasta-bundle (base + splits) ou pacote .apks/.xapk?
async function apkFilesOf(target, say) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    const list = fs.readdirSync(target).filter((f) => /\.apk$/i.test(f)).map((f) => path.join(target, f));
    return { multiple: true, files: list };
  }
  // .apks/.xapk e um ZIP com base + splits: descompacta antes de instalar
  if (apks.ehBundle(target)) {
    const destino = path.join(TMP, 'bundle-' + util.id(6));
    say(`  descompactando ${path.basename(target)}...`);
    const dentro = await apks.extrairBundle(target, destino);
    return { multiple: true, files: dentro, temporario: destino };
  }
  return { multiple: false, files: [target] };
}

async function installOne(serial, target, opts, say) {
  const name = path.basename(target);
  const { multiple, files, temporario } = await apkFilesOf(target, say);
  if (!files.length) { say(`  ${name}: nenhum .apk encontrado`, 'warn'); return false; }

  // pacote de varios arquivos: todos tem que ter o mesmo assinante, e valido
  try {
    if (multiple && files.length > 1) await apks.verificarConjunto(files, say);
  } catch (e) {
    say(`  [!] ${name}: ${e.message}`, 'err');
    if (temporario) fs.rmSync(temporario, { recursive: true, force: true });
    return false;
  }

  const flags = ['-r'];
  if (opts.downgrade !== false) flags.push('-d');
  if (opts.grantAll) flags.push('-g');

  say(`-- ${name}${multiple ? ` (bundle, ${files.length} arquivos)` : ''} --`);
  const r = multiple
    ? await adb.exec(serial, ['install-multiple'].concat(flags, files), { timeout: 600000 })
    : await adb.exec(serial, ['install'].concat(flags, [target]), { timeout: 600000 });

  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\s+/g, ' ').trim();
  const ok = /Success/i.test(out);
  say(ok ? `  [ok] ${name} instalado` : `  [!] ${name}: ${out || 'falhou'}`, ok ? 'ok' : 'err');
  if (temporario) fs.rmSync(temporario, { recursive: true, force: true });
  return ok;
}

function register(router) {
  // --------------------------------------------------------------- upload ---
  router.post('/api/files/upload', (ctx) => new Promise((resolve) => {
    const raw = String(ctx.req.headers['x-file-name'] || 'arquivo');
    const name = path.basename(decodeURIComponent(raw)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'arquivo';
    const id = util.id(8);
    const dest = path.join(TMP, `${id}-${name}`);
    const out = fs.createWriteStream(dest);
    let size = 0;

    ctx.req.on('data', (c) => { size += c.length; });
    ctx.req.on('error', () => { try { out.destroy(); fs.unlinkSync(dest); } catch (_) { } ctx.fail('falha no envio'); resolve(); });
    out.on('error', (e) => { ctx.fail('nao consegui gravar: ' + e.message); resolve(); });
    out.on('finish', () => {
      uploads.set(id, { id, name, path: dest, size });
      log.info(`recebido ${name} (${util.bytesToMB(size)} MB)`);
      ctx.ok({ id, name, sizeMB: util.bytesToMB(size), isApk: /\.(apk|apks|xapk|apkm)$/i.test(name) });
      resolve();
    });
    ctx.req.pipe(out);
  }));

  // instala os arquivos enviados e/ou APKs da pasta local (SSE)
  router.get('/api/files/install', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const es = ctx.sse();
    const say = (l) => es.line(l);
    if (!serial) { say('[!] Nenhum aparelho selecionado.'); return es.done(1); }

    const targets = [];
    for (const id of ctx.q('ids').split(',').filter(Boolean)) {
      const up = uploads.get(id);
      if (up) targets.push(up.path);
    }
    for (const rel of ctx.q('local').split(',').filter(Boolean)) {
      const abs = path.resolve(PATHS.apks, rel);
      if (abs.startsWith(PATHS.apks + path.sep) && fs.existsSync(abs)) targets.push(abs);
    }
    if (!targets.length) { say('[!] Nada para instalar.'); return es.done(1); }

    say(`>> Instalando ${targets.length} pacote(s) em ${serial}...`);
    const opts = { grantAll: ctx.qBool('grantAll') };
    let ok = 0;
    for (const t of targets) {
      if (es.closed) break;
      try { if (await installOne(serial, t, opts, say)) ok++; }
      catch (e) { say('  [!] ' + e.message); }
    }
    say(`>> Concluido: ${ok}/${targets.length} instalado(s).`);
    es.done(ok === targets.length ? 0 : 1);
  });

  // envia arquivos quaisquer para uma pasta do aparelho (SSE)
  router.get('/api/files/push', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const dest = ctx.q('dest') || '/sdcard/Download';
    const es = ctx.sse();
    if (!serial) { es.line('[!] Nenhum aparelho selecionado.'); return es.done(1); }
    if (!isSafeDevicePath(dest)) { es.line('[!] Pasta de destino invalida.'); return es.done(1); }

    const items = ctx.q('ids').split(',').filter(Boolean).map((id) => uploads.get(id)).filter(Boolean);
    if (!items.length) { es.line('[!] Nada para enviar.'); return es.done(1); }

    es.line(`>> Enviando ${items.length} arquivo(s) para ${dest}...`);
    await adb.shell(serial, `mkdir -p ${shq(dest)}`);
    let ok = 0;
    for (const it of items) {
      if (es.closed) break;
      es.line(`-- ${it.name} (${util.bytesToMB(it.size)} MB) --`);
      const r = await adb.push(serial, it.path, dest.replace(/\/$/, '') + '/' + it.name);
      if (r.ok) { ok++; es.line('  [ok] enviado'); }
      else es.line('  [!] ' + r.out);
    }
    // avisa a galeria/indexador do Android sobre os arquivos novos
    await adb.shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${dest} >/dev/null 2>&1`);
    es.line(`>> Concluido: ${ok}/${items.length} enviado(s).`);
    es.done(ok === items.length ? 0 : 1);
  });

  // -------------------------------------------------------- navegar no device
  router.get('/api/files/ls', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const dir = ctx.q('path') || '/sdcard';
    if (!isSafeDevicePath(dir)) return ctx.fail('caminho invalido');

    // a barra final e essencial: /sdcard e um symlink e sem ela o ls lista o
    // proprio link em vez do conteudo da pasta
    const { all } = await adb.shell(serial, `ls -la ${shq(dir.replace(/\/+$/, '') + '/')} 2>&1`, { timeout: 20000 });
    if (/No such file|Permission denied|not found/i.test(all) && !/total/i.test(all)) {
      return ctx.fail(all.split(/\r?\n/)[0] || 'nao consegui listar');
    }
    const entries = [];
    all.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([dlbcps-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/);
      if (!m) return;
      let name = m[5].trim();
      if (name === '.' || name === '..') return;
      let link = '';
      if (m[1] === 'l') { const parts = name.split(' -> '); name = parts[0]; link = parts[1] || ''; }
      entries.push({
        name,
        type: m[1] === 'd' ? 'dir' : m[1] === 'l' ? 'link' : 'file',
        size: Number(m[3]) || 0,
        modified: m[4],
        link,
      });
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    ctx.json({ ok: true, path: dir, entries });
  });

  // exporta (pull) arquivos do aparelho para o PC (SSE)
  router.get('/api/files/pull', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const es = ctx.sse();
    if (!serial) { es.line('[!] Nenhum aparelho selecionado.'); return es.done(1); }

    const items = ctx.q('paths').split('|').filter(Boolean);
    if (!items.length) { es.line('[!] Nada selecionado.'); return es.done(1); }

    const outDir = path.join(ctx.q('dir') || path.join(PATHS.capturas, 'exportados'));
    if (!ensureDir(outDir)) { es.line('[!] Nao consegui criar a pasta de destino.'); return es.done(1); }

    es.line(`>> Exportando ${items.length} item(ns) para ${outDir}...`);
    let ok = 0;
    for (const remote of items) {
      if (es.closed) break;
      if (!isSafeDevicePath(remote)) { es.line('  [!] caminho invalido: ' + remote); continue; }
      const name = remote.split('/').filter(Boolean).pop() || 'arquivo';
      es.line(`-- ${name} --`);
      const r = await adb.pull(serial, remote, path.join(outDir, name));
      if (r.ok) { ok++; es.line('  [ok] ' + name); }
      else es.line('  [!] ' + r.out);
    }
    es.line(`>> Concluido: ${ok}/${items.length} exportado(s) em ${outDir}`);
    es.done(ok === items.length ? 0 : 1);
  });

  // APKs disponiveis na pasta local do programa
  router.get('/api/files/apks', (ctx) => {
    let items = [];
    try {
      items = fs.readdirSync(PATHS.apks, { withFileTypes: true })
        .filter((d) => (d.isFile() && /\.apk$/i.test(d.name)) || (d.isDirectory() && /bundle$/i.test(d.name)))
        .map((d) => {
          const abs = path.join(PATHS.apks, d.name);
          let size = 0;
          try {
            size = d.isDirectory()
              ? fs.readdirSync(abs).reduce((s, f) => s + (fs.statSync(path.join(abs, f)).size || 0), 0)
              : fs.statSync(abs).size;
          } catch (_) { }
          return { name: d.name, bundle: d.isDirectory(), sizeMB: Number(util.bytesToMB(size)) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { }
    ctx.json({ ok: true, dir: PATHS.apks, items });
  });

  router.get('/api/files/uploads', (ctx) => {
    ctx.json({
      ok: true,
      items: [...uploads.values()].map((u) => ({ id: u.id, name: u.name, sizeMB: util.bytesToMB(u.size), isApk: /\.(apk|apks|xapk|apkm)$/i.test(u.name) })),
    });
  });

  router.any('/api/files/discard', (ctx) => {
    const id = ctx.q('id');
    const up = uploads.get(id);
    if (up) { try { fs.unlinkSync(up.path); } catch (_) { } uploads.delete(id); }
    ctx.ok({});
  });
}

module.exports = { register };
