/* ==========================================================================
   kit.js - as ferramentas basicas da interface
   --------------------------------------------------------------------------
   PROBLEMA QUE ISTO RESOLVE: na versao antiga, tudo era string de HTML jogada
   em innerHTML, com dados do aparelho no meio (versionName vindo do dumpsys!),
   e ~50 funcoes globais no window. Aqui existe um construtor de elementos
   (h), um estado observavel, avisos e caixas de dialogo proprias - todos
   modulos ES, nada global.
   ========================================================================== */

/* ------------------------------------------------------------------ DOM --- */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card#id', props, filhos)
 *  - props: atributos; 'class', 'style' (objeto), 'on*' (eventos), 'html' (innerHTML
 *    consciente - use APENAS com conteudo proprio, nunca com dado do aparelho)
 *  - filhos: string, Node, array, null/false (ignorados)
 */
export function h(spec, props, ...children) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else if (token[0] === '#') el.id = token.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'indeterminate') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false || c === '') continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function svg(pathsHtml, size = 16, viewBox = '0 0 24 24') {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', 'none');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = pathsHtml;
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...children) => append(clear(el), children);

/* ---------------------------------------------------------------- estado -- */
/** Estado observavel simples: store.set({...}) avisa quem assinou. */
export function createStore(initial) {
  let state = Object.assign({}, initial);
  const subs = new Set();
  const keySubs = new Map();
  return {
    get state() { return state; },
    get(key) { return state[key]; },
    set(patch) {
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (state[k] !== v) { state[k] = v; changed.push(k); }
      }
      if (!changed.length) return;
      for (const fn of subs) fn(state, changed);
      for (const k of changed) {
        const list = keySubs.get(k);
        if (list) for (const fn of list) fn(state[k], state);
      }
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    on(key, fn) {
      if (!keySubs.has(key)) keySubs.set(key, new Set());
      keySubs.get(key).add(fn);
      return () => keySubs.get(key).delete(fn);
    },
  };
}

/** Barramento de eventos entre modulos que nao se conhecem. */
export function createBus() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt).delete(fn);
    },
    emit(evt, payload) {
      const list = map.get(evt);
      if (list) for (const fn of [...list]) { try { fn(payload); } catch (e) { console.error(e); } }
    },
  };
}

/* ----------------------------------------------------------------- avisos -- */
const ICON_OK = '<path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_WARN = '<path d="M12 9v4m0 4h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_ERR = '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="M15 9l-6 6m0-6 6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>';
const ICON_INFO = '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="M12 11v5m0-8.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

let toastHost = null;
function toastRoot() {
  if (!toastHost) {
    toastHost = h('div#toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(message, kind = 'info', ms = 2600) {
  const icon = { ok: ICON_OK, warn: ICON_WARN, err: ICON_ERR, info: ICON_INFO }[kind] || ICON_INFO;
  const el = h('div.toast', { class: 'toast--' + kind }, svg(icon, 17), h('span', {}, message));
  toastRoot().appendChild(el);
  const kill = () => {
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(kill, kind === 'err' ? Math.max(ms, 5000) : ms);
  el.addEventListener('click', () => { clearTimeout(timer); kill(); });
  return kill;
}

/* --------------------------------------------------------------- dialogos -- */
// Substitui confirm()/prompt()/alert(), que travam a janela e nao seguem o tema.
let openDialogs = 0;

function dialog({ title, body, actions, wide, onMount }) {
  return new Promise((resolve) => {
    const scrim = h('div.scrim', { class: wide ? 'scrim--wide' : '' });
    const close = (value) => {
      scrim.remove();
      openDialogs--;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const primary = scrim.querySelector('[data-primary]');
        if (primary) { e.preventDefault(); primary.click(); }
      }
    };

    const foot = h('div.modal__foot');
    for (const a of actions) {
      foot.appendChild(h('button.btn', {
        class: a.variant ? 'btn--' + a.variant : 'btn--ghost',
        'data-primary': a.primary || null,
        onclick: () => close(typeof a.value === 'function' ? a.value(modal) : a.value),
      }, a.label));
    }

    const modal = h('div.modal', { class: wide ? 'modal--wide' : '', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
      h('div.modal__head', {},
        h('h2', {}, title),
        h('button.btn.btn--quiet.btn--icon', { 'aria-label': 'Fechar', onclick: () => close(null) },
          svg('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>', 16))
      ),
      h('div.modal__body', {}, body),
      foot
    );

    scrim.appendChild(modal);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey, true);
    openDialogs++;
    if (onMount) onMount(modal);
    setTimeout(() => {
      const focusable = modal.querySelector('input, textarea, select, [data-primary]');
      (focusable || modal).focus();
    }, 30);
  });
}

export function alertBox(title, message) {
  return dialog({
    title,
    body: typeof message === 'string' ? h('p', {}, message) : message,
    actions: [{ label: 'Entendi', variant: 'primary', primary: true, value: true }],
  });
}

export function confirmBox(title, message, opts = {}) {
  return dialog({
    title,
    body: typeof message === 'string' ? h('p', {}, message) : message,
    wide: opts.wide,
    actions: [
      { label: opts.cancelLabel || 'Cancelar', value: false },
      { label: opts.okLabel || 'Confirmar', variant: opts.danger ? 'danger' : 'primary', primary: true, value: true },
    ],
  }).then((v) => v === true);
}

export function promptBox(title, message, defaultValue = '', opts = {}) {
  const input = h('input.input', { value: defaultValue, placeholder: opts.placeholder || '' });
  return dialog({
    title,
    body: [message ? h('p', {}, message) : null, input],
    actions: [
      { label: 'Cancelar', value: null },
      { label: opts.okLabel || 'OK', variant: 'primary', primary: true, value: () => input.value.trim() || null },
    ],
    onMount: () => setTimeout(() => { input.focus(); input.select(); }, 40),
  });
}

export { dialog };

/* ---------------------------------------------------------------- formato -- */
export const fmt = {
  bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  },
  mb(n) { return (Number(n) || 0).toFixed(1) + ' MB'; },
  bitrate(bps) {
    const m = (Number(bps) || 0) / 1e6;
    return m >= 1 ? m.toFixed(m >= 10 ? 0 : 1) + ' Mbps' : Math.round((Number(bps) || 0) / 1000) + ' kbps';
  },
  uptime(sec) {
    sec = Number(sec) || 0;
    const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60);
    return (d ? d + 'd ' : '') + (hh ? hh + 'h ' : '') + mm + 'm';
  },
  time(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
  date(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  duration(ms) {
    const s = Math.floor((Number(ms) || 0) / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  },
};

/* --------------------------------------------------------------- diversos -- */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms = 100) {
  let last = 0, pending = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(pending); pending = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copia texto para a area de transferencia com aviso. */
export async function copy(text, label = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(label, 'ok', 1400); return true; }
  catch (_) { toast('Nao consegui copiar', 'err'); return false; }
}

/** Baixa um conteudo como arquivo (log, json...). */
export function download(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
