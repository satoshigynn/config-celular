/* ==========================================================================
   main.js - inicializacao
   Carrega preferencias, monta o shell, registra as telas e liga o tempo real.
   ========================================================================== */

import { toast } from './core/kit.js';
import { api } from './core/api.js';
import { store, startRealtime, bus } from './core/state.js';
import { buildShell, registerView, theme, registerCommand, go } from './core/shell.js';
import { logLine } from './core/tasks.js';
import mirrordock from './core/mirrordock.js';

import { devicesView } from './views/devices.js';
import { mirrorView } from './views/mirror.js';
import { setupView } from './views/setup.js';
import { appsView } from './views/apps.js';
import { captureView } from './views/capture.js';
import { filesView } from './views/files.js';
import { toolsView } from './views/tools.js';
import { advancedView } from './views/advanced.js';
import { helpView } from './views/help.js';
import { settingsView } from './views/settings.js';

async function boot() {
  // 1. preferencias primeiro, para o tema nao "piscar"
  try {
    const r = await api.get('/api/settings');
    store.set({ settings: r.settings });
    theme.apply(r.settings);
    const m = r.settings.mirror || {};
    mirrordock.ensure({ maxSize: m.maxSize, bitrate: m.bitrate, maxFps: m.maxFps, codec: m.codec });
    mirrordock.setAuto(m.autoStart !== false);
  } catch (e) {
    theme.apply({ theme: 'dark', accent: 'coral' });
    console.warn('nao consegui ler as preferencias:', e.message);
  }

  // 2. telas, na ordem em que aparecem no menu
  [devicesView, mirrorView, setupView, appsView, captureView, filesView, toolsView,
    advancedView, helpView, settingsView].forEach(registerView);

  registerCommand({
    label: 'Recarregar o painel', icon: 'refresh', hint: 'F5',
    run: () => location.reload(),
  });

  // 3. shell + roteador
  buildShell();
  const bootScreen = document.getElementById('boot');
  if (bootScreen) { bootScreen.style.opacity = '0'; setTimeout(() => bootScreen.remove(), 260); }

  // 4. tempo real
  startRealtime();

  // 5. sinais uteis
  bus.on('connection', (ok) => {
    if (!ok) logLine('[!] Conexao com o servidor perdida - tentando reconectar...', 'err');
  });

  bus.on('devices-changed', (devices) => {
    const online = devices.filter((d) => d.state === 'device');
    if (online.length) toast(`${online.length} aparelho(s) online`, 'info', 1600);
  });

  // aviso quando o codigo do painel mudou no disco (atualizacao baixada)
  try {
    const v = await api.get('/api/version');
    const label = document.querySelector('#verLabel');
    if (label) label.textContent = 'v' + v.versao;
    if (v.stale) {
      toast('Uma atualizacao foi baixada - feche e abra o painel para aplicar', 'warn', 8000);
    }
  } catch (_) { }

  // notificacoes de tarefas longas (o usuario decide)
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => { try { Notification.requestPermission(); } catch (_) { } }, 4000);
  }
}

boot().catch((e) => {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:Segoe UI,sans-serif;color:#e8eaed;background:#16181d;height:100vh">' +
    '<h1>Nao consegui iniciar o painel</h1><p style="color:#9aa3af">' + String(e.message || e) + '</p>' +
    '<p style="color:#9aa3af">Feche a janela preta do painel e abra de novo.</p></div>';
  console.error(e);
});
