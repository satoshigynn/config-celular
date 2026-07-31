// ============================================================================
//  routes/capture.cjs - print, gravacao de video/audio e pasta de destino
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, settings, util, run, logs, ensureDir } = require('../core.cjs');
const adb = require('../adb.cjs');
const native = require('../scrcpy/native.cjs');

const log = logs.create('rotas:captura');
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function isPng(buf) { return buf.length > 8 && PNG_SIG.every((b, i) => buf[i] === b); }

function dirOf() {
  const dir = settings.get('capture.dir', PATHS.capturas) || PATHS.capturas;
  ensureDir(dir);
  return dir;
}

async function grabPng(serial) {
  const r = await adb.execBuffer(serial, ['exec-out', 'screencap', '-p'], { timeout: 30000 });
  if (isPng(r.stdout)) return { ok: true, buffer: r.stdout };
  return { ok: false, err: (r.stderr || '').trim() || 'nao consegui capturar (o celular esta desbloqueado?)' };
}

function register(router) {
  // ------------------------------------------------------------- screenshot -
  // ?inline=1 devolve a imagem (usado pelo espelho de fallback);
  // caso contrario grava na pasta de capturas e devolve os metadados.
  router.any('/api/capture/screenshot', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const shot = await grabPng(serial);
    if (!shot.ok) return ctx.fail(shot.err);

    if (ctx.qBool('inline')) {
      return ctx.send(200, 'image/png', shot.buffer, { 'Cache-Control': 'no-store' });
    }
    // usa o apelido dado pelo usuario quando existir
    const base = util.safeName(adb.registry.displayName(serial), 'tela');
    const file = path.join(dirOf(), `${base}-${util.timestamp()}.png`);
    try { fs.writeFileSync(file, shot.buffer); }
    catch (e) { return ctx.fail('nao consegui gravar o arquivo: ' + e.message); }
    log.info('print salvo em ' + file);
    ctx.ok({ file, name: path.basename(file), sizeMB: util.bytesToMB(shot.buffer.length), dir: dirOf() });
  });

  // --------------------------------------------------------------- gravacao -
  router.any('/api/capture/record/start', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const rec = await native.startRecording(serial, {
      format: ctx.q('format') || settings.get('capture.videoFormat', 'mkv'),
      audio: ctx.q('audio') !== '0',
      audioOnly: ctx.qBool('audioOnly'),
      audioSource: ctx.q('audioSource') || 'output',
      audioCodec: ctx.q('audioCodec'),
      preview: ctx.qBool('preview'),
      maxSize: ctx.qInt('maxSize', settings.get('mirror.maxSize', 1280)),
      bitrate: ctx.qInt('bitrate', settings.get('mirror.bitrate', 8000000)),
      maxFps: ctx.qInt('maxFps', settings.get('mirror.maxFps', 60)),
      timeLimit: ctx.qInt('timeLimit', 0),
      name: ctx.q('name') || adb.registry.displayName(serial),
    });
    ctx.ok({ record: rec });
  });

  router.any('/api/capture/record/stop', async (ctx) => {
    const r = await native.stop(ctx.q('id'));
    if (!r.ok) return ctx.fail(r.err || 'nao consegui parar');
    await util.sleep(400);
    ctx.ok({ record: native.get(ctx.q('id')) });
  });

  router.get('/api/capture/record/list', (ctx) => {
    ctx.json({ ok: true, processes: native.list() });
  });

  // ------------------------------------------------------------------ pasta -
  router.get('/api/capture/files', (ctx) => {
    const dir = dirOf();
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(png|jpg|mp4|mkv|opus|m4a|h264)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, sizeMB: Number(util.bytesToMB(st.size)), at: st.mtimeMs };
        })
        .sort((a, b) => b.at - a.at)
        .slice(0, 100);
    } catch (_) { }
    ctx.json({ ok: true, dir, files });
  });

  router.any('/api/capture/open', async (ctx) => {
    const name = ctx.q('name');
    const dir = dirOf();
    let target = dir;
    if (name) {
      const abs = path.resolve(dir, name);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) return ctx.fail('caminho invalido');
      if (fs.existsSync(abs)) target = abs;
    }
    await run('explorer.exe', [target], { timeout: 6000 });
    ctx.ok({ target });
  });

  // Dialogo NATIVO do Windows para escolher a pasta (o navegador nao sabe
  // devolver um caminho real, mas o servidor roda no PC do usuario).
  router.any('/api/capture/choose-folder', async (ctx) => {
    const current = dirOf().replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = 'Escolha a pasta onde salvar prints e gravacoes'",
      `$d.SelectedPath = '${current}'`,
      '$d.ShowNewFolderButton = $true',
      "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ Write-Output $d.SelectedPath }",
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 180000 });
    const picked = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (!picked) return ctx.ok({ cancelled: true, dir: dirOf() });
    try { ensureDir(picked); } catch (_) { return ctx.fail('pasta invalida'); }
    settings.patch({ capture: { dir: picked } });
    log.info('pasta de capturas: ' + picked);
    ctx.ok({ dir: picked });
  });

  router.any('/api/capture/set-folder', (ctx) => {
    const dir = ctx.q('dir');
    if (!dir || !/^[A-Za-z]:\\/.test(dir)) return ctx.fail('informe um caminho completo (ex: D:\\Capturas)');
    if (!ensureDir(dir)) return ctx.fail('nao consegui criar/acessar a pasta');
    settings.patch({ capture: { dir } });
    ctx.ok({ dir });
  });
}

module.exports = { register, grabPng, dirOf };
