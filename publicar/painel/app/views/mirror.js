/* ==========================================================================
   views/mirror.js - controles do espelhamento
   --------------------------------------------------------------------------
   O espelho em si vive em core/mirrordock.js (uma unica sessao, compartilhada).
   Quando esta FIXADO, ele fica na coluna ao lado do log e esta tela mostra so
   os controles. Quando esta SOLTO, esta tela recebe o espelho por inteiro.
   O modo "ver todos" cria players extras para os demais aparelhos.
   ========================================================================== */

import { h, mount, clear, toast, promptBox, download } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store, currentSerial, currentDevice, onlineDevices, hasDevice } from '../core/state.js';
import { go } from '../core/shell.js';
import mirrordock from '../core/mirrordock.js';
import { card, btn, iconBtn, chip, field, emptyState, needDevice, statMini } from '../ui/widgets.js';
import { MirrorPlayer, webcodecsSupported } from '../player/player.js';

const extras = new Map();      // serial -> MirrorPlayer (modo "ver todos")
let quality = { maxSize: 1280, bitrate: 8000000, maxFps: 60, codec: 'h264' };
let showAll = false;
let cleanup = [];

const PRESETS = [
  { label: 'Leve (720p - 4 Mbps - 30 fps)', maxSize: 720, bitrate: 4000000, maxFps: 30 },
  { label: 'Equilibrado (1080p - 8 Mbps - 60 fps)', maxSize: 1080, bitrate: 8000000, maxFps: 60 },
  { label: 'Alta qualidade (1280p - 16 Mbps - 60 fps)', maxSize: 1280, bitrate: 16000000, maxFps: 60 },
  { label: 'Maxima (sem limite - 24 Mbps - 60 fps)', maxSize: 0, bitrate: 24000000, maxFps: 60 },
];

function stopExtras() {
  for (const p of extras.values()) p.close();
  extras.clear();
}

/* --------------------------------------------------- espelhos extras ----- */
function extraScreen(dev) {
  const overlay = h('div.screen__overlay');
  const hud = h('div.screen__hud');
  const player = new MirrorPlayer({
    onStats: (s) => { clear(hud); hud.append(h('span.chip', {}, s.fps + ' fps')); },
    onState: (st) => {
      clear(overlay);
      overlay.style.display = st === 'live' ? 'none' : 'grid';
      if (st !== 'live') overlay.append(h('span.small', {}, st === 'connecting' ? 'conectando...' : 'parado'));
      fit();
    },
    onMeta: () => setTimeout(fit, 30),
  });

  const screen = h('div.screen', { 'data-empty': '1' }, player.canvas, hud, overlay);
  const host = h('div', { style: { display: 'flex', justifyContent: 'center', padding: '8px' } }, screen);

  function fit() {
    const vw = player.canvas.width, vh = player.canvas.height;
    if (!vw || vw < 2) { screen.dataset.empty = '1'; return; }
    screen.dataset.empty = '0';
    const availW = Math.max(120, host.clientWidth - 20);
    const availH = Math.max(180, window.innerHeight * 0.46);
    const ar = vw / vh;
    let w = availW, hgt = w / ar;
    if (hgt > availH) { hgt = availH; w = hgt * ar; }
    player.canvas.style.width = Math.floor(w) + 'px';
    player.canvas.style.height = Math.floor(hgt) + 'px';
  }

  const nav = (ic, title, fn) => iconBtn(ic, title, () => fn(player), { small: true });
  extras.set(dev.serial, player);
  player.connect(dev.serial, quality);

  return h('div.card', {},
    h('div.card__head', {},
      h('h3', {}, dev.name || dev.serial), h('span.spacer'),
      chip(dev.transport === 'wifi' ? 'Wi-Fi' : 'USB', '', dev.transport === 'wifi' ? 'wifi' : 'usb')),
    host,
    h('div.navbar-phone', {},
      nav('back', 'Voltar', (p) => p.back()),
      nav('home', 'Inicio', (p) => p.home()),
      nav('square', 'Recentes', (p) => p.recents()),
      nav('rotate', 'Girar', (p) => p.rotate()),
      nav('power', 'Liga/desliga', (p) => p.power()))
  );
}

/* ------------------------------------------------------- painel lateral -- */
function qualityCard(onApply) {
  const sizeIn = h('input.input', { type: 'number', min: '0', max: '4096', step: '80', value: quality.maxSize });
  const fpsIn = h('input.input', { type: 'number', min: '5', max: '120', step: '5', value: quality.maxFps });
  const brIn = h('input.input', { type: 'number', min: '1', max: '60', step: '1', value: Math.round(quality.bitrate / 1000000) });
  const codecSel = h('select.select', {},
    h('option', { value: 'h264', selected: quality.codec === 'h264' }, 'H.264 (compativel)'),
    h('option', { value: 'h265', selected: quality.codec === 'h265' }, 'H.265 (menos dados)'));

  const presetSel = h('select.select', {
    onchange: (e) => {
      const p = PRESETS[Number(e.target.value)];
      if (!p) return;
      sizeIn.value = p.maxSize; fpsIn.value = p.maxFps; brIn.value = Math.round(p.bitrate / 1000000);
    },
  }, h('option', { value: '' }, 'Escolher um preset...'), ...PRESETS.map((p, i) => h('option', { value: i }, p.label)));

  return card('Qualidade do video', {},
    h('div.stack', {},
      field('Preset', presetSel),
      h('div.field3', {},
        field('Resolucao', sizeIn, '0 = original'),
        field('FPS', fpsIn),
        field('Mbps', brIn)),
      field('Codec', codecSel, 'H.265 usa menos rede, mas nem todo aparelho aceita'),
      btn('Aplicar', {
        variant: 'primary', icon: 'check', block: true,
        onClick: () => {
          quality = {
            maxSize: Math.max(0, Number(sizeIn.value) || 0),
            maxFps: Math.max(5, Math.min(120, Number(fpsIn.value) || 60)),
            bitrate: Math.max(1, Math.min(60, Number(brIn.value) || 8)) * 1000000,
            codec: codecSel.value,
          };
          onApply(quality);
        },
      })
    )
  );
}

/* ------------------------------------------------------------------ view - */
export const mirrorView = {
  id: 'mirror',
  title: 'Espelhamento',
  subtitle: 'Tela ao vivo com controle de mouse e teclado (engine scrcpy embutida)',
  icon: 'mirror',
  group: 'aparelho',

  actions: () => [
    btn(mirrordock.isPinned() ? 'Soltar espelho' : 'Fixar ao lado do log', {
      small: true, icon: 'pin', title: 'Ctrl+M',
      onClick: () => mirrordock.togglePin(),
    }),
    btn('Tela cheia', {
      small: true, icon: 'fullscreen',
      onClick: () => {
        const el = mirrordock.screen();
        if (!el) return;
        if (document.fullscreenElement) document.exitFullscreen();
        else el.requestFullscreen?.();
      },
    }),
    btn('Janela nativa', {
      small: true, icon: 'external', title: 'Janela do scrcpy (audio e tela cheia real)',
      onClick: async () => {
        const serial = currentSerial();
        if (!serial) return toast('Selecione um aparelho', 'warn');
        try {
          await api.get('/api/mirror/window', { serial });
          toast('Janela do scrcpy aberta', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
    }),
  ],

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    const screenHost = h('div#mirrorHost', {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
    });
    const gridHost = h('div');
    const panel = h('div.mirror__panel');
    const pinned = mirrordock.isPinned();

    /* ---- area principal ---- */
    if (pinned) {
      mount(screenHost,
        h('div.card', { style: { width: '100%' } },
          h('div.card__body', {},
            emptyState('pin', 'O espelho esta fixado ao lado do log',
              'Ele fica visivel em todas as telas do painel. Arraste a borda esquerda da coluna para mudar a largura.',
              btn('Trazer para esta tela', {
                variant: 'primary', icon: 'mirror',
                onClick: () => mirrordock.setPinned(false),
              }))))
      );
    } else {
      mirrordock.mountInto(screenHost);
      mirrordock.ensure(quality);
    }

    /* ---- estatisticas ---- */
    const statsBox = h('div.statgrid');
    const paintStats = () => {
      const p = mirrordock.player();
      clear(statsBox);
      if (!p) return;
      statsBox.append(
        statMini('FPS', p.stats.fps),
        statMini('Rede', (Math.round(p.stats.kbps / 100) / 10) + ' Mbps'),
        statMini('Resolucao', p.width ? p.width + 'x' + p.height : '-'),
        statMini('Frames', p.stats.decoded)
      );
    };
    const timer = setInterval(paintStats, 1000);
    cleanup.push(() => clearInterval(timer));
    paintStats();

    const controlToggle = h('input', {
      type: 'checkbox', checked: true,
      onchange: (e) => {
        const p = mirrordock.player();
        if (p) p.controlEnabled = e.target.checked;
        for (const x of extras.values()) x.controlEnabled = e.target.checked;
      },
    });

    /* ---- modo varios aparelhos ---- */
    const paintGrid = () => {
      stopExtras();
      clear(gridHost);
      if (!showAll) return;
      const others = onlineDevices().filter((d) => d.serial !== currentSerial());
      if (!others.length) {
        gridHost.appendChild(h('p.small.muted.mt-3', {}, 'Nenhum outro aparelho online.'));
        return;
      }
      const grid = h('div.grid.grid--2.mt-4', {}, ...others.map(extraScreen));
      gridHost.appendChild(grid);
    };

    const act = (fn) => () => { const p = mirrordock.player(); if (p) fn(p); };

    mount(panel,
      card('Sessao', {
        actions: [iconBtn('refresh', 'Reconectar', () => mirrordock.restart(), { small: true })],
      },
        h('div.stack', {},
          h('div.switchrow', {},
            h('div.switchrow__tx', {}, h('b', {}, 'Controle'), h('small', {}, 'mouse e teclado no aparelho')),
            h('span.switch', {}, controlToggle, h('i'))),
          h('div.switchrow', {},
            h('div.switchrow__tx', {}, h('b', {}, 'Fixar ao lado do log'), h('small', {}, 'visivel em todas as telas')),
            h('span.switch', {},
              h('input', {
                type: 'checkbox', checked: pinned,
                onchange: (e) => mirrordock.setPinned(e.target.checked),
              }), h('i'))),
          statsBox,
          h('div.actiongrid', {},
            btn(showAll ? 'Ocultar os outros' : 'Ver todos', {
              small: true, icon: 'apps', title: 'Espelhar os demais aparelhos online',
              onClick: () => { showAll = !showAll; go('mirror'); },
            }),
            btn('Keyframe', { small: true, icon: 'refresh', title: 'Forcar um quadro-chave novo', onClick: act((p) => p.requestKeyFrame()) })))
      ),

      qualityCard(async (q) => {
        try {
          await api.get('/api/mirror/configure', Object.assign({ serial: currentSerial() }, q));
          mirrordock.reconfigure(q);
          for (const [serial, p] of extras) p.connect(serial, q);
          toast('Qualidade aplicada', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      }),

      card('Acoes rapidas', {},
        h('div.actiongrid', {},
          btn('Print', {
            title: 'Salva o quadro atual como PNG',
            small: true, icon: 'capture',
            onClick: async () => {
              const p = mirrordock.player();
              if (!p) return;
              const blob = await p.snapshot();
              download(`tela-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, blob, 'image/png');
              toast('Print baixado', 'ok');
            },
          }),
          btn('Digitar', {
            title: 'Digita um texto no campo em foco do celular',
            small: true, icon: 'keyboard',
            onClick: async () => {
              const text = await promptBox('Digitar no aparelho', 'O texto vai para o campo em foco do celular.', '');
              if (text) mirrordock.player()?.typeText(text);
            },
          }),
          btn('Colar do PC', {
            title: 'Envia a area de transferencia do PC para o celular',
            small: true, icon: 'clipboard',
            onClick: async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text) return toast('Area de transferencia vazia', 'warn');
                mirrordock.player()?.pasteToDevice(text);
                toast('Colado no aparelho', 'ok');
              } catch (_) { toast('O navegador bloqueou a leitura da area de transferencia', 'err'); }
            },
          }),
          btn('Copiar', { small: true, icon: 'copy', title: 'Traz a area de transferencia do celular', onClick: act((p) => p.copyFromDevice()) }),
          btn('Apagar tela', { small: true, icon: 'power', title: 'Desliga a tela do aparelho', onClick: act((p) => p.screenOff()) }),
          btn('Acender tela', { small: true, icon: 'sun', title: 'Liga a tela do aparelho', onClick: act((p) => p.screenOn()) }))
      ),

      !webcodecsSupported
        ? card('Aviso', {}, h('p.small.warn', {},
          'Este navegador nao tem WebCodecs, entao o espelhamento roda no modo simples ' +
          '(prints sequenciais, sem controle). Abra o painel no Edge ou no Chrome.'))
        : null
    );

    mount(root, h('div.mirror', { class: pinned ? 'mirror--pinned' : '' },
      h('div', {}, screenHost, gridHost), panel));
    paintGrid();

    // F11 = tela cheia do espelho
    const onKey = (e) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      const el = mirrordock.screen();
      if (document.fullscreenElement) document.exitFullscreen();
      else el?.requestFullscreen?.();
    };
    document.addEventListener('keydown', onKey);
    cleanup.push(() => document.removeEventListener('keydown', onKey));

    // a moldura precisa se remedir quando entra/sai da tela cheia
    const onFs = () => {
      const el = mirrordock.screen();
      if (el) el.dataset.fullscreen = document.fullscreenElement === el ? '1' : '0';
      setTimeout(() => mirrordock.fit(), 60);
    };
    document.addEventListener('fullscreenchange', onFs);
    cleanup.push(() => document.removeEventListener('fullscreenchange', onFs));
  },

  destroy() {
    stopExtras();
    cleanup.forEach((f) => f());
    cleanup = [];
  },

  commands: [
    { label: 'Espelhar a tela do aparelho', icon: 'mirror', run: () => go('mirror') },
  ],
};
