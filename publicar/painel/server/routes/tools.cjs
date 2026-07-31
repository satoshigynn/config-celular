// ============================================================================
//  routes/tools.cjs - ferramentas ADB: reinicio, apps, shell e comandos
// ============================================================================
'use strict';

const path = require('path');
const { PATHS, ADB, util, stream, logs, run } = require('../core.cjs');
const adb = require('../adb.cjs');

const log = logs.create('rotas:ferramentas');
const FASTBOOT = path.join(PATHS.platformTools, 'fastboot.exe');

const REBOOT_MODES = {
  normal: [],
  recovery: ['recovery'],
  bootloader: ['bootloader'],
  fastboot: ['fastboot'],
  sideload: ['sideload'],
};

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Executa uma acao de pacote em lote, transmitindo o resultado por SSE.
async function bulkPackageAction(ctx, label, build, verify) {
  const serial = adb.registry.resolve(ctx.q('serial'));
  const es = ctx.sse();
  if (!serial) { es.line('[!] Nenhum aparelho selecionado.'); return es.done(1); }

  const user = /^\d+$/.test(ctx.q('user')) ? ctx.q('user') : '0';
  const pkgs = ctx.q('pkgs').split(',').map((s) => s.trim()).filter((p) => util.isPkg(p));
  if (!pkgs.length) { es.line('[!] Nenhum pacote valido informado.'); return es.done(1); }

  es.line(`>> ${label}: ${pkgs.length} app(s) (perfil ${user})...`);
  let ok = 0;
  for (const pkg of pkgs) {
    if (es.closed) break;
    const { all } = await adb.shell(serial, build(pkg, user), { timeout: 60000 });
    const line = all.replace(/\s+/g, ' ').trim();
    const good = verify(line);
    if (good) ok++;
    es.line(`  ${good ? '[ok]' : '[!]'} ${pkg}${good ? '' : ' - ' + (line || 'falhou')}`);
  }
  es.line(`>> ${label}: ${ok}/${pkgs.length} concluido(s).`);
  es.done(ok === pkgs.length ? 0 : 1);
}

function register(router) {
  // ------------------------------------------------------------- reiniciar --
  router.any('/api/tools/reboot', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const mode = ctx.q('mode', 'normal');
    const extra = REBOOT_MODES[mode];
    if (!extra) return ctx.fail('modo invalido: ' + mode);
    log.info(`reiniciando ${serial} em modo ${mode}`);
    const r = await adb.exec(serial, ['reboot'].concat(extra), { timeout: 15000 });
    ctx.ok({ mode, out: ((r.stdout || '') + (r.stderr || '')).trim() });
  });

  // fastboot: apenas leitura e reinicio (nada de flash pelo painel)
  router.any('/api/tools/fastboot', async (ctx) => {
    const action = ctx.q('action', 'devices');
    const map = { devices: ['devices'], reboot: ['reboot'], 'reboot-bootloader': ['reboot-bootloader'], vars: ['getvar', 'all'] };
    if (!map[action]) return ctx.fail('acao invalida');
    const r = await run(FASTBOOT, map[action], { timeout: 25000 });
    ctx.ok({ action, out: ((r.stdout || '') + (r.stderr || '')).trim() || '(sem saida)' });
  });

  // --------------------------------------------------------------- pacotes --
  router.get('/api/tools/apps', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const user = /^\d+$/.test(ctx.q('user')) ? ctx.q('user') : '0';
    const cmd = [
      'echo @@ALL', `pm list packages --user ${user}`,
      'echo @@THIRD', `pm list packages -3 --user ${user}`,
      'echo @@DISABLED', `pm list packages -d --user ${user}`,
    ].join('; ');
    const { all } = await adb.shell(serial, cmd, { timeout: 45000 });

    const section = (name) => {
      const part = all.split('@@' + name)[1] || '';
      return part.split('@@')[0].split(/\r?\n/)
        .map((l) => l.replace('package:', '').trim()).filter((p) => util.isPkg(p));
    };
    const allPkgs = section('ALL');
    const third = new Set(section('THIRD'));
    const disabled = new Set(section('DISABLED'));
    const apps = [...new Set(allPkgs)].sort().map((pkg) => ({
      pkg, third: third.has(pkg), system: !third.has(pkg), disabled: disabled.has(pkg),
    }));
    ctx.json({ ok: true, serial, user, total: apps.length, apps });
  });

  router.get('/api/tools/uninstall', (ctx) => bulkPackageAction(
    ctx, 'Desinstalando',
    (pkg, user) => ctx.qBool('keepData')
      ? `pm uninstall -k --user ${user} ${pkg}`
      : `pm uninstall --user ${user} ${pkg}`,
    (out) => /Success/i.test(out)
  ));

  router.get('/api/tools/disable', (ctx) => bulkPackageAction(
    ctx, 'Desativando',
    (pkg, user) => `pm disable-user --user ${user} ${pkg}`,
    (out) => /new state|disabled/i.test(out)
  ));

  router.get('/api/tools/enable', (ctx) => bulkPackageAction(
    ctx, 'Reativando',
    (pkg, user) => `cmd package install-existing --user ${user} ${pkg} 2>/dev/null; pm enable --user ${user} ${pkg}`,
    (out) => /new state|enabled|installed/i.test(out)
  ));

  router.get('/api/tools/clear', (ctx) => bulkPackageAction(
    ctx, 'Limpando dados',
    (pkg, user) => `pm clear --user ${user} ${pkg}`,
    (out) => /Success/i.test(out)
  ));

  // cache de TODOS os apps (nao apaga dados/logins)
  router.any('/api/tools/trim-caches', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const before = await adb.shell(serial, 'df /data | tail -1');
    await adb.shell(serial, 'pm trim-caches 999G', { timeout: 120000 });
    const after = await adb.shell(serial, 'df /data | tail -1');
    const free = (s) => Number((s.match(/\S+\s+\d+\s+\d+\s+(\d+)/) || [])[1] || 0);
    const gained = Math.max(0, free(after.all) - free(before.all));
    ctx.ok({ freedMB: (gained / 1024).toFixed(1) });
  });

  // ------------------------------------------------------ comandos e shell --
  // Comando unico: devolve a saida em JSON (usado pelo campo "executar").
  router.any('/api/tools/exec', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const cmd = (ctx.method === 'POST' ? (await ctx.body()).cmd : ctx.q('cmd')) || '';
    if (!cmd.trim()) return ctx.fail('comando vazio');
    if (cmd.length > 4000) return ctx.fail('comando muito longo');

    const t0 = Date.now();
    // "adb ..." roda o comando no PC; qualquer outra coisa roda no aparelho
    const isAdb = /^adb\s+/i.test(cmd.trim());
    let out;
    if (isAdb) {
      const argv = cmd.trim().replace(/^adb\s+/i, '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      const clean = argv.map((a) => a.replace(/^["']|["']$/g, ''));
      const r = await adb.exec(serial, clean, { timeout: 120000 });
      out = ((r.stdout || '') + (r.stderr || ''));
    } else {
      const r = await adb.shell(serial, cmd, { timeout: 120000 });
      out = r.all;
    }
    ctx.ok({ cmd, ms: Date.now() - t0, out: out.slice(0, 200000) });
  });

  // logcat ao vivo (SSE) - util para diagnostico
  router.get('/api/tools/logcat', (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    const es = ctx.sse();
    if (!serial) { es.line('[!] Nenhum aparelho selecionado.'); return es.done(1); }
    const level = ['V', 'D', 'I', 'W', 'E'].includes(ctx.q('level')) ? ctx.q('level') : 'I';
    const filter = ctx.q('filter');

    es.line(`>> logcat ${serial} (nivel ${level})...`);
    const args = ['-s', serial, 'logcat', '-v', 'brief', '*:' + level];
    const h = stream(ADB, args, {}, (line, kind, code) => {
      if (line === null) return es.done(code);
      if (filter && !line.toLowerCase().includes(filter.toLowerCase())) return;
      es.line(line);
    });
    es.onClose(() => h.kill());
  });

  // ------------------------------------------------------------------ tela --
  // Alterar a resolucao/densidade REAL do aparelho (diferente do espelho).
  router.any('/api/tools/wm', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const action = ctx.q('action');
    let cmd;
    if (action === 'size') {
      const v = ctx.q('value');
      if (!/^\d{3,5}x\d{3,5}$/.test(v)) return ctx.fail('use o formato 1080x2400');
      cmd = `wm size ${v}`;
    } else if (action === 'density') {
      const v = ctx.qInt('value', 0);
      if (v < 80 || v > 900) return ctx.fail('densidade fora do intervalo (80-900)');
      cmd = `wm density ${v}`;
    } else if (action === 'reset') {
      cmd = 'wm size reset; wm density reset';
    } else return ctx.fail('acao invalida');

    await adb.shell(serial, cmd, { timeout: 20000 });
    const { all } = await adb.shell(serial, 'wm size; wm density');
    ctx.ok({ out: all.trim() });
  });
}

// ------------------------------------------------------- shell interativo ---
// WebSocket /ws/shell: mantem um 'adb shell' vivo e transmite entrada/saida.
function attachShell(conn, url) {
  const serial = adb.registry.resolve(url.searchParams.get('serial') || '');
  if (!serial) {
    conn.sendJson({ t: 'error', message: 'nenhum aparelho selecionado' });
    return conn.close(1008, 'sem aparelho');
  }
  const { spawn } = require('child_process');
  let child;
  try {
    child = spawn(ADB, ['-s', serial, 'shell'], { windowsHide: true });
  } catch (e) {
    conn.sendJson({ t: 'error', message: e.message });
    return conn.close(1011, 'falhou');
  }

  conn.sendJson({ t: 'ready', serial, note: 'shell do aparelho (sem TTY: programas interativos como top -i nao funcionam)' });

  const pipe = (kind) => (b) => conn.sendJson({ t: 'out', kind, data: b.toString('utf8') });
  child.stdout.on('data', pipe('out'));
  child.stderr.on('data', pipe('err'));
  child.on('close', (code) => {
    conn.sendJson({ t: 'exit', code });
    conn.close(1000, 'shell encerrado');
  });

  conn.on('json', (m) => {
    if (!m) return;
    if (m.t === 'in' && typeof m.data === 'string') {
      try { child.stdin.write(m.data.endsWith('\n') ? m.data : m.data + '\n'); } catch (_) { }
    } else if (m.t === 'signal') {
      try { child.kill(); } catch (_) { }
    }
  });
  conn.on('close', () => { try { child.kill(); } catch (_) { } });
}

module.exports = { register, attachShell };
