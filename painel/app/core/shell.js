/* ==========================================================================
   shell.js - o esqueleto da aplicacao
   --------------------------------------------------------------------------
   Sidebar + barra superior + area de conteudo + doca de log, mais o roteador,
   a paleta de comandos (Ctrl+K) e os atalhos de teclado.
   ========================================================================== */

import { h, mount, clear, $, toast, confirmBox } from './kit.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { store, bus, currentDevice, onlineDevices, selectDevice, hasDevice } from './state.js';
import { taskBus, isBusy, currentTask, createLogPane, clearLog, downloadLog, pending, runTask } from './tasks.js';
import mirrordock from './mirrordock.js';
import updatebar from './updatebar.js';

const views = new Map();
const commands = [];
let currentView = null;
let currentRoute = { id: 'devices', params: {} };
let viewHost = null;
let dockEl = null;

/* ------------------------------------------------------------------ tema --- */
export const theme = {
  apply(settings) {
    const root = document.documentElement;
    const s = settings || store.get('settings') || {};
    const mode = s.theme === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : (s.theme || 'dark');
    root.dataset.theme = mode;
    root.dataset.accent = s.accent || 'coral';
    root.dataset.density = s.density || 'confortavel';
    root.dataset.animations = s.animations === false ? 'off' : 'on';
    root.dataset.watermark = s.logoWatermark || 'discreta';
    window.__painelSounds = s.sounds !== false;
  },
  async set(patch) {
    const next = Object.assign({}, store.get('settings'), patch);
    store.set({ settings: next });
    theme.apply(next);
    try { await api.post('/api/settings', patch); } catch (e) { toast(e.message, 'err'); }
  },
  toggle() {
    const cur = (store.get('settings') || {}).theme || 'dark';
    theme.set({ theme: cur === 'dark' ? 'light' : 'dark' });
  },
};

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((store.get('settings') || {}).theme === 'system') theme.apply();
});

/* --------------------------------------------------------------- registro -- */
export function registerView(view) {
  views.set(view.id, view);
  if (view.commands) commands.push(...view.commands);
}

export function registerCommand(cmd) { commands.push(cmd); }

/* ------------------------------------------------------------------ rotas -- */
export function go(id, params) {
  const target = views.has(id) ? id : 'devices';
  const hash = '#/' + target + (params ? '?' + new URLSearchParams(params) : '');
  if (location.hash === hash) render(target, params);
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, qs] = raw.split('?');
  return { id: id || 'devices', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

/** Redesenha a tela atual (usado quando o aparelho conecta/desconecta). */
export function rerender() { render(currentRoute.id, currentRoute.params); }

async function render(id, params) {
  const view = views.get(id);
  if (!view) return go('devices');
  if (currentView && currentView.destroy) { try { currentView.destroy(); } catch (e) { console.error(e); } }
  currentView = view;
  currentRoute = { id, params: params || {} };

  document.querySelectorAll('.navitem').forEach((b) => {
    b.setAttribute('aria-current', b.dataset.view === id ? 'page' : 'false');
  });
  $('#topTitle').textContent = view.title;
  document.title = view.title + ' - Config Celular';
  // o espelho fixado acompanha a troca de tela (fica na coluna, ou volta para
  // dentro da tela Espelhamento quando esta solto)
  mirrordock.refreshPlacement(id);

  clear(viewHost);
  viewHost.scrollTop = 0;
  viewHost.dataset.scrolled = '0';
  const body = h('div.view__body');
  viewHost.appendChild(h('div.view__head', {},
    h('div', {}, h('h1', {}, view.title), view.subtitle ? h('p', {}, view.subtitle) : null),
    view.actions ? h('div.view__actions', {}, ...view.actions()) : null
  ));
  viewHost.appendChild(body);

  try { await view.render(body, params || {}); }
  catch (e) {
    console.error(e);
    mount(body, h('div.empty', {}, icon('warning', 40), h('b', {}, 'Algo falhou ao abrir esta tela'), h('p', {}, e.message)));
  }
}

/* ------------------------------------------------------- paleta de comandos */
function openPalette() {
  if ($('.palette-scrim')) return;
  const input = h('input.palette__input', { placeholder: 'Buscar comando, tela ou aparelho...', 'aria-label': 'Buscar' });
  const list = h('div.palette__list');
  const scrim = h('div.scrim.palette-scrim', {}, h('div.palette', {}, input, list));

  const all = () => {
    const items = [];
    for (const v of views.values()) {
      items.push({ label: v.title, hint: v.subtitle || 'Tela', ic: v.icon, run: () => go(v.id) });
    }
    for (const d of onlineDevices()) {
      items.push({ label: d.name || d.serial, hint: 'Selecionar aparelho - ' + d.serial, ic: 'devices', run: () => selectDevice(d.serial) });
    }
    for (const c of commands) {
      if (c.when && !c.when()) continue;
      items.push({ label: c.label, hint: c.hint || 'Comando', ic: c.icon || 'bolt', run: c.run, keys: c.keys });
    }
    return items;
  };

  let filtered = [];
  let active = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    filtered = all().filter((i) => !q || (i.label + ' ' + (i.hint || '')).toLowerCase().includes(q)).slice(0, 40);
    active = Math.min(active, Math.max(0, filtered.length - 1));
    clear(list);
    if (!filtered.length) {
      list.appendChild(h('div.palette__empty', {}, 'Nada encontrado para "' + input.value + '"'));
      return;
    }
    filtered.forEach((item, i) => {
      list.appendChild(h('button.palette__item', {
        'data-active': i === active ? '1' : null,
        onmousemove: () => { if (active !== i) { active = i; draw(); } },
        onclick: () => { close(); item.run(); },
      }, icon(item.ic || 'bolt', 17),
        h('span', {}, h('b', {}, item.label), item.hint ? h('small', {}, item.hint) : null),
        item.keys ? h('kbd', {}, item.keys) : null));
    });
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, filtered.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + filtered.length) % Math.max(1, filtered.length); draw(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[active];
      if (item) { close(); item.run(); }
    }
  };

  input.addEventListener('input', () => { active = 0; draw(); });
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(scrim);
  draw();
  input.focus();
}

/* ------------------------------------------------------------- atalhos ----- */
const shortcuts = [];
export function registerShortcut(combo, description, run, opts = {}) {
  shortcuts.push({ combo: combo.toLowerCase(), description, run, allowInInput: !!opts.allowInInput });
}

function comboOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(k)) parts.push(k);
  return parts.join('+');
}

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const combo = comboOf(e);
    for (const s of shortcuts) {
      if (s.combo !== combo) continue;
      if (inField && !s.allowInInput) continue;
      e.preventDefault();
      s.run();
      return;
    }
  });
}

export function shortcutList() { return shortcuts; }

/* -------------------------------------------------------------- seletor ---- */
function deviceSelector() {
  const btn = h('button.btn.btn--ghost.btn--sm', { id: 'devPick', title: 'Aparelho ativo (Ctrl+D)' });

  const paint = () => {
    const d = currentDevice();
    const list = onlineDevices();
    clear(btn);
    btn.appendChild(h('span.dot', { class: d && d.state === 'device' ? 'dot--ok dot--live' : list.length ? 'dot--warn' : '' }));
    btn.appendChild(h('span.truncate', { style: { maxWidth: '150px' } },
      d ? (d.name || d.serial) : (store.get('devices').length ? 'Escolha um aparelho' : 'Nenhum aparelho')));
    if (d) btn.appendChild(icon(d.transport === 'wifi' ? 'wifi' : 'usb', 14));
    if (list.length > 1) btn.appendChild(h('span.chip', {}, String(list.length)));
  };

  btn.addEventListener('click', () => {
    const list = onlineDevices();
    if (!list.length) return go('devices');
    if (list.length === 1) return go('devices');
    // alterna para o proximo aparelho online
    const cur = currentDevice();
    const i = list.findIndex((d) => d.serial === (cur && cur.serial));
    selectDevice(list[(i + 1) % list.length].serial);
  });

  store.subscribe(paint);
  paint();
  return btn;
}

/* --------------------------------------------------------------- doca ------ */
function buildDock() {
  const pane = createLogPane();
  const status = h('span.chip', {}, 'ocioso');
  const stopBtn = h('button.btn.btn--sm.btn--danger', {
    disabled: true,
    onclick: () => currentTask()?.cancel(),
  }, icon('stop', 14), 'Parar');

  const refresh = () => {
    const t = currentTask();
    const q = pending();
    clear(status);
    if (t) {
      status.className = 'chip chip--accent';
      status.append(h('span.spinner'), t.title + (q ? ` (+${q} na fila)` : ''));
      stopBtn.disabled = false;
    } else {
      status.className = 'chip';
      status.textContent = 'ocioso';
      stopBtn.disabled = true;
    }
  };
  taskBus.on('change', refresh);
  refresh();

  dockEl = h('aside.dock', { id: 'dock', 'aria-label': 'Log de tarefas' },
    h('div.dock__head', {},
      icon('logs', 15), h('span', {}, 'Log ao vivo'), status,
      h('span.spacer'),
      h('button.btn.btn--quiet.btn--sm.btn--icon', { title: 'Baixar log', onclick: downloadLog }, icon('download', 14)),
      h('button.btn.btn--quiet.btn--sm.btn--icon', { title: 'Limpar', onclick: clearLog }, icon('trash', 14)),
      h('button.btn.btn--quiet.btn--sm.btn--icon', { title: 'Fechar (Ctrl+L)', onclick: () => toggleDock(false) }, icon('close', 14))
    ),
    h('div.dock__body', {}, pane),
    h('div.card__foot', {}, stopBtn)
  );
  return dockEl;
}

export function toggleDock(force) {
  const open = force === undefined ? dockEl.hasAttribute('hidden') : force;
  if (open) dockEl.removeAttribute('hidden');
  else dockEl.setAttribute('hidden', '');
  localStorage.setItem('painel.dock', open ? '1' : '0');
}

/* ------------------------------------------------------------ construcao --- */
const NAV_GROUPS = [
  { id: 'aparelho', label: 'Aparelho' },
  { id: 'acoes', label: 'Acoes' },
  { id: 'sistema', label: 'Sistema' },
];

/* -------------------------------------------------------------- marca ---- */
// Se existir um arquivo de logo em painel\app\assets\, ele substitui o icone
// padrao na barra lateral e vira o icone da aba do navegador. Nao existindo,
// o painel segue com o icone embutido - sem erro e sem quadrado quebrado.
const LOGO_CANDIDATOS = [
  '/app/assets/logo.png',
  '/app/assets/logo.webp',
  '/app/assets/logo.svg',
  '/app/assets/logo.jpg',
];

function brandMark() {
  const box = h('div.sidebar__logo', { id: 'brandMark' }, icon('devices', 18));

  const tentar = (i) => {
    if (i >= LOGO_CANDIDATOS.length) return;
    const src = LOGO_CANDIDATOS[i];
    const probe = new Image();
    probe.onload = () => {
      // 1. marca na barra lateral
      clear(box);
      box.classList.add('sidebar__logo--img');
      box.appendChild(h('img', { src, alt: 'Config Celular' }));
      // 2. icone da aba do navegador
      const link = document.querySelector('link[rel="icon"]');
      if (link) link.href = src;
      // 3. marca d'agua ao fundo da doca de log
      document.documentElement.style.setProperty('--logo-url', `url("${src}")`);
      document.documentElement.dataset.hasLogo = '1';
    };
    probe.onerror = () => tentar(i + 1);
    probe.src = src;
  };
  tentar(0);

  return box;
}

export function buildShell() {
  const app = h('div#app');

  // ---- sidebar ----
  const nav = h('nav.sidebar__nav', { 'aria-label': 'Navegacao principal' });
  for (const g of NAV_GROUPS) {
    const items = [...views.values()].filter((v) => v.group === g.id);
    if (!items.length) continue;
    nav.appendChild(h('div.sidebar__group', {}, g.label));
    for (const v of items) {
      nav.appendChild(h('button.navitem', {
        'data-view': v.id, 'aria-current': 'false', title: v.title,
        onclick: () => go(v.id),
      }, icon(v.icon, 18), h('span.navitem__label', {}, v.title)));
    }
  }

  const railBtn = h('button.navitem', { title: 'Recolher menu', onclick: () => {
    const on = app.dataset.rail === '1';
    app.dataset.rail = on ? '0' : '1';
    localStorage.setItem('painel.rail', on ? '0' : '1');
  } }, icon('sidebar', 18), h('span.navitem__label', {}, 'Recolher menu'));

  const sidebar = h('aside.sidebar', {},
    h('div.sidebar__brand', {},
      brandMark(),
      h('div.sidebar__name', {},
        h('b.brandword', {},
          h('span.brandword__a', {}, 'Config'),
          h('span.brandword__b', {}, 'Celular')),
        h('span', { id: 'verLabel' }, 'carregando...'))
    ),
    nav,
    h('div.sidebar__foot', {}, railBtn)
  );

  // ---- topbar ----
  const conn = h('span.chip', { id: 'connChip' }, 'conectando...');
  bus.on('connection', (ok) => {
    conn.className = 'chip ' + (ok ? 'chip--ok' : 'chip--err');
    clear(conn);
    conn.append(h('span.dot', { class: ok ? 'dot--ok' : 'dot--err' }), ok ? 'servidor ok' : 'servidor offline');
  });

  const topbar = h('header.topbar', {},
    h('h1.topbar__title', { id: 'topTitle' }, 'Dispositivos'),
    h('span.topbar__spacer'),
    h('button.searchbtn', { onclick: openPalette, title: 'Buscar (Ctrl+K)' },
      icon('search', 15), h('span', {}, 'Buscar comandos...'), h('kbd', {}, 'Ctrl K')),
    deviceSelector(),
    conn,
    h('button.btn.btn--quiet.btn--icon', { id: 'themeBtn', title: 'Alternar tema (Ctrl+J)', onclick: () => theme.toggle() }, icon('moon', 17)),
    h('button.btn.btn--quiet.btn--icon', {
      id: 'pinMirrorBtn', title: 'Fixar o espelho ao lado (Ctrl+M)',
      'aria-pressed': mirrordock.isPinned() ? 'true' : 'false',
      onclick: () => mirrordock.togglePin(),
    }, icon('mirror', 17)),
    h('button.btn.btn--quiet.btn--icon', { title: 'Log ao vivo (Ctrl+L)', onclick: () => toggleDock() }, icon('logs', 17))
  );

  viewHost = h('main.view', { id: 'view', tabindex: '-1', 'data-scrolled': '0' });
  // a sombra do cabecalho grudado so aparece quando ha conteudo rolado
  viewHost.addEventListener('scroll', () => {
    const on = viewHost.scrollTop > 4 ? '1' : '0';
    if (viewHost.dataset.scrolled !== on) viewHost.dataset.scrolled = on;
  }, { passive: true });
  const content = h('div.content', {}, viewHost, mirrordock.create(), buildDock());

  // A faixa de atualizacao vem ANTES da topbar: fica no alto de tudo e nao
  // depende da tela aberta. O callback e passado daqui (e nao importado la
  // dentro) para nao criar import circular shell <-> updatebar.
  const barraUpdate = updatebar.create({
    onUpdate: () => {
      toggleDock(true);
      runTask({ title: 'Atualizar programa', path: '/api/update-run' });
    },
  });

  app.appendChild(sidebar);
  app.appendChild(h('div.main', {}, barraUpdate, topbar, content));
  document.body.appendChild(app);

  if (localStorage.getItem('painel.rail') === '1') app.dataset.rail = '1';
  if (localStorage.getItem('painel.dock') === '0') dockEl.setAttribute('hidden', '');

  // icone do tema acompanha o tema atual
  const syncThemeIcon = () => {
    const btn = $('#themeBtn');
    if (!btn) return;
    clear(btn);
    btn.appendChild(icon(document.documentElement.dataset.theme === 'light' ? 'sun' : 'moon', 17));
  };
  store.on('settings', syncThemeIcon);
  new MutationObserver(syncThemeIcon).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncThemeIcon();

  // ---- atalhos globais ----
  registerShortcut('ctrl+k', 'Abrir a busca de comandos', openPalette, { allowInInput: true });
  registerShortcut('ctrl+l', 'Mostrar/ocultar o log', () => toggleDock());
  registerShortcut('ctrl+j', 'Alternar tema claro/escuro', () => theme.toggle());
  registerShortcut('ctrl+b', 'Recolher o menu lateral', () => railBtn.click());
  registerShortcut('ctrl+d', 'Trocar de aparelho', () => $('#devPick').click());
  registerShortcut('ctrl+m', 'Fixar/soltar o espelho ao lado do log', () => mirrordock.togglePin());
  registerShortcut('f1', 'Ver os atalhos', showShortcuts);
  registerShortcut('escape', 'Cancelar a tarefa atual', () => {
    if (isBusy()) currentTask()?.cancel();
  });
  initShortcuts();

  registerCommand({ label: 'Fixar/soltar o espelho ao lado do log', icon: 'mirror', keys: 'Ctrl M', run: () => mirrordock.togglePin() });
  registerCommand({ label: 'Alternar tema claro/escuro', icon: 'sun', keys: 'Ctrl J', run: () => theme.toggle() });
  registerCommand({ label: 'Mostrar/ocultar o log ao vivo', icon: 'logs', keys: 'Ctrl L', run: () => toggleDock() });
  registerCommand({ label: 'Baixar o log', icon: 'download', run: downloadLog });
  registerCommand({ label: 'Ver os atalhos de teclado', icon: 'keyboard', keys: 'F1', run: showShortcuts });

  window.addEventListener('hashchange', () => {
    const { id, params } = parseHash();
    render(id, params);
  });

  // Quando o aparelho aparece (ou some), as telas que dependem dele precisam se
  // redesenhar. Sem isso, quem abre o painel ve "conecte um aparelho" ate
  // trocar de aba, porque o primeiro snapshot chega depois do primeiro desenho.
  let lastHad = hasDevice();
  store.on('devices', () => {
    const now = hasDevice();
    if (now !== lastHad) { lastHad = now; mirrordock.refreshPlacement(); rerender(); }
  });
  store.on('selected', () => {
    lastHad = hasDevice();
    mirrordock.restart();          // trocou de aparelho: o espelho segue junto
    mirrordock.refreshPlacement();
    rerender();
  });

  // o botao da barra superior reflete o estado de fixado; quando o usuario
  // fixa/solta (pelo atalho, pela paleta ou pelo botao), a tela atual precisa
  // ser redesenhada - e ela que decide onde o espelho aparece
  let lastPinned = mirrordock.isPinned();
  mirrordock.subscribe(() => {
    const b = $('#pinMirrorBtn');
    if (b) b.setAttribute('aria-pressed', mirrordock.isPinned() ? 'true' : 'false');
    if (mirrordock.isPinned() !== lastPinned) {
      lastPinned = mirrordock.isPinned();
      rerender();
    }
  });
  mirrordock.refreshPlacement();

  const { id, params } = parseHash();
  render(id, params);
}

export function showShortcuts() {
  const rows = shortcutList().map((s) => h('div.row.row--tight', {},
    h('div.row__main', {}, h('b', {}, s.description)),
    h('kbd', {}, s.combo.split('+').map((p) => p.replace(/^./, (c) => c.toUpperCase())).join(' + '))
  ));
  rows.push(h('div.section-title', {}, 'No espelhamento'));
  [
    ['Clique / arrastar', 'Toque na tela do celular'],
    ['Roda do mouse', 'Rolar'],
    ['Botao direito', 'Voltar'],
    ['Botao do meio', 'Inicio'],
    ['Teclado', 'Digita direto no aparelho'],
    ['F11', 'Tela cheia'],
  ].forEach(([k, d]) => rows.push(h('div.row.row--tight', {}, h('div.row__main', {}, h('b', {}, d)), h('kbd', {}, k))));

  import('./kit.js').then(({ dialog }) => dialog({
    title: 'Atalhos de teclado',
    body: h('div.list', {}, ...rows),
    actions: [{ label: 'Fechar', variant: 'primary', primary: true, value: true }],
  }));
}

export { openPalette };
