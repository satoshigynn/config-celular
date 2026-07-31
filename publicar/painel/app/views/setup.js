/* ==========================================================================
   views/setup.js - Configurar celular (o fluxo do setup-celular.ps1)
   Mesmas etapas, presets e avisos da versao anterior.
   A ACAO PRINCIPAL fica no cabecalho da tela, que gruda no topo: nao precisa
   rolar ate o fim da pagina para achar o botao de executar.
   ========================================================================== */

import { h, mount, clear, toast, confirmBox } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, hasDevice } from '../core/state.js';
import { go, toggleDock } from '../core/shell.js';
import { runTask, isBusy, taskBus, logLine } from '../core/tasks.js';
import { card, btn, chip, field, needDevice } from '../ui/widgets.js';

// A lista manda os flags das etapas DESLIGADAS para o setup-celular.ps1.
// Consequencia de tirar uma etapa daqui: o flag nunca e enviado, entao ela
// passa a rodar SEMPRE. E o caso de "Deixar mais rapido" (-SkipSpeed): saiu da
// lista e agora e automatica, porque desligar as animacoes e pre-requisito do
// espelhamento - o overlay falha enquanto a tela anima.
const STEPS = [
  { flag: 'SkipDebloat', ic: '🧹', t: 'Remover bloatware', d: 'Apps de fabrica, jogos e lixo (auto-deteccao)', hdr: 'Debloat' },
  { flag: 'SkipApks', ic: '📦', t: 'Instalar APKs', d: 'Pasta /apks: WhatsApp, WA Business, Telegram, Island', hdr: 'Instalando APKs' },
  { flag: 'SkipBusiness', ic: '🏪', t: 'WA Business (loja)', d: 'Garante via loja se o APK nao couber na arquitetura', hdr: 'WhatsApp Business (loja)' },
  { flag: 'SkipIsland', ic: '🏝️', t: 'Island + clones', d: 'Perfil de trabalho: WhatsApp, WA Business, Telegram', hdr: 'Island: perfil' },
  { flag: 'SkipTheme', ic: '🌙', t: 'Tema escuro', d: 'Ativa o modo noturno do sistema', hdr: 'Tema escuro' },
  { flag: 'SkipMirror', ic: '🖥️', t: 'Espelhamento scrcpy', d: 'Mantem a tela ativa e confere teclado/toque virtuais (UHID)', hdr: 'Preparar para espelhamento' },
  { flag: 'SkipNativeClone', ic: '👯', t: 'Clonador nativo', d: 'Clona WhatsApp e WA Business (realme)', hdr: 'Clonador nativo' },
  { flag: 'SkipSuggestions', ic: '🚫', t: 'Sugestoes de app off', d: 'Desliga "Mostrar aplicativos sugeridos"', hdr: 'Mostrar aplicativos sugeridos' },
  { flag: 'SkipPerms', ic: '🔐', t: 'Permitir tudo nos apps', d: 'Camera, contatos, midia, SMS... para todos os apps e clones', hdr: 'Permiss' },
  { flag: 'SkipBattery', ic: '🔋', t: 'Manter apps vivos', d: 'Ignora a economia de bateria para nao parar em 2o plano', hdr: 'Manter apps' },
];

const PRESETS = {
  full: STEPS.map((s) => s.flag),
  clean: ['SkipDebloat', 'SkipTheme', 'SkipSuggestions', 'SkipMirror'],
  apps: ['SkipApks', 'SkipBusiness', 'SkipIsland', 'SkipNativeClone'],
};

let checks = new Map();
let statEls = new Map();
let dryRun = false;
let curStep = null;
let unsub = [];
let controls = null;
let currentTaskRef = null;

/* ------------------------------------------------------------ progresso -- */
function setStat(flag, symbol, cls) {
  const el = statEls.get(flag);
  if (!el) return;
  el.textContent = symbol;
  el.className = 'step__stat ' + (cls || '');
}
function resetStats() {
  curStep = null;
  for (const s of STEPS) setStat(s.flag, '');
}
// acompanha os cabecalhos "== ... ==" do script para marcar a etapa atual
function trackProgress(line) {
  const m = line.match(/^==\s*(.+?)\s*==/);
  if (!m) return;
  const done = () => { if (curStep) { setStat(curStep, '✓', 'ok'); curStep = null; } };
  if (/Resumo final/i.test(m[1])) return done();
  const st = STEPS.find((s) => s.hdr && m[1].indexOf(s.hdr) >= 0);
  if (st) { done(); curStep = st.flag; setStat(curStep, '⏳', 'warn'); }
}

/* --------------------------------------------------- acao principal ------ */
function buildControls() {
  if (controls) return controls;
  const dryInput = h('input', {
    type: 'checkbox', checked: dryRun,
    onchange: (e) => { dryRun = e.target.checked; syncButtons(); },
  });
  const runBtn = btn('Configurar celular', { variant: 'primary', icon: 'play', onClick: run });
  const stopBtn = btn('Parar', { icon: 'stop', disabled: true, onClick: () => currentTaskRef?.cancel() });
  const dryLabel = h('label.check', { title: 'So mostra o que faria, sem alterar o celular' },
    dryInput, 'Simular (dry-run)');
  controls = { dryInput, dryLabel, runBtn, stopBtn };
  return controls;
}

function syncButtons() {
  if (!controls) return;
  const busy = isBusy();
  controls.runBtn.disabled = busy || !hasDevice();
  controls.stopBtn.disabled = !busy;
  clear(controls.runBtn);
  controls.runBtn.append(
    icon(busy ? 'refresh' : 'play', 16),
    busy ? 'Executando...' : (dryRun ? 'Simular configuracao' : 'Configurar celular')
  );
}

async function run() {
  const serial = currentSerial();
  if (!serial) return toast('Conecte o celular primeiro', 'warn');

  const skip = [...checks.entries()].filter(([, input]) => !input.checked).map(([flag]) => flag);
  if (skip.length === STEPS.length) return toast('Ligue ao menos uma etapa', 'warn');

  // preflight: bateria, tela bloqueada, Wi-Fi
  try {
    const pf = await api.get('/api/preflight', { serial });
    const warns = [];
    if (pf.locked) warns.push('A tela parece BLOQUEADA - desbloqueie o celular (a automacao de UI pode falhar).');
    if (pf.battery && Number(pf.battery) < 20) warns.push(`Bateria baixa (${pf.battery}%).`);
    if (pf.wifi === false) warns.push('Sem Wi-Fi - downloads da loja usarao dados moveis.');
    if (warns.length && !await confirmBox('Atencao antes de configurar',
      warns.map((w) => '- ' + w).join('\n') + '\n\nContinuar mesmo assim?', { okLabel: 'Continuar' })) return;
  } catch (_) { }

  // previa do debloat
  if (!skip.includes('SkipDebloat') && !dryRun) {
    try {
      const pv = await api.get('/api/debloat-preview', { serial });
      const t = pv.targets || [];
      if (t.length) {
        const list = t.slice(0, 40).join('\n') + (t.length > 40 ? `\n...(+${t.length - 40} apps)` : '');
        const ok = await confirmBox(`Remover ${t.length} app(s)?`,
          'O debloat vai remover:\n\n' + list, { danger: true, okLabel: 'Remover', wide: true });
        if (!ok) return;
      }
    } catch (_) { }
  }

  resetStats();
  toggleDock(true);
  currentTaskRef = runTask({
    title: 'Configuracao do celular' + (dryRun ? ' (simulacao)' : ''),
    path: '/api/run',
    params: { serial, skip: skip.join(','), dry: dryRun ? 1 : 0 },
    onLine: trackProgress,
  });
  currentTaskRef.promise.then(() => { curStep = null; syncButtons(); });
  syncButtons();
}

/* ---------------------------------------------------------------- cards -- */
function stepsCard() {
  const list = h('div');
  checks = new Map();
  statEls = new Map();

  for (const s of STEPS) {
    const input = h('input', { type: 'checkbox', checked: true, 'data-flag': s.flag });
    const stat = h('span.step__stat');
    checks.set(s.flag, input);
    statEls.set(s.flag, stat);
    list.appendChild(h('label.step', {},
      h('span.step__ic', {}, s.ic),
      h('span.step__tx', {}, h('b', {}, s.t), h('small', {}, s.d)),
      stat,
      h('span.switch', {}, input, h('i'))
    ));
  }

  const preset = (name) => {
    const on = PRESETS[name] || [];
    for (const [flag, input] of checks) input.checked = on.includes(flag);
    toast('Perfil: ' + ({ full: 'Completo', clean: 'Celular cru', apps: 'So apps' }[name] || name), 'info', 1500);
  };
  const setAll = (v) => { for (const input of checks.values()) input.checked = v; };

  return card('Etapas da configuracao', {
    subtitle: 'Ligue apenas o que quiser executar.',
    actions: [
      btn('Completo', { small: true, onClick: () => preset('full') }),
      btn('Celular cru', { small: true, onClick: () => preset('clean') }),
      btn('So apps', { small: true, onClick: () => preset('apps') }),
      btn('Todas', { small: true, onClick: () => setAll(true) }),
      btn('Nenhuma', { small: true, onClick: () => setAll(false) }),
    ],
    foot: h('div.stack', { style: { gap: '4px' } },
      h('span.small.muted', {},
        'As animacoes do sistema sao sempre desativadas: e pre-requisito do espelhamento.'),
      h('span.small.muted', {},
        'O log completo aparece na doca a direita (Ctrl+L). Cada execucao tambem e gravada em logs\\.')),
  }, list);
}

function displayCard() {
  const adaptive = h('input', { type: 'checkbox', onchange: () => sync() });
  const range = h('input', { type: 'range', min: '0', max: '100', value: '100', oninput: () => sync() });
  const value = h('b', { style: { minWidth: '46px', textAlign: 'right' } }, '100%');
  const timeout = h('select.select', {},
    ...[[15000, '15 segundos'], [30000, '30 segundos'], [60000, '1 minuto'], [120000, '2 minutos'],
    [300000, '5 minutos'], [600000, '10 minutos'], [1800000, '30 minutos'], [2147483647, 'Nunca']]
      .map(([v, l]) => h('option', { value: v, selected: v === 300000 }, l)));
  const row = h('div.hstack', {}, h('span.small.muted', { style: { minWidth: '52px' } }, 'Brilho'), range, value);

  function sync() {
    value.textContent = range.value + '%';
    range.disabled = adaptive.checked;
    row.style.opacity = adaptive.checked ? '.45' : '1';
  }
  sync();

  return card('Brilho e tela', {
    subtitle: 'Aplicado direto no aparelho, sem rodar o setup inteiro.',
    actions: [btn('Aplicar agora', {
      variant: 'primary', small: true, icon: 'check',
      onClick: async () => {
        const serial = currentSerial();
        if (!serial) return toast('Conecte o celular primeiro', 'warn');
        try {
          const r = await api.get('/api/display', {
            serial,
            adaptive: adaptive.checked ? '1' : '0',
            bright: Math.round((Number(range.value) / 100) * 255),
            timeout: timeout.value,
          });
          if (!r.ok) return toast(r.err || 'falhou', 'err');
          const min = Math.round((Number(r.timeout) || 0) / 60000 * 10) / 10;
          logLine('== Brilho e tela ==', 'head');
          logLine(`  adaptativo: ${r.mode === '1' ? 'ligado' : 'desligado'} - brilho: ${r.brightness || '?'}/255 - apagar: ${isFinite(min) ? min + ' min' : '-'}`, 'ok');
          toast('Tela ajustada', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
    })],
  },
    h('div.stack', {},
      h('label.check', {}, adaptive, 'Brilho adaptativo (automatico)'),
      row,
      field('Apagar a tela apos', timeout)
    )
  );
}

/* ------------------------------------------------------------------ view - */
export const setupView = {
  id: 'setup',
  title: 'Configurar',
  subtitle: 'Limpeza, apps, clones e ajustes em um clique',
  icon: 'setup',
  group: 'acoes',

  // acao principal no cabecalho grudado: sempre visivel, sem rolar
  actions: () => {
    const c = buildControls();
    setTimeout(syncButtons, 0);
    return [c.dryLabel, c.stopBtn, c.runBtn];
  },

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    unsub.forEach((f) => f());
    unsub = [taskBus.on('change', syncButtons)];

    const tool = (label, iconName, fn) => btn(label, { small: true, icon: iconName, onClick: fn });

    mount(root,
      stepsCard(),
      displayCard(),
      card('Ferramentas do setup', {},
        h('div.btnrow', {},
          tool('Ver estado atual', 'eye', () => {
            resetStats();
            toggleDock(true);
            runTask({
              title: 'Ver estado atual', path: '/api/run',
              params: { serial: currentSerial(), skip: STEPS.map((s) => s.flag).join(','), dry: 0 },
              onLine: trackProgress,
            });
          }),
          tool('Atualizar APKs', 'download', () => {
            toggleDock(true);
            runTask({ title: 'Atualizar APKs oficiais', path: '/api/update-apks' });
          }),
          tool('Restaurar removidos', 'refresh', async () => {
            if (!await confirmBox('Restaurar apps', 'Restaurar os apps que o debloat removeu deste aparelho?')) return;
            toggleDock(true);
            runTask({ title: 'Restaurar apps removidos', path: '/api/restore' });
          }),
          tool('Atualizar sistema', 'upload', async () => {
            try {
              const r = await api.get('/api/sysupdate', { serial: currentSerial() });
              if (r.ok) toast('Tela de atualizacao aberta no celular', 'ok');
              else toast(r.err || 'falhou', 'err');
            } catch (e) { toast(e.message, 'err'); }
          }),
          tool('Permitir tudo nos apps', 'shield', async () => {
            if (!await confirmBox('Conceder permissoes',
              'Conceder as permissoes comuns (camera, microfone, contatos, localizacao, armazenamento, telefone, SMS, notificacoes) a TODOS os apps de terceiros - no perfil principal E nos clones?\n\n' +
              'Alguns aparelhos (realme/ColorOS, Xiaomi/MIUI) exigem "Depuracao USB (Config. de seguranca)" ligada.')) return;
            toggleDock(true);
            runTask({ title: 'Conceder permissoes a todos os apps', path: '/api/perms-all', params: { serial: currentSerial(), scope: 3 } });
          }),
          tool('Enxugar Facebook', 'broom', async () => {
            if (!await confirmBox('Enxugar o Facebook',
              'Remove os splits opcionais de IA/camera (pytorch/papaya) do facebook-bundle, liberando espaco. O app continua funcional para a maioria dos usos.')) return;
            try {
              const r = await api.get('/api/trim-facebook');
              if (!r.ok) return toast(r.err || 'falhou', 'err');
              (r.files || []).forEach((f) => logLine('  ' + f));
              logLine(`>> ${r.removed} arquivo(s) removido(s), ${r.freedMB} MB liberados.`, 'ok');
              toast(`Facebook enxugado (${r.freedMB} MB)`, 'ok');
            } catch (e) { toast(e.message, 'err'); }
          })
        )
      )
    );

    syncButtons();
  },

  destroy() { unsub.forEach((f) => f()); unsub = []; },

  commands: [
    { label: 'Configurar o celular (setup completo)', icon: 'setup', run: () => go('setup') },
  ],
};
