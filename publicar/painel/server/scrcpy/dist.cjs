// ============================================================================
//  scrcpy/dist.cjs - localiza a distribuicao do scrcpy e prepara o servidor
// ----------------------------------------------------------------------------
//  O scrcpy tem duas metades:
//    * scrcpy-server  -> um .jar que RODA DENTRO DO CELULAR (app_process).
//                        E com ele que a engine embutida fala (video + controle).
//    * scrcpy.exe     -> o cliente nativo. Usado so onde ele e melhor:
//                        gravacao com audio e janela nativa em tela cheia.
//
//  A versao do cliente PRECISA bater exatamente com a do .jar (o servidor
//  recusa a conexao com "does not match the client"), por isso a versao e
//  detectada e nunca chutada.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, run, logs, util } = require('../core.cjs');
const adb = require('../adb.cjs');

const log = logs.create('scrcpy:dist');
const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';

let cached = null;
const pushed = new Map();   // serial -> assinatura do jar ja enviado

function candidateDirs() {
  const dirs = [PATHS.scrcpy];   // bundle do proprio programa (prioridade)

  // instalacao por WinGet
  const wingetRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!/scrcpy/i.test(entry)) continue;
      const pkgDir = path.join(wingetRoot, entry);
      dirs.push(pkgDir);
      try {
        for (const sub of fs.readdirSync(pkgDir)) {
          if (/^scrcpy/i.test(sub)) dirs.push(path.join(pkgDir, sub));
        }
      } catch (_) { }
    }
  } catch (_) { }

  // instalacoes manuais comuns
  const home = process.env.USERPROFILE || '';
  ['scrcpy', 'Desktop\\scrcpy', 'Downloads\\scrcpy'].forEach((p) => dirs.push(path.join(home, p)));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'scrcpy'));
  if (process.env.SCRCPY_HOME) dirs.unshift(process.env.SCRCPY_HOME);

  return dirs;
}

function inspectDir(dir) {
  try {
    const exe = path.join(dir, 'scrcpy.exe');
    const jar = path.join(dir, 'scrcpy-server');
    const hasExe = fs.existsSync(exe);
    const hasJar = fs.existsSync(jar);
    if (!hasExe && !hasJar) return null;
    return { dir, exe: hasExe ? exe : '', jar: hasJar ? jar : '' };
  } catch (_) { return null; }
}

// Descobre a versao: version.txt (gravado pelo bundle) ou 'scrcpy.exe --version'.
async function detectVersion(found) {
  const vf = path.join(found.dir, 'version.txt');
  try {
    const v = fs.readFileSync(vf, 'utf8').trim();
    if (/^\d+\.\d+(\.\d+)?$/.test(v)) return v;
  } catch (_) { }
  if (found.exe) {
    const r = await run(found.exe, ['--version'], { timeout: 12000 });
    const m = (r.stdout + r.stderr).match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/i);
    if (m) {
      try { fs.writeFileSync(vf, m[1], 'utf8'); } catch (_) { }
      return m[1];
    }
  }
  return '';
}

// Resolve a distribuicao uma vez e guarda em cache.
async function resolve(force) {
  if (cached && !force) return cached;
  for (const dir of candidateDirs()) {
    const found = inspectDir(dir);
    if (!found) continue;
    const version = await detectVersion(found);
    if (!version) continue;
    let jarStat = null;
    try { jarStat = fs.statSync(found.jar); } catch (_) { }
    cached = {
      dir: found.dir,
      exe: found.exe,
      jar: found.jar,
      version,
      jarSig: jarStat ? `${jarStat.size}-${Math.round(jarStat.mtimeMs)}` : '',
      bundled: path.resolve(found.dir) === path.resolve(PATHS.scrcpy),
    };
    log.info(`scrcpy ${version} em ${found.dir}${cached.bundled ? ' (embutido)' : ''}`);
    return cached;
  }
  cached = null;
  return null;
}

function status() {
  return cached
    ? { ok: true, version: cached.version, dir: cached.dir, bundled: cached.bundled, hasExe: !!cached.exe, hasServer: !!cached.jar }
    : { ok: false, err: 'scrcpy nao encontrado' };
}

// Envia o .jar para o aparelho (uma vez por sessao/serial - o push e caro).
async function ensureServer(serial) {
  const dist = await resolve();
  if (!dist) throw new Error('scrcpy nao encontrado. Coloque a pasta do scrcpy em ' + PATHS.scrcpy);
  if (!dist.jar) throw new Error('arquivo scrcpy-server ausente em ' + dist.dir);

  const sig = dist.jarSig + '|' + dist.version;
  if (pushed.get(serial) === sig) return dist;

  const r = await adb.push(serial, dist.jar, DEVICE_JAR);
  if (!r.ok) throw new Error('nao consegui enviar o scrcpy-server ao aparelho: ' + r.out);
  pushed.set(serial, sig);
  log.info(`scrcpy-server enviado para ${serial}`);
  return dist;
}

function forgetDevice(serial) { pushed.delete(serial); }

// Lista os encoders de video/audio disponiveis no aparelho (usa o proprio jar).
async function listEncoders(serial) {
  const dist = await ensureServer(serial);
  const r = await adb.exec(serial, [
    'shell', `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
    dist.version, 'list_encoders=true', 'log_level=info', 'cleanup=false',
  ], { timeout: 25000 });
  const out = r.stdout + r.stderr;
  const video = [], audio = [];
  out.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*-{2}\s*\[(\w+)\]\s*encoder:\s*'([^']+)'/i) || l.match(/--\s+\[(\w+)\]\s+encoder:\s+'([^']+)'/i);
    if (!m) return;
    (m[1].toLowerCase() === 'audio' ? audio : video).push({ codec: m[1].toLowerCase(), name: m[2] });
  });
  return { video, audio, raw: out };
}

module.exports = { resolve, status, ensureServer, forgetDevice, listEncoders, DEVICE_JAR };
