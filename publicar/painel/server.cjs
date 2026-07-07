// ============================================================
//  Painel local de configuracao de celular (realme)
//  Servidor Node (sem dependencias) que serve o front-end e
//  dispara o setup-celular.ps1, transmitindo o log ao vivo (SSE).
//  Uso:  node server.js   ->   http://localhost:8787
// ============================================================
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PORT = 8787;
const ROOT = __dirname;
const BASE = path.join(ROOT, '..');
const SCRIPT = path.join(BASE, 'setup-celular.ps1');
const UPDATER = path.join(BASE, 'atualizar-apks.ps1');
const RESTORE = path.join(BASE, 'restaurar.ps1');
const MANAGE = path.join(BASE, 'gerenciar-app.ps1');
const EXTRACT = path.join(BASE, 'extrair-apk.ps1');
const CLONES_PS = path.join(BASE, 'clones-cloneapp.ps1');
const APKDIR = path.join(BASE, 'apks');
const CONFIG = path.join(BASE, 'config.json');
const CATALOG = path.join(BASE, 'apps-catalog.json');
const UPDATE_CFG = path.join(BASE, 'update.json');       // { baseUrl } de onde baixar updates
const VERSAO_LOCAL = path.join(BASE, 'versao-local.txt'); // versao instalada (texto simples)
// hash do proprio server.cjs quando o servidor subiu. Se o arquivo no disco mudar
// (ex.: uma atualizacao foi baixada), da pra avisar que o painel precisa reiniciar.
let BOOT_SELF_HASH = '';
try { BOOT_SELF_HASH = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'); } catch (_) {}

// apps personalizados (apps-catalog.json) - editaveis pelo painel
function readCatalogObj() { try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (_) { return { custom: [] }; } }
function customAppIds() { return (readCatalogObj().custom || []).map(a => a.id); }
const BUILTIN_APP = new Set(['whatsapp', 'wabusiness', 'telegram', 'island', 'cloneapp', 'facebook', 'facebooklite', 'metaads', 'metabusiness']);
const LOGS = path.join(BASE, 'logs');
// ADB: prefere o platform-tools EMBUTIDO na pasta (portavel); senao usa o do USERPROFILE
const ADB = (function(){
  const bundled = path.join(BASE, 'platform-tools', 'adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(process.env.USERPROFILE || '', 'platform-tools', 'adb.exe');
})();

function getSerial(cb){ const p=spawn(ADB,['get-serialno']); let o=''; p.stdout.on('data',d=>o+=d); p.on('close',()=>cb((o.trim()||'desconhecido').replace(/[^A-Za-z0-9_.-]/g,'_'))); p.on('error',()=>cb('desconhecido')); }
function readBody(req,cb){ let b=''; req.on('data',d=>b+=d); req.on('end',()=>cb(b)); }
// roda um .ps1 transmitindo via SSE
function streamPs(res, req, psFile, extraArgs, firstLine){
  cors(res);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'});
  const ev=(l)=>res.write(`data: ${l}\n\n`);
  if(firstLine) ev(firstLine);
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',psFile].concat(extraArgs||[]);
  const p=spawn('powershell.exe',args,{cwd:BASE});
  p.stdout.on('data',(b)=>b.toString('utf8').split(/\r?\n/).forEach(l=>{if(l!=='')ev(l);}));
  p.stderr.on('data',(b)=>b.toString('utf8').split(/\r?\n/).forEach(l=>{if(l!=='')ev('[!] '+l);}));
  p.on('close',(c)=>{ev('__DONE__ '+c);res.end();});
  p.on('error',(e)=>{ev('[erro] '+e.message);ev('__DONE__ 1');res.end();});
  req.on('close',()=>{try{p.kill();}catch(_){}});
}

// flags validas que o front-end pode pedir para PULAR uma etapa
const VALID_SKIP = new Set([
  'SkipDebloat','SkipServices','SkipApks','SkipBusiness',
  'SkipIsland','SkipTheme','SkipNativeClone','SkipSuggestions'
]);

function cors(res){ res.setHeader('Access-Control-Allow-Origin', '*'); }
function send(res, code, type, body){ cors(res); res.writeHead(code, {'Content-Type': type}); res.end(body); }

// ---- Atualizacao do programa (baixa so os arquivos que mudaram) ----
function sha256(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }
// remove o BOM inicial (Notepad/PowerShell as vezes gravam UTF-8 com BOM, que quebra o JSON.parse)
function semBom(s){ return (s && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s; }
// baixa uma URL (segue redirecionamentos) e devolve um Buffer
function httpGetBuffer(url, cb, redirects){
  redirects = redirects || 0;
  if (redirects > 5) return cb(new Error('muitos redirecionamentos'));
  let lib;
  try { lib = url.toLowerCase().startsWith('https:') ? https : http; } catch (e) { return cb(e); }
  const req = lib.get(url, { headers: { 'User-Agent': 'ConfigCelular-Updater' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      let next; try { next = new URL(r.headers.location, url).toString(); } catch (e) { return cb(e); }
      return httpGetBuffer(next, cb, redirects + 1);
    }
    if (r.statusCode !== 200) { r.resume(); return cb(new Error('HTTP ' + r.statusCode)); }
    const chunks = []; r.on('data', d => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  req.on('error', cb);
  req.setTimeout(30000, () => req.destroy(new Error('tempo esgotado')));
}
// le o baseUrl do update.json (sem barra no fim)
function readBaseUrl(){ try { const c = JSON.parse(semBom(fs.readFileSync(UPDATE_CFG, 'utf8'))); return (c.baseUrl || '').trim().replace(/\/+$/, ''); } catch (_) { return ''; } }
function baseConfigurado(b){ return !!b && !/SEU-|USUARIO|EXEMPLO|coloque/i.test(b); }
function versaoLocal(){ try { return (fs.readFileSync(VERSAO_LOCAL, 'utf8').trim()) || '0'; } catch (_) { return '0'; } }
// converte um caminho relativo do manifesto em caminho absoluto SEGURO dentro de BASE.
// so aceita arquivos-texto do programa (nunca .exe/.dll/.apk, nunca sair da pasta).
function caminhoSeguro(rel){
  if (typeof rel !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(rel) || rel.includes('..')) return null;
  if (!/\.(ps1|cjs|js|html|css|json|txt|bat|md)$/i.test(rel)) return null;
  const abs = path.resolve(BASE, rel);
  if (!abs.startsWith(path.resolve(BASE) + path.sep)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // ---- pagina ----
  if (u.pathname === '/' || u.pathname === '/index.html') {
    fs.readFile(path.join(ROOT, 'index.html'), (e, data) =>
      e ? send(res, 500, 'text/plain', 'index.html nao encontrado') :
          send(res, 200, 'text/html; charset=utf-8', data));
    return;
  }

  // ---- status do celular ----
  if (u.pathname === '/api/device') {
    const p = spawn(ADB, ['devices', '-l']);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', () => {
      let status = 'nenhum', serial = '', model = '';
      const lines = out.split(/\r?\n/).slice(1);
      for (const l of lines) {
        if (/\bunauthorized\b/.test(l)) { status = 'unauthorized'; serial = l.split(/\s+/)[0]; }
        else if (/\bdevice\b/.test(l)) {
          status = 'ok'; serial = l.split(/\s+/)[0];
          const m = l.match(/model:(\S+)/); if (m) model = m[1];
        }
      }
      if (status !== 'ok') {
        send(res, 200, 'application/json', JSON.stringify({ status, serial, model }));
        return;
      }
      // info extra: Android, ROM, bateria, armazenamento, RAM
      const cmd = 'echo A=$(getprop ro.build.version.release); echo R=$(getprop ro.build.display.id); dumpsys battery | grep -m1 level; echo D=$(df /data | tail -1); grep -m1 MemTotal /proc/meminfo';
      const q = spawn(ADB, ['shell', cmd]);
      let o2 = '';
      q.stdout.on('data', d => o2 += d);
      q.on('close', () => {
        const gb = kb => (kb / 1048576).toFixed(kb / 1048576 >= 10 ? 0 : 1);
        const android = (o2.match(/A=(.+)/) || [])[1]?.trim() || '';
        const rom = (o2.match(/R=(.+)/) || [])[1]?.trim() || '';
        const battery = (o2.match(/level:\s*(\d+)/) || [])[1] || '';
        let storage = '';
        const dm = o2.match(/D=\S+\s+(\d+)\s+(\d+)\s+(\d+)/);
        if (dm) storage = gb(+dm[3]) + '/' + gb(+dm[1]) + ' GB livres';
        let ram = '';
        const rm = o2.match(/MemTotal:\s*(\d+)/);
        if (rm) ram = gb(+rm[1]) + ' GB';
        send(res, 200, 'application/json',
          JSON.stringify({ status, serial, model, android, rom, battery, storage, ram }));
      });
      q.on('error', () => send(res, 200, 'application/json', JSON.stringify({ status, serial, model })));
    });
    p.on('error', () => send(res, 200, 'application/json',
      JSON.stringify({ status: 'sem-adb', serial: '', model: '' })));
    return;
  }

  // ---- reiniciar o celular ----
  if (u.pathname === '/api/reboot') {
    const p = spawn(ADB, ['reboot']);
    p.on('close', () => send(res, 200, 'application/json', JSON.stringify({ ok: true })));
    p.on('error', (e) => send(res, 200, 'application/json', JSON.stringify({ ok: false, err: e.message })));
    return;
  }

  // ---- abrir a tela de Atualizacao de Software (OTA) no celular ----
  // (o ADB nao baixa/aplica a OTA sozinho; apenas abre a tela para o usuario tocar)
  if (u.pathname === '/api/sysupdate') {
    // tenta a tela do realme; se falhar, cai no intent padrao do Android
    const p = spawn(ADB, ['shell', 'am start -n com.oppo.ota/com.oppo.otaui.activity.EntryActivity']);
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', () => {
      if (/Error|does not exist|Exception/i.test(out)) {
        spawn(ADB, ['shell', 'am start -a android.settings.SYSTEM_UPDATE_SETTINGS'])
          .on('close', () => send(res, 200, 'application/json', JSON.stringify({ ok: true, fallback: true })));
      } else { send(res, 200, 'application/json', JSON.stringify({ ok: true })); }
    });
    p.on('error', (e) => send(res, 200, 'application/json', JSON.stringify({ ok: false, err: e.message })));
    return;
  }

  // ---- atualizar APKs oficiais (stream SSE) ----
  if (u.pathname === '/api/update-apks') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const ev = (line) => res.write(`data: ${line}\n\n`);
    const apkScript = path.join(ROOT, '..', 'atualizar-apks.ps1');
    ev('>> Atualizando APKs oficiais...');
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', apkScript], { cwd: path.join(ROOT, '..') });
    p.stdout.on('data', (b) => b.toString('utf8').split(/\r?\n/).forEach(l => { if (l !== '') ev(l); }));
    p.stderr.on('data', (b) => b.toString('utf8').split(/\r?\n/).forEach(l => { if (l !== '') ev('[!] ' + l); }));
    p.on('close', (c) => { ev('__DONE__ ' + c); res.end(); });
    p.on('error', (e) => { ev('[erro] ' + e.message); ev('__DONE__ 1'); res.end(); });
    req.on('close', () => { try { p.kill(); } catch (_) {} });
    return;
  }

  // ---- executa a configuracao (stream SSE) + salva log por aparelho ----
  if (u.pathname === '/api/run') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const skips = (u.searchParams.get('skip') || '').split(',').filter(s => VALID_SKIP.has(s));
    const dry = u.searchParams.get('dry') === '1';
    getSerial((serial) => {
      let logStream = null;
      try {
        fs.mkdirSync(LOGS, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        logStream = fs.createWriteStream(path.join(LOGS, `${serial}_${ts}.txt`));
      } catch (_) {}
      const ev = (line) => { res.write(`data: ${line}\n\n`); if (logStream) { try { logStream.write(line + '\n'); } catch (_) {} } };
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
      for (const s of skips) args.push('-' + s);
      if (dry) args.push('-DryRun');
      ev('>> Iniciando configuracao' + (dry ? ' (SIMULACAO / dry-run)' : '') + '...');
      ev('>> Aparelho: ' + serial);
      if (skips.length) ev('>> Pulando: ' + skips.join(', '));
      const p = spawn('powershell.exe', args, { cwd: BASE });
      p.stdout.on('data', (b) => b.toString('utf8').split(/\r?\n/).forEach(l => { if (l !== '') ev(l); }));
      p.stderr.on('data', (b) => b.toString('utf8').split(/\r?\n/).forEach(l => { if (l !== '') ev('[!] ' + l); }));
      p.on('close', (code) => { ev('__DONE__ ' + code); if (logStream) logStream.end(); res.end(); });
      p.on('error', (e) => { ev('[erro] ' + e.message); ev('__DONE__ 1'); if (logStream) logStream.end(); res.end(); });
      req.on('close', () => { try { p.kill(); } catch (_) {} });
    });
    return;
  }

  // ---- #1 lista apps instalados (scope: 3=terceiros, all=todos) ----
  if (u.pathname === '/api/apps') {
    const scope = u.searchParams.get('scope') === 'all' ? [] : ['-3'];
    const p = spawn(ADB, ['shell', 'pm', 'list', 'packages', ...scope]);
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => send(res, 200, 'application/json', JSON.stringify({
      apps: out.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean).sort()
    })));
    p.on('error', () => send(res, 200, 'application/json', JSON.stringify({ apps: [] })));
    return;
  }

  // ---- #1 adiciona pacotes a uma lista do config.json ----
  if (u.pathname === '/api/config-add' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const { list, pkgs } = JSON.parse(body);
        if (!['forceRemove', 'keepThirdParty', 'bloatPatterns', 'protect'].includes(list))
          return send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'lista invalida' }));
        let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (_) {}
        if (!Array.isArray(cfg[list])) cfg[list] = [];
        const set = new Set(cfg[list]); let added = 0;
        for (const pk of (pkgs || [])) { if (pk && !set.has(pk)) { set.add(pk); added++; } }
        cfg[list] = [...set];
        fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
        send(res, 200, 'application/json', JSON.stringify({ ok: true, added, total: cfg[list].length }));
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ ok: false, err: e.message })); }
    });
    return;
  }

  // ---- #2 preflight: bateria, tela bloqueada, wifi ----
  if (u.pathname === '/api/preflight') {
    const d = spawn(ADB, ['devices']); let dout = '';
    d.stdout.on('data', x => dout += x);
    d.on('close', () => {
      if (!/\tdevice\b/.test(dout)) { send(res, 200, 'application/json', JSON.stringify({ device: false })); return; }
      const p = spawn(ADB, ['shell', 'dumpsys battery | grep -m1 level; dumpsys window | grep -m1 -oE "isKeyguardShowing=(true|false)"; settings get global wifi_on']);
      let o = ''; p.stdout.on('data', x => o += x);
      p.on('close', () => {
        const bat = (o.match(/level:\s*(\d+)/) || [])[1] || '';
        const locked = /isKeyguardShowing=true/.test(o);
        const lines = o.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const wifi = lines[lines.length - 1] === '1';
        send(res, 200, 'application/json', JSON.stringify({ device: true, battery: bat, locked, wifi }));
      });
      p.on('error', () => send(res, 200, 'application/json', JSON.stringify({ device: true })));
    });
    return;
  }

  // ---- #3 preview do debloat: mesma logica do script, em JS ----
  if (u.pathname === '/api/debloat-preview') {
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (_) {}
    const toRx = (arr) => (arr || []).map(s => { try { return new RegExp(s); } catch (_) { return null; } }).filter(Boolean);
    const P = toRx(cfg.protect), B = toRx(cfg.bloatPatterns), K = toRx(cfg.keepThirdParty), force = cfg.forceRemove || [];
    const any = (s, list) => list.some(r => r.test(s));
    const pAll = spawn(ADB, ['shell', 'pm', 'list', 'packages']); let a = '';
    pAll.stdout.on('data', d => a += d);
    pAll.on('close', () => {
      const p3 = spawn(ADB, ['shell', 'pm', 'list', 'packages', '-3']); let t = '';
      p3.stdout.on('data', d => t += d);
      p3.on('close', () => {
        const clean = s => s.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean);
        const all = clean(a), tp = clean(t), set = new Set();
        tp.forEach(p => { if (!any(p, K) && !any(p, P)) set.add(p); });
        all.forEach(p => { if (any(p, B) && !any(p, P)) set.add(p); });
        force.forEach(p => { if (all.includes(p)) set.add(p); });
        send(res, 200, 'application/json', JSON.stringify({ targets: [...set].sort() }));
      });
    });
    pAll.on('error', () => send(res, 200, 'application/json', JSON.stringify({ targets: [] })));
    return;
  }

  // ---- config.json (ler/salvar) ----
  if (u.pathname === '/api/config') {
    if (req.method === 'POST') {
      readBody(req, (body) => {
        try { JSON.parse(body); fs.writeFileSync(CONFIG, body, 'utf8'); send(res, 200, 'application/json', JSON.stringify({ ok: true })); }
        catch (e) { send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'JSON invalido: ' + e.message })); }
      });
    } else {
      fs.readFile(CONFIG, (e, data) => e ? send(res, 200, 'application/json', '{}') : send(res, 200, 'application/json; charset=utf-8', data));
    }
    return;
  }

  // ---- restaurar apps removidos (stream SSE) ----
  if (u.pathname === '/api/restore') {
    streamPs(res, req, RESTORE, [], '>> Restaurando apps removidos...');
    return;
  }

  // ---- gerenciar app: desinstalar/instalar/reinstalar/limpar (stream SSE) ----
  if (u.pathname === '/api/app-action') {
    const action = u.searchParams.get('action') || '';
    const app = u.searchParams.get('app') || '';
    const dry = u.searchParams.get('dry') === '1';
    const VALID_ACTION = new Set(['uninstall', 'install', 'reinstall', 'clear']);
    const allowedApp = new Set([...BUILTIN_APP, ...customAppIds()]);
    if (!VALID_ACTION.has(action) || !allowedApp.has(app) || !/^[A-Za-z0-9_.]+$/.test(app)) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'parametros invalidos' }));
      return;
    }
    const user = u.searchParams.get('user') || '';
    const args = ['-Action', action, '-App', app];
    if (/^\d+$/.test(user)) args.push('-User', user);
    if (dry) args.push('-DryRun');
    const tag = (/^\d+$/.test(user) && user !== '0') ? ' [clone user ' + user + ']' : '';
    streamPs(res, req, MANAGE, args, '>> ' + action + ' ' + app + tag + (dry ? ' (SIMULACAO)' : '') + '...');
    return;
  }

  // ---- extrair o APK de um app instalado (stream SSE) ----
  if (u.pathname === '/api/extract') {
    const pkg = u.searchParams.get('pkg') || '';
    const nome = u.searchParams.get('nome') || '';
    if (!/^[A-Za-z0-9_.]+$/.test(pkg)) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'pkg invalido' }));
      return;
    }
    const args = ['-Pkg', pkg];
    if (nome) args.push('-Nome', nome.slice(0, 60));
    streamPs(res, req, EXTRACT, args, '>> Extraindo ' + pkg + '...');
    return;
  }

  // ---- versoes: instalada (no aparelho) + do APK na pasta (_versoes.json) ----
  if (u.pathname === '/api/versions') {
    let apks = {};
    try { apks = JSON.parse(fs.readFileSync(path.join(APKDIR, '_versoes.json'), 'utf8')); } catch (_) {}
    const pkgs = (u.searchParams.get('pkgs') || '').split(',').filter(p => /^[A-Za-z0-9_.]+$/.test(p));
    if (!pkgs.length) { send(res, 200, 'application/json', JSON.stringify({ installed: {}, apks })); return; }
    const cmd = 'for p in ' + pkgs.join(' ') + '; do echo "V:$p $(dumpsys package $p 2>/dev/null | grep -m1 versionName)$(dumpsys package $p 2>/dev/null | grep -m1 versionCode)"; done';
    const p = spawn(ADB, ['shell', cmd]); let o = '';
    p.stdout.on('data', d => o += d);
    p.on('close', () => {
      const installed = {};
      o.split(/\r?\n/).forEach(l => {
        const m = l.match(/^V:(\S+)\s/); if (!m) return;
        const vn = (l.match(/versionName=(\S+)/) || [])[1] || '';
        const vc = (l.match(/versionCode=(\d+)/) || [])[1] || '';
        if (vn || vc) installed[m[1]] = { versionName: vn, versionCode: vc };
      });
      send(res, 200, 'application/json', JSON.stringify({ installed, apks }));
    });
    p.on('error', () => send(res, 200, 'application/json', JSON.stringify({ installed: {}, apks })));
    return;
  }

  // ---- enxugar o bundle do Facebook: remove splits opcionais (IA/ML) ----
  if (u.pathname === '/api/trim-facebook') {
    const bdir = path.join(APKDIR, 'facebook-bundle');
    const out = [];
    try {
      const files = fs.readdirSync(bdir);
      // remove modulos opcionais (pytorch/papaya = IA/camera); mantem base + helium (core)
      const optional = /^split_(pytorch|papaya|s_papaya)/i;
      let freed = 0, n = 0;
      for (const f of files) {
        if (optional.test(f)) { const fp = path.join(bdir, f); freed += fs.statSync(fp).size; fs.unlinkSync(fp); out.push('removido: ' + f); n++; }
      }
      send(res, 200, 'application/json', JSON.stringify({ ok: true, removed: n, freedMB: (freed / 1048576).toFixed(1), files: out }));
    } catch (e) {
      send(res, 200, 'application/json', JSON.stringify({ ok: false, err: e.message }));
    }
    return;
  }

  // ---- Clone App: criar / deletar clones (stream SSE, automacao de UI) ----
  if (u.pathname === '/api/clone-create' || u.pathname === '/api/clone-delete') {
    const action = u.pathname.endsWith('create') ? 'create' : 'delete';
    const applabel = u.searchParams.get('app') || 'WhatsApp';
    const names = (u.searchParams.get('names') || '').slice(0, 200);
    const dry = u.searchParams.get('dry') === '1';
    const VALID_LABELS = new Set(['WhatsApp', 'WhatsApp Business', 'Telegram']);
    if (!names.trim() || (action === 'create' && !VALID_LABELS.has(applabel))) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'parametros invalidos' }));
      return;
    }
    const args = ['-Action', action, '-Names', names];
    if (action === 'create') args.push('-AppLabel', applabel);
    if (dry) args.push('-DryRun');
    streamPs(res, req, CLONES_PS, args, '>> Clone App: ' + action + (dry ? ' (SIMULACAO)' : '') + '...');
    return;
  }

  // ---- Clone App: renomear um clone (stream SSE) ----
  if (u.pathname === '/api/clone-rename') {
    const oldn = (u.searchParams.get('old') || '').slice(0, 60);
    const newn = (u.searchParams.get('new') || '').slice(0, 60);
    const dry = u.searchParams.get('dry') === '1';
    if (!oldn.trim() || !newn.trim()) { send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'parametros invalidos' })); return; }
    const args = ['-Action', 'rename', '-Old', oldn, '-New', newn];
    if (dry) args.push('-DryRun');
    streamPs(res, req, CLONES_PS, args, '>> Clone App: rename' + (dry ? ' (SIMULACAO)' : '') + '...');
    return;
  }

  // ---- Clone App: listar clones existentes (JSON) ----
  if (u.pathname === '/api/clone-list') {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLONES_PS, '-Action', 'list'], { cwd: BASE });
    let o = '';
    p.stdout.on('data', d => o += d);
    p.on('close', () => {
      const clones = o.split(/\r?\n/).map(l => { const m = l.match(/^CLONE:(.+)$/); return m ? m[1].trim() : null; }).filter(Boolean);
      send(res, 200, 'application/json', JSON.stringify({ clones }));
    });
    p.on('error', e => send(res, 200, 'application/json', JSON.stringify({ clones: [], err: e.message })));
    return;
  }

  // ---- abrir o Clone App no celular ----
  if (u.pathname === '/api/clone-open') {
    const p = spawn(ADB, ['shell', 'monkey', '-p', 'com.pengyou.cloneapp', '-c', 'android.intent.category.LAUNCHER', '1']);
    p.on('close', () => send(res, 200, 'application/json', JSON.stringify({ ok: true })));
    p.on('error', e => send(res, 200, 'application/json', JSON.stringify({ ok: false, err: e.message })));
    return;
  }

  // ---- diagnostico do aparelho (bateria, RAM, armazenamento, sistema) ----
  if (u.pathname === '/api/diag') {
    const cmd = [
      'echo "manufacturer=$(getprop ro.product.manufacturer)"',
      'echo "model=$(getprop ro.product.model)"',
      'echo "android=$(getprop ro.build.version.release)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      'echo "rom=$(getprop ro.build.display.id)"',
      'echo "abi=$(getprop ro.product.cpu.abi)"',
      'echo "serial=$(getprop ro.serialno)"',
      'echo "uptime=$(cat /proc/uptime)"',
      'echo "===BAT==="', 'dumpsys battery',
      'echo "===MEM==="', 'grep -E "MemTotal|MemAvailable" /proc/meminfo',
      'echo "===DF==="', 'df /data | tail -1'
    ].join('; ');
    const p = spawn(ADB, ['shell', cmd]); let o = '';
    p.stdout.on('data', d => o += d);
    p.on('close', () => {
      const get = k => (o.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';
      const bat = (o.split('===BAT===')[1] || '').split('===MEM===')[0] || '';
      const bval = k => (bat.match(new RegExp(k + ':\\s*(\\S+)')) || [])[1] || '';
      const mem = (o.split('===MEM===')[1] || '').split('===DF===')[0] || '';
      const memv = k => +((mem.match(new RegExp(k + ':\\s*(\\d+)')) || [])[1] || 0);
      const df = (o.split('===DF===')[1] || '').trim();
      const dm = df.match(/\S+\s+(\d+)\s+(\d+)\s+(\d+)/);
      const gb = kb => (kb / 1048576).toFixed(1);
      const healthMap = { 1: 'desconhecida', 2: 'boa', 3: 'superaquecida', 4: 'morta', 5: 'sobretensao', 6: 'falha', 7: 'fria' };
      const statusMap = { 1: 'desconhecido', 2: 'carregando', 3: 'descarregando', 4: 'nao carrega', 5: 'cheia' };
      const tempRaw = +bval('temperature');
      send(res, 200, 'application/json', JSON.stringify({
        manufacturer: get('manufacturer'), model: get('model'), android: get('android'), sdk: get('sdk'),
        rom: get('rom'), abi: get('abi'), serial: get('serial'),
        uptimeSec: Math.round(parseFloat((get('uptime') || '0').split(' ')[0]) || 0),
        battery: { level: bval('level'), health: healthMap[+bval('health')] || '', status: statusMap[+bval('status')] || '', tempC: tempRaw ? (tempRaw / 10).toFixed(1) : '', tech: bval('technology') },
        ram: { totalGB: memv('MemTotal') ? gb(memv('MemTotal')) : '', availGB: memv('MemAvailable') ? gb(memv('MemAvailable')) : '' },
        storage: dm ? { totalGB: gb(+dm[1]), usedGB: gb(+dm[2]), freeGB: gb(+dm[3]) } : null
      }));
    });
    p.on('error', () => send(res, 200, 'application/json', JSON.stringify({ err: 'sem-adb' })));
    return;
  }

  // ---- espelho da tela: captura um PNG da tela do celular (image/png) ----
  if (u.pathname === '/api/screen') {
    const p = spawn(ADB, ['exec-out', 'screencap', '-p']);
    const chunks = []; let err = '';
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      // valida a assinatura PNG (89 50 4E 47) antes de servir como imagem
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        cors(res); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(buf);
      } else {
        send(res, 200, 'application/json', JSON.stringify({ ok: false, err: (err.trim() || 'Sem imagem — o celular esta conectado e desbloqueado?') }));
      }
    });
    p.on('error', () => send(res, 200, 'application/json', JSON.stringify({ ok: false, err: 'ADB nao encontrado' })));
    return;
  }

  // ---- permissoes em massa: conceder/revogar as comuns de um app (stream SSE) ----
  if (u.pathname === '/api/perms-bulk') {
    const pkg = u.searchParams.get('pkg') || '';
    const action = u.searchParams.get('action');
    if (!/^[A-Za-z0-9_.]+$/.test(pkg) || !['grant', 'revoke'].includes(action)) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'parametros invalidos' }));
      return;
    }
    const PERMS = ['CAMERA', 'RECORD_AUDIO', 'READ_CONTACTS', 'WRITE_CONTACTS', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_MEDIA_LOCATION', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO', 'READ_PHONE_STATE', 'READ_PHONE_NUMBERS', 'CALL_PHONE', 'READ_CALL_LOG', 'SEND_SMS', 'READ_SMS', 'RECEIVE_SMS', 'POST_NOTIFICATIONS', 'NEARBY_WIFI_DEVICES', 'BLUETOOTH_CONNECT', 'BLUETOOTH_SCAN', 'GET_ACCOUNTS', 'ACTIVITY_RECOGNITION', 'BODY_SENSORS'];
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const ev = l => res.write(`data: ${l}\n\n`);
    ev('>> ' + (action === 'grant' ? 'Concedendo' : 'Revogando') + ' permissoes de ' + pkg + '...');
    // alguns ROMs (Xiaomi/MIUI, ColorOS) bloqueiam pm grant/revoke via ADB sem a opcao
    // "Depuracao USB (Config. seguranca)". Detecta a SecurityException e avisa, em vez de so falhar.
    const loop = PERMS.map(pm => `pm ${action} ${pkg} android.permission.${pm} >/dev/null 2>&1 && echo "[ok] ${pm}" || echo "[--] ${pm}"`).join('; ');
    const cmd = `PROBE=$(pm ${action} ${pkg} android.permission.CAMERA 2>&1); case "$PROBE" in *RUNTIME_PERMISSIONS*) echo "[!] ADB sem permissao p/ alterar permissoes neste aparelho. Xiaomi/MIUI: ligue 'Depuracao USB (Config. de seguranca)' nas Opcoes do desenvolvedor e tente de novo.";; *) ${loop};; esac`;
    const proc = spawn(ADB, ['shell', cmd]);
    proc.stdout.on('data', b => b.toString('utf8').split(/\r?\n/).forEach(l => { if (l !== '') ev(l); }));
    proc.on('close', c => { ev('__DONE__ ' + c); res.end(); });
    proc.on('error', e => { ev('[erro] ' + e.message); ev('__DONE__ 1'); res.end(); });
    req.on('close', () => { try { proc.kill(); } catch (_) {} });
    return;
  }

  // ---- catalogo de apps personalizados (ler) ----
  if (u.pathname === '/api/catalog') {
    send(res, 200, 'application/json', JSON.stringify(readCatalogObj()));
    return;
  }

  // ---- catalogo: adicionar/atualizar um app ----
  if (u.pathname === '/api/catalog-add' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const { pkg, name, cat } = JSON.parse(body);
        if (!/^[A-Za-z0-9_.]+$/.test(pkg || '')) return send(res, 400, 'application/json', JSON.stringify({ ok: false, err: 'pkg invalido' }));
        const nm = ((name || pkg).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60)) || pkg;
        const c = readCatalogObj(); c.custom = c.custom || [];
        const e = c.custom.find(a => a.id === pkg);
        if (e) { e.name = nm; if (cat) e.cat = String(cat).slice(0, 30); }
        else c.custom.push({ id: pkg, name: nm, cat: (cat ? String(cat).slice(0, 30) : 'Outros'), pkgs: [pkg], apk: nm + '.apk', bundle: nm + '-bundle', custom: true });
        fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
        send(res, 200, 'application/json', JSON.stringify({ ok: true, total: c.custom.length }));
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ ok: false, err: e.message })); }
    });
    return;
  }

  // ---- catalogo: remover um app ----
  if (u.pathname === '/api/catalog-remove' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const c = readCatalogObj(); c.custom = (c.custom || []).filter(a => a.id !== id);
        fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
        send(res, 200, 'application/json', JSON.stringify({ ok: true }));
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ ok: false, err: e.message })); }
    });
    return;
  }

  // ---- clones do Island: perfis de trabalho (user!=0) e seus apps gerenciados ----
  if (u.pathname === '/api/clones') {
    const MANAGED = ['com.whatsapp', 'com.whatsapp.w4b', 'org.telegram.messenger', 'org.telegram.messenger.web'];
    const pu = spawn(ADB, ['shell', 'pm', 'list', 'users']);
    let uo = ''; pu.stdout.on('data', d => uo += d);
    pu.on('close', () => {
      const ids = []; const re = /UserInfo\{(\d+):([^:]*):/g; let m;
      while ((m = re.exec(uo))) { if (m[1] !== '0') ids.push({ user: m[1], name: (m[2] || '').trim() || ('Perfil ' + m[1]) }); }
      if (!ids.length) { send(res, 200, 'application/json', JSON.stringify({ profiles: [] })); return; }
      const profiles = []; let pending = ids.length;
      const done = () => { if (--pending === 0) send(res, 200, 'application/json', JSON.stringify({ profiles })); };
      ids.forEach(pf => {
        const q = spawn(ADB, ['shell', 'pm', 'list', 'packages', '--user', pf.user]);
        let o = ''; q.stdout.on('data', d => o += d);
        q.on('close', () => {
          const set = new Set(o.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean));
          pf.pkgs = MANAGED.filter(p => set.has(p));
          if (pf.pkgs.length) profiles.push(pf);
          done();
        });
        q.on('error', done);
      });
    });
    pu.on('error', () => send(res, 200, 'application/json', JSON.stringify({ profiles: [] })));
    return;
  }

  // ---- versao do programa + se o server em execucao esta desatualizado (precisa reiniciar) ----
  if (u.pathname === '/api/version') {
    let stale = false;
    try { stale = !!BOOT_SELF_HASH && crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') !== BOOT_SELF_HASH; } catch (_) {}
    send(res, 200, 'application/json', JSON.stringify({ versao: versaoLocal(), stale: stale }));
    return;
  }

  // ---- verifica se ha atualizacao do programa (JSON) ----
  if (u.pathname === '/api/update-check') {
    const base = readBaseUrl();
    if (!baseConfigurado(base)) { send(res, 200, 'application/json', JSON.stringify({ configured: false })); return; }
    httpGetBuffer(base + '/versao.json', (err, buf) => {
      if (err) { send(res, 200, 'application/json', JSON.stringify({ configured: true, ok: false, err: err.message })); return; }
      let man; try { man = JSON.parse(semBom(buf.toString('utf8'))); } catch (e) { send(res, 200, 'application/json', JSON.stringify({ configured: true, ok: false, err: 'manifesto invalido' })); return; }
      const arquivos = Array.isArray(man.arquivos) ? man.arquivos : [];
      const pendentes = [];
      for (const a of arquivos) {
        const abs = caminhoSeguro(a.caminho || '');
        if (!abs) continue;
        let h = ''; try { h = sha256(fs.readFileSync(abs)); } catch (_) {}
        if (h.toLowerCase() !== String(a.sha256 || '').toLowerCase()) pendentes.push(a.caminho);
      }
      send(res, 200, 'application/json', JSON.stringify({
        configured: true, ok: true, versaoLocal: versaoLocal(),
        versaoRemota: man.versao || '?', notas: man.notas || '', pendentes, total: pendentes.length
      }));
    });
    return;
  }

  // ---- aplica a atualizacao: baixa so os arquivos que mudaram (stream SSE) ----
  if (u.pathname === '/api/update-run') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const ev = (l) => res.write(`data: ${l}\n\n`);
    const base = readBaseUrl();
    if (!baseConfigurado(base)) { ev('[!] Atualizacao online nao configurada (update.json).'); ev('__DONE__ 1'); return res.end(); }
    ev('>> Verificando atualizacoes...');
    httpGetBuffer(base + '/versao.json', (err, buf) => {
      if (err) { ev('[!] Nao consegui buscar o manifesto: ' + err.message); ev('__DONE__ 1'); return res.end(); }
      let man; try { man = JSON.parse(semBom(buf.toString('utf8'))); } catch (e) { ev('[!] Manifesto invalido.'); ev('__DONE__ 1'); return res.end(); }
      const arquivos = Array.isArray(man.arquivos) ? man.arquivos : [];
      const alvos = [];
      for (const a of arquivos) {
        const abs = caminhoSeguro(a.caminho || '');
        if (!abs) { ev('[--] ignorado (caminho invalido): ' + (a.caminho || '')); continue; }
        let h = ''; try { h = sha256(fs.readFileSync(abs)); } catch (_) {}
        if (h.toLowerCase() !== String(a.sha256 || '').toLowerCase()) alvos.push({ rel: a.caminho, abs, sha: String(a.sha256 || '').toLowerCase() });
      }
      if (!alvos.length) {
        // arquivos ja identicos ao manifesto: sincroniza a versao local se estiver defasada
        // (sem isso, o badge ficaria mostrando a versao antiga para sempre)
        try { const vr = String(man.versao || '').trim(); if (vr && vr !== versaoLocal()) fs.writeFileSync(VERSAO_LOCAL, vr + '\n', 'utf8'); } catch (_) {}
        ev('>> Ja esta na versao mais recente (' + (man.versao || '?') + '). Nada a baixar.'); ev('__DONE__ 0'); return res.end();
      }
      ev('>> Baixando ' + alvos.length + ' arquivo(s)...');
      let i = 0;
      const proximo = () => {
        if (i >= alvos.length) {
          try { fs.writeFileSync(VERSAO_LOCAL, String(man.versao || '').trim() + '\n', 'utf8'); } catch (_) {}
          ev('>> Atualizado para a versao ' + (man.versao || '?') + '.');
          ev('>> IMPORTANTE: FECHE e ABRA o painel de novo para aplicar.');
          ev('__DONE__ 0'); return res.end();
        }
        const a = alvos[i++];
        httpGetBuffer(base + '/' + a.rel, (e2, data) => {
          if (e2) { ev('[!] Falha ao baixar ' + a.rel + ': ' + e2.message); ev('__DONE__ 1'); return res.end(); }
          if (a.sha && sha256(data).toLowerCase() !== a.sha) { ev('[!] ' + a.rel + ': verificacao (hash) falhou. Abortado por seguranca.'); ev('__DONE__ 1'); return res.end(); }
          try { fs.mkdirSync(path.dirname(a.abs), { recursive: true }); fs.writeFileSync(a.abs, data); ev('[ok] ' + a.rel); }
          catch (werr) { ev('[!] Nao consegui gravar ' + a.rel + ': ' + werr.message); ev('__DONE__ 1'); return res.end(); }
          proximo();
        });
      };
      proximo();
    });
    req.on('close', () => {});
    return;
  }

  send(res, 404, 'text/plain', 'nao encontrado');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} ja esta em uso. O painel provavelmente ja esta aberto em http://localhost:${PORT}`);
  } else { console.error('Erro no servidor:', e.message); }
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================');
  console.log('  Painel de configuracao do celular');
  console.log('  Abra no navegador:  http://localhost:' + PORT);
  console.log('  (Ctrl+C para encerrar)');
  console.log('============================================');
});
