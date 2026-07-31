// ============================================================================
//  routes/legacy.cjs - TODO o conjunto de recursos que ja existia
// ----------------------------------------------------------------------------
//  Configuracao (setup-celular.ps1), gerenciar apps, extrair APK, perfis de
//  trabalho (Island / clonador nativo), permissoes em massa, listas do
//  config.json, catalogo de apps, diagnostico e espelho por screencap
//  continuam com o MESMO contrato de antes.
//  (O "Clone App" foi retirado do painel a pedido do usuario.)
//
//  O que mudou: o boilerplate de SSE que estava repetido 8 vezes agora e uma
//  funcao so (psStream), e os spawns de adb passam pelo modulo adb.cjs.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, ADB, stream, util, logs, ensureDir } = require('../core.cjs');
const adb = require('../adb.cjs');
const capture = require('./capture.cjs');

const log = logs.create('rotas:legado');

const VALID_SKIP = new Set([
  'SkipDebloat', 'SkipApks', 'SkipBusiness', 'SkipIsland', 'SkipTheme',
  'SkipSpeed', 'SkipDisplay', 'SkipMirror', 'SkipNativeClone', 'SkipSuggestions', 'SkipPerms', 'SkipBattery',
]);

const BUILTIN_APP = new Set([
  'whatsapp', 'wabusiness', 'telegram', 'island',
  'facebook', 'facebooklite', 'metaads', 'metabusiness',
]);

// permissoes comuns concedidas em massa (era duplicado em 2 rotas)
const PERMS = [
  'CAMERA', 'RECORD_AUDIO', 'READ_CONTACTS', 'WRITE_CONTACTS', 'ACCESS_FINE_LOCATION',
  'ACCESS_COARSE_LOCATION', 'ACCESS_MEDIA_LOCATION', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE',
  'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO', 'READ_PHONE_STATE', 'READ_PHONE_NUMBERS',
  'CALL_PHONE', 'READ_CALL_LOG', 'SEND_SMS', 'READ_SMS', 'RECEIVE_SMS', 'POST_NOTIFICATIONS',
  'NEARBY_WIFI_DEVICES', 'BLUETOOTH_CONNECT', 'BLUETOOTH_SCAN', 'GET_ACCOUNTS', 'ACTIVITY_RECOGNITION', 'BODY_SENSORS',
];

const readJsonFile = (file, fallback) => {
  try { return JSON.parse(util.stripBom(fs.readFileSync(file, 'utf8'))); } catch (_) { return fallback; }
};
const readCatalogObj = () => readJsonFile(PATHS.catalog, { custom: [] });
const customAppIds = () => (readCatalogObj().custom || []).map((a) => a.id);

// --------------------------- helper unico para rodar um .ps1 transmitindo ---
function psStream(ctx, psFile, extraArgs, firstLine, logFile) {
  const es = ctx.sse();
  let out = null;
  if (logFile) { try { ensureDir(PATHS.logs); out = fs.createWriteStream(logFile); } catch (_) { } }
  const say = (l) => { es.line(l); if (out) { try { out.write(l + '\n'); } catch (_) { } } };
  if (firstLine) say(firstLine);

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile].concat(extraArgs || []);
  const h = stream('powershell.exe', args, { cwd: PATHS.base }, (line, kind, code) => {
    if (line === null) { if (out) out.end(); es.done(code); return; }
    say(kind === 'err' ? '[!] ' + line : line);
  });
  es.onClose(() => h.kill());
  return es;
}

// -------------------------- helper para 'adb shell' longo transmitindo ------
function shellStream(ctx, serial, cmd, firstLine) {
  const es = ctx.sse();
  if (firstLine) es.line(firstLine);
  const h = stream(ADB, ['-s', serial, 'shell', cmd], {}, (line, kind, code) => {
    if (line === null) return es.done(code);
    es.line(kind === 'err' ? '[!] ' + line : line);
  });
  es.onClose(() => h.kill());
  return es;
}

function register(router) {
  // ======================================================= estado do celular =
  router.get('/api/device', async (ctx) => {
    const snap = adb.registry.snapshot();
    const devices = snap.map((d) => ({ serial: d.serial, state: d.state, model: d.model }));
    const online = snap.filter((d) => d.state === 'device');
    const selected = adb.getTarget();

    if (!online.length) {
      const un = snap.find((d) => d.state === 'unauthorized');
      return ctx.json({
        status: un ? 'unauthorized' : 'nenhum', serial: un ? un.serial : '', model: '',
        devices, selected: '', multi: false,
      });
    }
    if (online.length > 1 && !selected) {
      return ctx.json({ status: 'multi', devices, selected: '', multi: true });
    }
    const target = online.find((d) => d.serial === selected) || online[0];
    const dev = adb.registry.get(target.serial);
    const i = (dev && dev.info) || {};
    ctx.json({
      status: 'ok',
      serial: target.serial,
      model: target.model,
      android: i.android || '',
      rom: i.rom || '',
      battery: i.battery ? String(i.battery.level || '') : '',
      storage: i.storage ? `${i.storage.freeGB}/${i.storage.totalGB} GB livres` : '',
      ram: i.ram ? i.ram.totalGB : '',
      devices, selected: target.serial, multi: online.length > 1,
    });
  });

  router.any('/api/select-device', (ctx) => {
    const serial = ctx.q('serial');
    if (serial && !util.isSerial(serial)) return ctx.json({ ok: false, err: 'serial invalido' }, 400);
    if (serial) {
      const dev = adb.registry.get(serial);
      if (!dev || dev.state !== 'device') return ctx.json({ ok: false, err: 'aparelho nao esta online' }, 400);
    }
    adb.setTarget(serial);
    adb.registry.emitChange();
    ctx.json({ ok: true, selected: adb.getTarget() });
  });

  router.any('/api/reboot', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const r = await adb.exec(serial, ['reboot'], { timeout: 15000 });
    ctx.json({ ok: r.code === 0, err: r.code === 0 ? undefined : (r.stderr || '').trim() });
  });

  // abre a tela de Atualizacao de Software no celular (realme, com fallback)
  router.any('/api/sysupdate', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ ok: false, err: 'nenhum aparelho' });
    const r = await adb.shell(serial, 'am start -n com.oppo.ota/com.oppo.otaui.activity.EntryActivity', { timeout: 15000 });
    if (/Error|does not exist|Exception/i.test(r.all)) {
      await adb.shell(serial, 'am start -a android.settings.SYSTEM_UPDATE_SETTINGS', { timeout: 15000 });
      return ctx.json({ ok: true, fallback: true });
    }
    ctx.json({ ok: true });
  });

  // =========================================================== configuracao =
  router.get('/api/update-apks', (ctx) =>
    psStream(ctx, PATHS.scripts.updater, [], '>> Atualizando APKs oficiais...'));

  router.get('/api/run', async (ctx) => {
    const skips = ctx.q('skip').split(',').filter((s) => VALID_SKIP.has(s));
    const dry = ctx.qBool('dry');
    const serial = adb.registry.resolve(ctx.q('serial')) || 'desconhecido';
    const safeSerial = serial.replace(/[^A-Za-z0-9_.-]/g, '_');

    const args = [];
    for (const s of skips) args.push('-' + s);
    // "Brilho e tela" nao faz parte do setup: e aplicado a parte pelo card
    if (!skips.includes('SkipDisplay')) args.push('-SkipDisplay');
    if (dry) args.push('-DryRun');

    const logFile = path.join(PATHS.logs, `${safeSerial}_${util.timestamp()}.txt`);
    const es = psStream(ctx, PATHS.scripts.setup, args,
      '>> Iniciando configuracao' + (dry ? ' (SIMULACAO / dry-run)' : '') + '...', logFile);
    es.line('>> Aparelho: ' + safeSerial);
    if (skips.length) es.line('>> Pulando: ' + skips.join(', '));
  });

  // brilho / tempo de tela aplicados na hora
  router.any('/api/display', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ ok: false, err: 'nenhum aparelho' });
    const bri = ctx.qInt('bright', NaN);
    const adp = ctx.q('adaptive');
    const tmo = ctx.qInt('timeout', NaN);
    const cmds = [];
    if (adp === '0' || adp === '1') cmds.push('settings put system screen_brightness_mode ' + adp);
    if (adp !== '1' && Number.isInteger(bri) && bri >= 0 && bri <= 255) cmds.push('settings put system screen_brightness ' + bri);
    if (Number.isInteger(tmo) && tmo > 0 && tmo <= 2147483647) cmds.push('settings put system screen_off_timeout ' + tmo);
    if (!cmds.length) return ctx.json({ ok: false, err: 'parametros invalidos' }, 400);
    cmds.push('echo M=$(settings get system screen_brightness_mode) B=$(settings get system screen_brightness) T=$(settings get system screen_off_timeout)');
    const { all } = await adb.shell(serial, cmds.join('; '), { timeout: 20000 });
    ctx.json({
      ok: true,
      mode: (all.match(/M=(\S+)/) || [])[1] || '',
      brightness: (all.match(/B=(\S+)/) || [])[1] || '',
      timeout: (all.match(/T=(\S+)/) || [])[1] || '',
    });
  });

  // ================================================================== apps ==
  router.get('/api/apps', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ apps: [] });
    const scope = ctx.q('scope') === 'all' ? '' : '-3';
    const { all } = await adb.shell(serial, `pm list packages ${scope}`, { timeout: 40000 });
    ctx.json({
      apps: all.split(/\r?\n/).map((l) => l.replace('package:', '').trim()).filter(Boolean).sort(),
    });
  });

  router.post('/api/config-add', async (ctx) => {
    const { list, pkgs } = await ctx.body();
    if (!['forceRemove', 'keepThirdParty', 'bloatPatterns', 'protect'].includes(list)) {
      return ctx.json({ ok: false, err: 'lista invalida' }, 400);
    }
    const cfg = readJsonFile(PATHS.config, {});
    if (!Array.isArray(cfg[list])) cfg[list] = [];
    const set = new Set(cfg[list]);
    let added = 0;
    for (const pk of (pkgs || [])) { if (pk && !set.has(pk)) { set.add(pk); added++; } }
    cfg[list] = [...set];
    fs.writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2), 'utf8');
    ctx.json({ ok: true, added, total: cfg[list].length });
  });

  router.get('/api/preflight', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ device: false });
    const { all } = await adb.shell(serial,
      'dumpsys battery | grep -m1 level; dumpsys window | grep -m1 -oE "isKeyguardShowing=(true|false)"; settings get global wifi_on',
      { timeout: 25000 });
    const lines = all.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    ctx.json({
      device: true,
      battery: (all.match(/level:\s*(\d+)/) || [])[1] || '',
      locked: /isKeyguardShowing=true/.test(all),
      wifi: lines[lines.length - 1] === '1',
    });
  });

  // previa do debloat: mesma logica do script, em JS
  router.get('/api/debloat-preview', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ targets: [] });
    const cfg = readJsonFile(PATHS.config, {});
    const toRx = (arr) => (arr || []).map((s) => { try { return new RegExp(s); } catch (_) { return null; } }).filter(Boolean);
    const P = toRx(cfg.protect), B = toRx(cfg.bloatPatterns), K = toRx(cfg.keepThirdParty);
    const force = cfg.forceRemove || [];
    const any = (s, listRx) => listRx.some((r) => r.test(s));

    const clean = (s) => s.split(/\r?\n/).map((l) => l.replace('package:', '').trim()).filter(Boolean);
    const a = await adb.shell(serial, 'pm list packages', { timeout: 40000 });
    const t = await adb.shell(serial, 'pm list packages -3', { timeout: 40000 });
    const all = clean(a.all), tp = clean(t.all), set = new Set();
    tp.forEach((p) => { if (!any(p, K) && !any(p, P)) set.add(p); });
    all.forEach((p) => { if (any(p, B) && !any(p, P)) set.add(p); });
    force.forEach((p) => { if (all.includes(p)) set.add(p); });
    ctx.json({ targets: [...set].sort() });
  });

  router.any('/api/config', async (ctx) => {
    if (ctx.method === 'POST') {
      const raw = await ctx.raw();
      const body = raw.toString('utf8');
      try { JSON.parse(body); } catch (e) { return ctx.json({ ok: false, err: 'JSON invalido: ' + e.message }, 400); }
      fs.writeFileSync(PATHS.config, body, 'utf8');
      return ctx.json({ ok: true });
    }
    try { ctx.send(200, 'application/json; charset=utf-8', fs.readFileSync(PATHS.config)); }
    catch (_) { ctx.send(200, 'application/json; charset=utf-8', '{}'); }
  });

  router.get('/api/restore', (ctx) =>
    psStream(ctx, PATHS.scripts.restore, [], '>> Restaurando apps removidos...'));

  // gerenciar app: desinstalar / instalar / reinstalar / limpar
  router.get('/api/app-action', (ctx) => {
    const action = ctx.q('action');
    const app = ctx.q('app');
    const VALID_ACTION = new Set(['uninstall', 'install', 'reinstall', 'clear']);
    const allowedApp = new Set([...BUILTIN_APP, ...customAppIds()]);
    if (!VALID_ACTION.has(action) || !allowedApp.has(app) || !/^[A-Za-z0-9_.]+$/.test(app)) {
      return ctx.json({ ok: false, err: 'parametros invalidos' }, 400);
    }
    const user = ctx.q('user');
    const args = ['-Action', action, '-App', app];
    if (/^\d+$/.test(user)) args.push('-User', user);
    if (ctx.qBool('dry')) args.push('-DryRun');
    const tag = (/^\d+$/.test(user) && user !== '0') ? ` [clone user ${user}]` : '';
    psStream(ctx, PATHS.scripts.manage, args,
      `>> ${action} ${app}${tag}${ctx.qBool('dry') ? ' (SIMULACAO)' : ''}...`);
  });

  router.get('/api/extract', (ctx) => {
    const pkg = ctx.q('pkg');
    if (!/^[A-Za-z0-9_.]+$/.test(pkg)) return ctx.json({ ok: false, err: 'pkg invalido' }, 400);
    const args = ['-Pkg', pkg];
    const nome = ctx.q('nome');
    if (nome) args.push('-Nome', nome.slice(0, 60));
    psStream(ctx, PATHS.scripts.extract, args, '>> Extraindo ' + pkg + '...');
  });

  // versoes: instalada no aparelho + do APK na pasta
  router.get('/api/versions', async (ctx) => {
    const apks = readJsonFile(path.join(PATHS.apks, '_versoes.json'), {});
    const pkgs = ctx.q('pkgs').split(',').filter((p) => /^[A-Za-z0-9_.]+$/.test(p));
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!pkgs.length || !serial) return ctx.json({ installed: {}, apks });

    const cmd = 'for p in ' + pkgs.join(' ') +
      '; do echo "V:$p $(dumpsys package $p 2>/dev/null | grep -m1 versionName)$(dumpsys package $p 2>/dev/null | grep -m1 versionCode)"; done';
    const { all } = await adb.shell(serial, cmd, { timeout: 60000 });
    const installed = {};
    all.split(/\r?\n/).forEach((l) => {
      const m = l.match(/^V:(\S+)\s/); if (!m) return;
      const vn = (l.match(/versionName=(\S+)/) || [])[1] || '';
      const vc = (l.match(/versionCode=(\d+)/) || [])[1] || '';
      if (vn || vc) installed[m[1]] = { versionName: vn, versionCode: vc };
    });
    ctx.json({ installed, apks });
  });

  // enxuga o bundle do Facebook (remove splits opcionais de IA/camera)
  router.any('/api/trim-facebook', (ctx) => {
    const bdir = path.join(PATHS.apks, 'facebook-bundle');
    try {
      const optional = /^split_(pytorch|papaya|s_papaya)/i;
      let freed = 0, n = 0;
      const out = [];
      for (const f of fs.readdirSync(bdir)) {
        if (!optional.test(f)) continue;
        const fp = path.join(bdir, f);
        freed += fs.statSync(fp).size;
        fs.unlinkSync(fp);
        out.push('removido: ' + f);
        n++;
      }
      ctx.json({ ok: true, removed: n, freedMB: util.bytesToMB(freed), files: out });
    } catch (e) { ctx.json({ ok: false, err: e.message }); }
  });

  // ================================================================ clones ==
  // (O "Clone App" (com.pengyou.cloneapp) foi retirado do painel a pedido do
  //  usuario. Os clones que continuam aqui sao os PERFIS DE TRABALHO do
  //  Android - Island e o clonador nativo do realme - que sao outra coisa.)

  // perfis de trabalho (Island) e os apps gerenciados neles
  router.get('/api/clones', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ profiles: [] });
    const MANAGED = ['com.whatsapp', 'com.whatsapp.w4b', 'org.telegram.messenger', 'org.telegram.messenger.web'];
    const users = await adb.shell(serial, 'pm list users', { timeout: 25000 });
    const ids = [];
    const re = /UserInfo\{(\d+):([^:]*):/g;
    let m;
    while ((m = re.exec(users.all))) {
      if (m[1] !== '0') ids.push({ user: m[1], name: (m[2] || '').trim() || ('Perfil ' + m[1]) });
    }
    const profiles = [];
    for (const pf of ids) {
      const r = await adb.shell(serial, `pm list packages --user ${pf.user}`, { timeout: 30000 });
      const set = new Set(r.all.split(/\r?\n/).map((l) => l.replace('package:', '').trim()).filter(Boolean));
      pf.pkgs = MANAGED.filter((p) => set.has(p));
      if (pf.pkgs.length) profiles.push(pf);
    }
    ctx.json({ profiles });
  });

  // ============================================================ diagnostico =
  router.get('/api/diag', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ err: 'sem-adb' });
    const info = await adb.deviceInfo(serial);
    ctx.json({
      manufacturer: info.manufacturer, model: info.model, android: info.android, sdk: info.sdk,
      rom: info.rom, abi: info.abi, serial: info.hwSerial || serial,
      uptimeSec: info.uptimeSec,
      battery: {
        level: String(info.battery.level || ''), health: info.battery.health,
        status: info.battery.status, tempC: info.battery.tempC, tech: '',
      },
      ram: info.ram, storage: info.storage,
      resolution: info.resolution, density: info.density,
    });
  });

  // espelho por screencap (agora e o FALLBACK do espelhamento por scrcpy)
  router.get('/api/screen', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ ok: false, err: 'ADB nao encontrado' });
    const shot = await capture.grabPng(serial);
    if (!shot.ok) return ctx.json({ ok: false, err: shot.err });
    ctx.send(200, 'image/png', shot.buffer, { 'Cache-Control': 'no-store' });
  });

  // =========================================================== permissoes ===
  router.get('/api/perms-bulk', (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const pkg = ctx.q('pkg');
    const action = ctx.q('action');
    if (!serial) return ctx.json({ ok: false, err: 'nenhum aparelho' }, 400);
    if (!/^[A-Za-z0-9_.]+$/.test(pkg) || !['grant', 'revoke'].includes(action)) {
      return ctx.json({ ok: false, err: 'parametros invalidos' }, 400);
    }
    const loop = PERMS.map((pm) =>
      `pm ${action} ${pkg} android.permission.${pm} >/dev/null 2>&1 && echo "[ok] ${pm}" || echo "[--] ${pm}"`).join('; ');
    // alguns ROMs (MIUI, ColorOS) bloqueiam pm grant sem "Depuracao USB (Config. de seguranca)"
    const cmd = `PROBE=$(pm ${action} ${pkg} android.permission.CAMERA 2>&1); case "$PROBE" in *RUNTIME_PERMISSIONS*) echo "[!] ADB sem permissao p/ alterar permissoes neste aparelho. Xiaomi/MIUI: ligue 'Depuracao USB (Config. de seguranca)' nas Opcoes do desenvolvedor e tente de novo.";; *) ${loop};; esac`;
    shellStream(ctx, serial, cmd,
      `>> ${action === 'grant' ? 'Concedendo' : 'Revogando'} permissoes de ${pkg}...`);
  });

  router.get('/api/perms-all', (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.json({ ok: false, err: 'nenhum aparelho' }, 400);
    const scope = ctx.q('scope') === 'all' ? '' : '-3';
    const permList = PERMS.join(' ');
    // itera TODOS os perfis (0 = principal; >0 = clones do Island / clone nativo)
    const inner = `N=0; for u in $(pm list users | grep UserInfo | sed 's/[^0-9]*\\([0-9][0-9]*\\).*/\\1/'); do for p in $(pm list packages ${scope} --user $u | sed 's/^package://'); do for perm in ${permList}; do pm grant --user $u "$p" android.permission.$perm >/dev/null 2>&1; done; N=$((N+1)); if [ "$u" = "0" ]; then echo "[ok] $p"; else echo "[ok] (clone user $u) $p"; fi; done; done; echo ">> Concluido: $N app(s) em todos os perfis (principal + clones Island/nativo)."`;
    const cmd = `FIRST=$(pm list packages ${scope} | sed -n '1s/^package://p'); PROBE=$(pm grant "$FIRST" android.permission.CAMERA 2>&1); case "$PROBE" in *RUNTIME_PERMISSIONS*) echo "[!] O aparelho bloqueou a alteracao de permissoes via ADB. realme/ColorOS: ligue 'Depuracao USB (Config. de seguranca)' nas Opcoes do desenvolvedor e tente de novo.";; *) ${inner};; esac`;
    shellStream(ctx, serial, cmd,
      `>> Concedendo permissoes comuns a todos os apps${scope === '' ? ' (todos)' : ' (terceiros)'}...`);
  });

  // ============================================================== catalogo ==
  router.get('/api/catalog', (ctx) => ctx.json(readCatalogObj()));

  router.post('/api/catalog-add', async (ctx) => {
    const { pkg, name, cat } = await ctx.body();
    if (!/^[A-Za-z0-9_.]+$/.test(pkg || '')) return ctx.json({ ok: false, err: 'pkg invalido' }, 400);
    const nm = ((name || pkg).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60)) || pkg;
    const c = readCatalogObj();
    c.custom = c.custom || [];
    const e = c.custom.find((a) => a.id === pkg);
    if (e) { e.name = nm; if (cat) e.cat = String(cat).slice(0, 30); }
    else c.custom.push({ id: pkg, name: nm, cat: cat ? String(cat).slice(0, 30) : 'Outros', pkgs: [pkg], apk: nm + '.apk', bundle: nm + '-bundle', custom: true });
    fs.writeFileSync(PATHS.catalog, JSON.stringify(c, null, 2), 'utf8');
    ctx.json({ ok: true, total: c.custom.length });
  });

  router.post('/api/catalog-remove', async (ctx) => {
    const { id } = await ctx.body();
    const c = readCatalogObj();
    c.custom = (c.custom || []).filter((a) => a.id !== id);
    fs.writeFileSync(PATHS.catalog, JSON.stringify(c, null, 2), 'utf8');
    ctx.json({ ok: true });
  });
}

module.exports = { register, PERMS, VALID_SKIP, BUILTIN_APP };
