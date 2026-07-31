/* ==========================================================================
   mirrordock.js - o espelho como peca fixa do layout
   --------------------------------------------------------------------------
   PROBLEMA QUE ISTO RESOLVE: o espelho so existia dentro da tela
   "Espelhamento". Para ver o celular enquanto mexia em outra aba, o usuario
   precisava abrir a janela nativa do scrcpy, que flutuava por cima de tudo.

   Agora existe UMA instancia do player, dona da sessao, que pode morar em
   dois lugares:
     - fixada (padrao): coluna propria ao lado da doca de log, visivel em
       TODAS as telas
     - solta: dentro da tela Espelhamento, ocupando o espaco todo
   Trocar de lugar e so mover o mesmo no do DOM - a conexao nao cai.
   ========================================================================== */

import { h, mount, clear, toast } from './kit.js';
import { icon } from './icons.js';
import { store, currentSerial, currentDevice, hasDevice } from './state.js';
import { renameDevice } from './rename.js';
import { MirrorPlayer, SimpleMirror, webcodecsSupported } from '../player/player.js';

const LS_PIN = 'painel.mirror.pinned';
const LS_WIDTH = 'painel.mirror.width';

const state = {
  ready: false,
  pinned: localStorage.getItem(LS_PIN) !== '0',
  width: Number(localStorage.getItem(LS_WIDTH)) || 330,
  serial: '',
  quality: null,
  host: null,          // onde o espelho esta montado agora
  simple: null,        // fallback sem WebCodecs
  // --- espelhamento automatico ---
  auto: true,          // liga sozinho quando o aparelho aparece
  paradaManual: false, // distingue "eu mandei parar" de "caiu sozinho"
  tentativa: 0,
  timerRetry: null,
};

/**
 * Religa sozinho depois de uma queda. O aparelho pode estar bloqueado, saindo
 * do boot ou trocando de USB para Wi-Fi - nesses casos a primeira tentativa
 * falha e a segunda funciona. Espera crescente ate 12s para nao martelar.
 */
function agendarReconexao() {
  clearTimeout(state.timerRetry);
  if (!state.auto || state.paradaManual || !hasDevice()) return;
  state.tentativa = Math.min(state.tentativa + 1, 6);
  const espera = Math.min(1500 * state.tentativa, 12000);
  state.timerRetry = setTimeout(() => {
    if (!state.auto || state.paradaManual || !hasDevice()) return;
    state.serial = '';        // forca uma sessao nova
    api.ensure();
  }, espera);
}

let dockEl = null;      // <aside class="mirrordock">
let dockBody = null;
let dockName = null;
let screenEl = null;    // moldura preta (canvas + overlay + hud)
let overlayEl = null;
let hudEl = null;
let navEl = null;
let player = null;
let observer = null;
const listeners = new Set();

/* ------------------------------------------------------------- medidas --- */
// O canvas e dimensionado em JS: assim a moldura encosta na imagem e nao sobra
// tarja preta nenhuma, em qualquer largura de coluna.
//
// A altura disponivel e o MENOR entre:
//   - a altura do container (vale na doca, que tem altura definida)
//   - o que falta ate o fim da janela (vale dentro da tela Espelhamento, onde o
//     container cresce junto com o conteudo - sem esse limite o canvas crescia
//     ate 1575px e realimentava o ResizeObserver)
let ultimoAjuste = '';

function fit() {
  if (!player || !screenEl) return;
  const host = screenEl.parentElement;
  if (!host || !host.isConnected) return;

  const vw = player.canvas.width, vh = player.canvas.height;
  if (!vw || !vh || vw < 2) {
    screenEl.dataset.empty = '1';
    player.canvas.style.width = '';
    player.canvas.style.height = '';
    ultimoAjuste = '';
    return;
  }
  screenEl.dataset.empty = '0';

  const cs = getComputedStyle(host);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const navDentro = navEl && navEl.parentElement === host ? navEl.offsetHeight + 8 : 0;
  const rect = host.getBoundingClientRect();

  // O limite vertical e medido contra a AREA VISIVEL do container que rola.
  // Usar rect.top puro deixava a conta crescer quando a pagina era rolada
  // (rect.top negativo -> mais espaco -> canvas maior -> mais rolagem...).
  const scroller = host.closest('.view') || document.documentElement;
  const sRect = scroller.getBoundingClientRect();
  const topVisivel = Math.max(rect.top, sRect.top);
  const fundoVisivel = Math.min(sRect.bottom, window.innerHeight);

  const availW = Math.max(120, host.clientWidth - padX - 2);
  const porContainer = host.clientHeight ? host.clientHeight - padY : Infinity;
  const porJanela = fundoVisivel - topVisivel - 24;
  const availH = Math.max(200, Math.min(porContainer, porJanela) - navDentro - 2);

  const ar = vw / vh;
  let w = availW, hgt = w / ar;
  if (hgt > availH) { hgt = availH; w = hgt * ar; }

  w = Math.floor(w); hgt = Math.floor(hgt);
  const assinatura = w + 'x' + hgt;
  if (assinatura === ultimoAjuste) return;   // evita o laco do ResizeObserver
  ultimoAjuste = assinatura;
  player.canvas.style.width = w + 'px';
  player.canvas.style.height = hgt + 'px';
}

// o ResizeObserver dispara durante o layout; adiar para o proximo quadro evita
// o aviso "ResizeObserver loop completed with undelivered notifications"
let agendado = false;
function fitAgendado() {
  if (agendado) return;
  agendado = true;
  requestAnimationFrame(() => { agendado = false; fit(); });
}

const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };

/* ------------------------------------------------------------ construcao - */
function buildScreen() {
  overlayEl = h('div.screen__overlay');
  hudEl = h('div.screen__hud');

  player = new MirrorPlayer({
    onState: (st, err) => {
      paintOverlay(st, err);
      if (st === 'live') { state.tentativa = 0; clearTimeout(state.timerRetry); }
      else if (st === 'error' || st === 'closed') agendarReconexao();
      emit();
    },
    onStats: (s) => {
      clear(hudEl);
      hudEl.append(
        h('span.chip', {}, s.fps + ' fps'),
        h('span.chip', {}, (Math.round(s.kbps / 100) / 10) + ' Mbps')
      );
    },
    onMeta: () => { setTimeout(fit, 30); emit(); },
    onClipboard: (text) => {
      if (!text) return;
      navigator.clipboard?.writeText(text).catch(() => { });
      toast('Copiado do celular', 'ok', 1400);
    },
  });

  screenEl = h('div.screen', { 'data-empty': '1' }, player.canvas, hudEl, overlayEl);
  navEl = buildNav();

  // o canvas muda de tamanho quando o video muda de orientacao
  observer = new ResizeObserver(fitAgendado);
  window.addEventListener('resize', fitAgendado);
  paintOverlay('idle');
}

function paintOverlay(st, err) {
  clear(overlayEl);
  if (st === 'live') { overlayEl.style.display = 'none'; return; }
  overlayEl.style.display = 'grid';
  screenEl.dataset.empty = '1';

  if (st === 'connecting') {
    overlayEl.append(h('div.hstack', {}, h('span.spinner'), h('span', {}, 'Conectando...')));
  } else if (st === 'error') {
    overlayEl.append(
      icon('warning', 30),
      h('b', {}, 'Nao consegui espelhar'),
      h('p.small', { style: { maxWidth: '320px' } }, err || ''),
      h('div.btnrow', { style: { justifyContent: 'center' } },
        h('button.btn.btn--primary.btn--sm', { onclick: () => api.restart() }, icon('refresh', 14), 'Tentar de novo'))
    );
  } else if (!hasDevice()) {
    overlayEl.append(icon('devices', 30), h('p.small', {}, 'Nenhum aparelho conectado'));
  } else if (state.tentativa > 0 && state.auto) {
    overlayEl.append(
      h('div.hstack', {}, h('span.spinner'), h('span.small', {}, 'Religando...')),
      h('button.btn.btn--ghost.btn--sm', { onclick: () => api.restart() }, icon('play', 14), 'Tentar agora')
    );
  } else {
    overlayEl.append(
      icon('mirror', 30),
      h('p.small', {}, 'Espelhamento parado'),
      h('button.btn.btn--primary.btn--sm', { onclick: () => api.restart() }, icon('play', 14), 'Conectar')
    );
  }
}

function buildNav() {
  const b = (ic, title, fn) => h('button.btn.btn--quiet.btn--icon.btn--sm', {
    title, 'aria-label': title, onclick: () => { if (player) fn(player); },
  }, icon(ic, 15));
  return h('div.navbar-phone', {},
    b('back', 'Voltar', (p) => p.back()),
    b('home', 'Inicio', (p) => p.home()),
    b('square', 'Recentes', (p) => p.recents()),
    b('volumeUp', 'Volume +', (p) => p.volumeUp()),
    b('volumeDown', 'Volume -', (p) => p.volumeDown()),
    b('bell', 'Notificacoes', (p) => p.notifications()),
    b('rotate', 'Girar', (p) => p.rotate()),
    b('power', 'Liga/desliga', (p) => p.power())
  );
}

/* ------------------------------------------------------- doca (coluna) --- */
function buildDock() {
  // o nome tambem renomeia: clique duplo, alem do botao de lapis
  dockName = h('button.name', {
    title: 'Clique duas vezes para renomear',
    style: { textAlign: 'left', font: 'inherit', color: 'inherit', minWidth: 0 },
    ondblclick: () => renameDevice(currentDevice()),
  }, 'Espelho');
  dockBody = h('div.mirrordock__body');

  const grip = h('div.mirrordock__grip', { title: 'Arraste para mudar a largura' });
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.dataset.drag = '1';
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const right = dockEl.getBoundingClientRect().right;
    api.setWidth(right - e.clientX);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    delete grip.dataset.drag;
    try { grip.releasePointerCapture(e.pointerId); } catch (_) { }
    localStorage.setItem(LS_WIDTH, String(state.width));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  dockEl = h('aside.mirrordock', { id: 'mirrordock', 'aria-label': 'Espelho do aparelho' },
    grip,
    h('div.mirrordock__head', {},
      icon('mirror', 15), dockName, h('span.spacer'),
      h('button.btn.btn--quiet.btn--sm.btn--icon', {
        title: 'Renomear este aparelho', onclick: () => renameDevice(currentDevice()),
      }, icon('edit', 14)),
      h('button.btn.btn--quiet.btn--sm.btn--icon', {
        title: 'Reconectar', onclick: () => api.restart(),
      }, icon('refresh', 14)),
      h('button.btn.btn--quiet.btn--sm.btn--icon', {
        title: 'Abrir na tela Espelhamento', onclick: () => { api.setPinned(false); location.hash = '#/mirror'; },
      }, icon('external', 14)),
      h('button.btn.btn--quiet.btn--sm.btn--icon', {
        title: 'Desafixar (Ctrl+M)', onclick: () => api.setPinned(false),
      }, icon('close', 14))
    ),
    dockBody,
    navEl
  );
  dockEl.style.setProperty('--mirrordock-w', state.width + 'px');
  return dockEl;
}

/* ------------------------------------------------------------- API ------- */
const api = {
  /** Cria os elementos e devolve a coluna, para o shell inserir no layout. */
  create() {
    if (state.ready) return dockEl;
    buildScreen();
    buildDock();
    state.ready = true;
    return dockEl;
  },

  element: () => dockEl,
  screen: () => screenEl,
  nav: () => navEl,
  player: () => player,
  isPinned: () => state.pinned,
  isLive: () => !!player && player.state === 'live',
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Move o espelho para dentro de um elemento (a tela Espelhamento). */
  mountInto(host, withNav = true) {
    if (!state.ready) api.create();
    if (state.host === host) { fit(); return; }
    observer.disconnect();
    host.appendChild(screenEl);
    if (withNav) host.appendChild(navEl);
    state.host = host;
    observer.observe(host);
    ultimoAjuste = '';
    setTimeout(fit, 20);
  },

  /** Devolve o espelho para a coluna fixa. */
  returnToDock() {
    if (!state.ready) return;
    observer.disconnect();
    dockBody.appendChild(screenEl);
    dockEl.appendChild(navEl);
    state.host = dockBody;
    observer.observe(dockBody);
    ultimoAjuste = '';
    setTimeout(fit, 20);
  },

  setPinned(on) {
    state.pinned = !!on;
    localStorage.setItem(LS_PIN, on ? '1' : '0');
    api.refreshPlacement();
    emit();
  },

  togglePin() { api.setPinned(!state.pinned); },

  setWidth(px) {
    const w = Math.max(220, Math.min(Math.round(px), Math.round(window.innerWidth * 0.46)));
    state.width = w;
    if (dockEl) dockEl.style.setProperty('--mirrordock-w', w + 'px');
    ultimoAjuste = '';
    fit();
  },

  /**
   * Mostra/esconde a coluna conforme o estado (fixado ou solto) e a tela atual.
   *   fixado          -> coluna visivel, espelho dentro dela, sessao ativa
   *   solto + tela de espelhamento -> a propria tela chama mountInto()
   *   solto + outra tela           -> guarda o no na coluna escondida e encerra
   */
  refreshPlacement(viewId) {
    if (!state.ready) return;
    const onMirrorView = (viewId || location.hash.replace(/^#\/?/, '').split('?')[0]) === 'mirror';

    if (state.pinned) {
      dockEl.removeAttribute('hidden');
      if (state.host !== dockBody) api.returnToDock();
      api.ensure();
    } else {
      dockEl.setAttribute('hidden', '');
      if (!onMirrorView) { api.returnToDock(); api.stop(); }
    }
    if (dockName) {
      const d = currentDevice();
      dockName.textContent = d ? (d.name || d.serial) : 'Sem aparelho';
    }
    return state.pinned;
  },

  /**
   * Garante uma sessao ativa para o aparelho selecionado.
   * Sem o modo automatico, so conecta quando o usuario pede (forcar = true).
   */
  ensure(quality, forcar) {
    if (!state.ready) api.create();
    if (quality) state.quality = quality;
    const serial = currentSerial();
    if (!serial || !hasDevice()) {
      paintOverlay('idle');
      return;
    }
    if (!state.auto && !forcar && player.state !== 'live') {
      paintOverlay('idle');
      return;
    }
    state.paradaManual = false;
    if (!webcodecsSupported) return api.useSimple(serial);
    const mesmaSessao = state.serial === serial && ['live', 'connecting'].includes(player.state);
    if (mesmaSessao) return;
    state.serial = serial;
    player.connect(serial, state.quality || {});
    paintOverlay('connecting');
  },

  restart() {
    clearTimeout(state.timerRetry);
    state.tentativa = 0;
    state.serial = '';
    api.ensure(null, true);
  },

  /** Liga/desliga o espelhamento automatico. */
  setAuto(on) {
    state.auto = !!on;
    clearTimeout(state.timerRetry);
    state.tentativa = 0;
    if (state.auto) api.ensure();
    emit();
  },
  isAuto: () => state.auto,

  reconfigure(quality) {
    state.quality = Object.assign({}, state.quality, quality);
    api.restart();
  },

  stop() {
    state.paradaManual = true;
    clearTimeout(state.timerRetry);
    state.tentativa = 0;
    if (player) player.close();
    state.serial = '';
    paintOverlay('idle');
  },

  /** Fallback para navegadores sem WebCodecs. */
  useSimple(serial) {
    if (state.simple) state.simple.stop();
    state.simple = new SimpleMirror({ onError: (e) => toast(e, 'err', 4000) });
    clear(screenEl);
    screenEl.dataset.empty = '0';
    screenEl.appendChild(state.simple.img);
    state.simple.start(serial, 1300);
  },

  fit,
};

export default api;
export { api as mirrordock };
