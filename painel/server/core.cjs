// ============================================================================
//  core.cjs - fundacao do servidor: caminhos, logger, preferencias e processos
// ----------------------------------------------------------------------------
//  Tudo que os outros modulos precisam para saber ONDE as coisas estao e COMO
//  rodar um processo externo. Sem dependencias externas (roda no node.exe
//  embutido do programa).
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- caminhos --
const PAINEL = path.resolve(__dirname, '..');          // ...\Config Celular\painel
const BASE = path.resolve(PAINEL, '..');               // ...\Config Celular

const PATHS = {
  base: BASE,
  painel: PAINEL,
  app: path.join(PAINEL, 'app'),
  apks: path.join(BASE, 'apks'),
  logs: path.join(BASE, 'logs'),
  appLogs: path.join(BASE, 'logs', '_painel'),
  capturas: path.join(BASE, 'capturas'),
  platformTools: path.join(BASE, 'platform-tools'),
  scrcpy: path.join(BASE, 'scrcpy'),
  config: path.join(BASE, 'config.json'),
  catalog: path.join(BASE, 'apps-catalog.json'),
  updateCfg: path.join(BASE, 'update.json'),
  versaoLocal: path.join(BASE, 'versao-local.txt'),
  settings: path.join(BASE, 'painel-settings.json'),
  scripts: {
    setup: path.join(BASE, 'setup-celular.ps1'),
    updater: path.join(BASE, 'atualizar-apks.ps1'),
    restore: path.join(BASE, 'restaurar.ps1'),
    manage: path.join(BASE, 'gerenciar-app.ps1'),
    extract: path.join(BASE, 'extrair-apk.ps1'),
    // clones-cloneapp.ps1 nao e mais usado: o "Clone App" saiu do painel.
    // O arquivo continua na pasta, mas nenhuma rota o chama.
  },
};

// ADB: prefere o platform-tools embutido (portavel); senao o do USERPROFILE.
const ADB = (function () {
  const bundled = path.join(PATHS.platformTools, 'adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  const scrcpyAdb = path.join(PATHS.scrcpy, 'adb.exe');
  if (fs.existsSync(scrcpyAdb)) return scrcpyAdb;
  return path.join(process.env.USERPROFILE || '', 'platform-tools', 'adb.exe');
})();

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; }
}

// ------------------------------------------------------------------ logger --
// Niveis: debug < info < warn < error. Grava um arquivo por dia em logs\_painel
// e mantem um buffer em memoria que o painel consegue ler pela API.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ring = [];
const RING_MAX = 800;
let logStream = null;
let logStreamDay = '';
const listeners = new Set();

function openLogStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (logStream && logStreamDay === day) return logStream;
  try {
    ensureDir(PATHS.appLogs);
    if (logStream) logStream.end();
    logStreamDay = day;
    logStream = fs.createWriteStream(path.join(PATHS.appLogs, `painel-${day}.log`), { flags: 'a' });
  } catch (_) { logStream = null; }
  return logStream;
}

function write(level, scope, msg, extra) {
  const min = LEVELS[process.env.PAINEL_LOG_LEVEL] || LEVELS.info;
  if (LEVELS[level] < min) return;
  const time = new Date().toISOString();
  const text = extra === undefined ? String(msg)
    : `${msg} ${typeof extra === 'string' ? extra : safeJson(extra)}`;
  const entry = { time, level, scope, msg: text };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  for (const fn of listeners) { try { fn(entry); } catch (_) { } }

  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  const st = openLogStream();
  if (st) { try { st.write(line + os.EOL); } catch (_) { } }
}

function safeJson(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }

function createLogger(scope) {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e instanceof Error ? e.stack || e.message : e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

const logs = {
  create: createLogger,
  recent: (n) => ring.slice(-(n || 200)),
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};

// ----------------------------------------------------------- preferencias --
// Um unico arquivo painel-settings.json com tudo que o usuario ajusta na UI.
const DEFAULT_SETTINGS = {
  theme: 'dark',              // dark | light | system
  accent: 'coral',            // coral | azul | verde | roxo | ambar
  density: 'confortavel',     // confortavel | compacta
  animations: true,
  sounds: true,
  logoWatermark: 'discreta',  // off | discreta | media | forte
  capture: {
    dir: PATHS.capturas,
    videoFormat: 'mp4',       // mp4 | mkv
    audio: true,
    openAfter: false,
  },
  mirror: {
    autoStart: true,          // espelha sozinho assim que o aparelho aparece
    maxSize: 1280,
    bitrate: 8000000,
    maxFps: 60,
    codec: 'h264',            // h264 | h265
    stayAwake: true,
    powerOn: true,
    showTouches: false,
    turnScreenOff: false,
  },
  wifi: {
    port: 5555,
    autoReconnect: true,
  },
  known: [],                  // [{serial, name, model, ip, lastSeen}]
  aliases: {},                // apelidos dados pelo usuario: { "<serial de hardware>": "Nome" }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const bv = out[k], pv = patch[k];
    out[k] = (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv))
      ? deepMerge(bv, pv) : pv;
  }
  return out;
}

const slog = createLogger('settings');
let cache = null;
let saveTimer = null;

const settings = {
  all() {
    if (cache) return cache;
    let disk = {};
    try { disk = JSON.parse(stripBom(fs.readFileSync(PATHS.settings, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') slog.warn('painel-settings.json invalido, usando padroes', e.message); }
    cache = deepMerge(DEFAULT_SETTINGS, disk);
    return cache;
  },
  get(pathStr, fallback) {
    const parts = String(pathStr).split('.');
    let v = settings.all();
    for (const p of parts) { if (v == null) return fallback; v = v[p]; }
    return v === undefined ? fallback : v;
  },
  patch(obj) {
    cache = deepMerge(settings.all(), obj || {});
    settings.flush();
    return cache;
  },
  /**
   * Substitui um ramo inteiro, sem mesclar.
   * patch() faz merge profundo - otimo para {mirror:{maxFps:30}}, mas incapaz
   * de REMOVER uma chave de um mapa (ex.: apagar um apelido): a chave antiga
   * sobrevivia a mesclagem. Para mapas, use set().
   */
  set(chave, valor) {
    const atual = settings.all();
    atual[chave] = valor;
    cache = atual;
    settings.flush();
    return cache;
  },
  flush() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(PATHS.settings, JSON.stringify(cache, null, 2), 'utf8'); }
      catch (e) { slog.error('nao gravou painel-settings.json', e); }
    }, 120);
  },
  defaults: DEFAULT_SETTINGS,
};

function stripBom(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

// -------------------------------------------------------------- processos --
const plog = createLogger('proc');

// Roda um processo e devolve {code, stdout, stderr}. NUNCA rejeita por exit!=0
// (o adb escreve no stderr em situacoes normais) - quem chama decide.
function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args || [], {
        cwd: opts.cwd || BASE,
        env: opts.env || process.env,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message, error: e });
    }
    let stdout = '', stderr = '', done = false;
    const finish = (code, error) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { }
      finish(-2, new Error('tempo esgotado'));
    }, opts.timeout || 45000);

    if (child.stdout) child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => finish(code === null ? -1 : code));
    child.on('error', (e) => finish(-1, e));
    if (opts.stdin != null && child.stdin) { try { child.stdin.end(opts.stdin); } catch (_) { } }
  });
}

// Igual ao run(), mas devolve o stdout como Buffer (screencap, pull, etc.).
function runBuffer(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args || [], { cwd: opts.cwd || BASE, env: opts.env || process.env, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message, error: e }); }
    const chunks = []; let stderr = '', done = false;
    const finish = (code, error) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, error });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { } finish(-2, new Error('tempo esgotado')); }, opts.timeout || 60000);
    if (child.stdout) child.stdout.on('data', (b) => chunks.push(b));
    if (child.stderr) child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => finish(code === null ? -1 : code));
    child.on('error', (e) => finish(-1, e));
  });
}

// Roda transmitindo linha a linha (usado pelo SSE). Devolve um handle com kill().
function stream(cmd, args, opts, onLine) {
  opts = opts || {};
  let child;
  try {
    child = spawn(cmd, args || [], {
      cwd: opts.cwd || BASE,
      env: opts.env || process.env,
      windowsHide: true,
    });
  } catch (e) {
    setImmediate(() => { onLine('[erro] ' + e.message, 'err'); onLine(null, 'end', 1); });
    return { kill() { } };
  }
  const pump = (buf, kind) => {
    buf.toString('utf8').split(/\r?\n/).forEach((l) => { if (l !== '') onLine(l, kind); });
  };
  if (child.stdout) child.stdout.on('data', (b) => pump(b, 'out'));
  if (child.stderr) child.stderr.on('data', (b) => pump(b, 'err'));
  child.on('close', (code) => onLine(null, 'end', code === null ? 1 : code));
  child.on('error', (e) => { onLine('[erro] ' + e.message, 'err'); onLine(null, 'end', 1); });
  return {
    child,
    kill() { try { child.kill(); } catch (_) { } },
  };
}

// ---------------------------------------------------------------- utils ----
const RX_SERIAL = /^[A-Za-z0-9_.:-]{2,64}$/;
const RX_PKG = /^[A-Za-z0-9_][A-Za-z0-9_.]{1,180}$/;

const util = {
  stripBom,
  isSerial: (s) => typeof s === 'string' && RX_SERIAL.test(s),
  isPkg: (s) => typeof s === 'string' && RX_PKG.test(s),
  // nome seguro para arquivo: remove o que o Windows proibe e troca espaco por
  // hifen, mantendo os hifens existentes (o nome continua legivel)
  safeName(s, fallback) {
    const clean = String(s || '').normalize('NFKD')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return clean || fallback || 'arquivo';
  },
  timestamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); },
  id(bytes) { return crypto.randomBytes(bytes || 8).toString('hex'); },
  bytesToMB(n) { return (Number(n || 0) / 1048576).toFixed(1); },
  sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); },
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
};

ensureDir(PATHS.appLogs);
ensureDir(PATHS.capturas);

module.exports = { PATHS, ADB, BASE, PAINEL, logs, settings, run, runBuffer, stream, util, ensureDir, deepMerge };
