/* ==========================================================================
   views/settings.js - aparencia, padroes, manutencao, atualizacao e sobre
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, fmt } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/state.js';
import { theme, toggleDock, showShortcuts, go } from '../core/shell.js';
import mirrordock from '../core/mirrordock.js';
import updatebar from '../core/updatebar.js';
import { runTask } from '../core/tasks.js';
import { card, btn, iconBtn, chip, field, selectField, emptyState, statTile } from '../ui/widgets.js';

const ACCENTS = [
  { id: 'coral', label: 'Coral', color: '#d97757' },
  { id: 'azul', label: 'Azul', color: '#4c8dff' },
  { id: 'verde', label: 'Verde', color: '#34c98a' },
  { id: 'roxo', label: 'Roxo', color: '#a78bfa' },
  { id: 'ambar', label: 'Ambar', color: '#f0b429' },
];

export const settingsView = {
  id: 'settings',
  title: 'Configuracoes',
  subtitle: 'Aparencia, padroes de espelhamento, manutencao e atualizacao',
  icon: 'settings',
  group: 'sistema',

  async render(root) {
    const s = store.get('settings') || {};

    /* ------------------------------------------------------- aparencia -- */
    const accentRow = h('div.hstack', {}, ...ACCENTS.map((a) => {
      const b = h('button.btn.btn--sm', {
        'aria-pressed': (s.accent || 'coral') === a.id ? 'true' : 'false',
        onclick: () => {
          theme.set({ accent: a.id });
          [...accentRow.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
          b.setAttribute('aria-pressed', 'true');
        },
      }, h('span', {
        style: {
          width: '13px', height: '13px', borderRadius: '50%', background: a.color, display: 'inline-block',
        },
      }), a.label);
      return b;
    }));

    const appearance = card('Aparencia', {},
      h('div.stack', {},
        selectField('Tema', s.theme || 'dark', [
          { value: 'dark', label: 'Escuro' },
          { value: 'light', label: 'Claro' },
          { value: 'system', label: 'Seguir o Windows' },
        ], (v) => theme.set({ theme: v })),
        field('Cor de destaque', accentRow),
        selectField('Densidade', s.density || 'confortavel', [
          { value: 'confortavel', label: 'Confortavel' },
          { value: 'compacta', label: 'Compacta (mais itens na tela)' },
        ], (v) => theme.set({ density: v })),
        selectField('Marca d\'agua do logo no log', s.logoWatermark || 'discreta', [
          { value: 'discreta', label: 'Discreta' },
          { value: 'media', label: 'Media' },
          { value: 'forte', label: 'Forte' },
          { value: 'off', label: 'Desligada' },
        ], (v) => theme.set({ logoWatermark: v }),
          document.documentElement.dataset.hasLogo
            ? 'O logo aparece ao fundo da doca de log.'
            : 'Coloque o arquivo em painel\\app\\assets\\logo.png para ativar.'),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: s.animations !== false,
          onchange: (e) => theme.set({ animations: e.target.checked }),
        }), 'Animacoes da interface'),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: s.sounds !== false,
          onchange: (e) => theme.set({ sounds: e.target.checked }),
        }), 'Som ao terminar uma tarefa'),
        h('div.hstack', {},
          btn('Ver atalhos de teclado', { small: true, icon: 'keyboard', onClick: showShortcuts }),
          btn('Pedir permissao de notificacao', {
            small: true, icon: 'bell',
            onClick: () => {
              if (!('Notification' in window)) return toast('Este navegador nao suporta notificacoes', 'warn');
              Notification.requestPermission().then((p) => toast('Notificacoes: ' + p, p === 'granted' ? 'ok' : 'warn'));
            },
          }))
      )
    );

    /* -------------------------------------------------------- espelho ---- */
    const m = s.mirror || {};
    const mirrorCard = card('Padroes do espelhamento', {
      subtitle: 'Valores usados ao abrir uma nova sessao.',
    },
      h('div.stack', {},
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: m.autoStart !== false,
          onchange: (e) => { mirrordock.setAuto(e.target.checked); save({ mirror: { autoStart: e.target.checked } }); },
        }), 'Espelhar automaticamente ao conectar o aparelho'),
        h('p.xs.faint', { style: { marginTop: '-6px' } },
          'Liga sozinho quando o celular aparece e religa sozinho se a conexao cair.'),
        h('div.grid.grid--3', {},
          field('Resolucao maxima', h('input.input', {
            type: 'number', value: m.maxSize ?? 1280, min: 0, max: 4096, step: 80,
            onchange: (e) => save({ mirror: { maxSize: Number(e.target.value) || 0 } }),
          })),
          field('FPS', h('input.input', {
            type: 'number', value: m.maxFps ?? 60, min: 5, max: 120, step: 5,
            onchange: (e) => save({ mirror: { maxFps: Number(e.target.value) || 60 } }),
          })),
          field('Bitrate (Mbps)', h('input.input', {
            type: 'number', value: Math.round((m.bitrate ?? 8000000) / 1000000), min: 1, max: 60,
            onchange: (e) => save({ mirror: { bitrate: (Number(e.target.value) || 8) * 1000000 } }),
          }))
        ),
        selectField('Codec', m.codec || 'h264', [
          { value: 'h264', label: 'H.264 (compativel com tudo)' },
          { value: 'h265', label: 'H.265 (usa menos rede)' },
        ], (v) => save({ mirror: { codec: v } })),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: m.stayAwake !== false,
          onchange: (e) => save({ mirror: { stayAwake: e.target.checked } }),
        }), 'Manter a tela do celular acesa durante o espelhamento'),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: m.powerOn !== false,
          onchange: (e) => save({ mirror: { powerOn: e.target.checked } }),
        }), 'Ligar a tela ao iniciar o espelhamento'),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: !!m.showTouches,
          onchange: (e) => save({ mirror: { showTouches: e.target.checked } }),
        }), 'Mostrar os toques na tela do celular')
      )
    );

    /* ----------------------------------------------------------- wifi ---- */
    const w = s.wifi || {};
    const wifiCard = card('Conexao Wi-Fi', {},
      h('div.stack', {},
        field('Porta do ADB por Wi-Fi', h('input.input', {
          type: 'number', value: w.port ?? 5555, min: 1024, max: 65535,
          onchange: (e) => save({ wifi: { port: Number(e.target.value) || 5555 } }),
        }), 'O padrao do Android e 5555'),
        h('label.check', {}, h('input', {
          type: 'checkbox', checked: w.autoReconnect !== false,
          onchange: (e) => save({ wifi: { autoReconnect: e.target.checked } }),
        }), 'Reconectar sozinho os aparelhos conhecidos que sumirem')
      )
    );

    /* ------------------------------------------------------ manutencao --- */
    const maintList = h('div.list');
    const maintTotal = h('span.chip', {}, '-');
    const maintSelected = new Set();

    const loadMaintenance = async () => {
      mount(maintList, h('div.card__body', {}, h('div.hstack', {}, h('span.spinner'), 'Procurando o que da para limpar...')));
      try {
        const r = await api.get('/api/maintenance/scan');
        maintTotal.textContent = r.totalMB + ' MB recuperaveis';
        clear(maintList);
        if (!r.items.length) {
          maintList.appendChild(h('div.card__body', {}, h('p.small.muted', {}, 'Nada a limpar - a pasta do programa esta enxuta.')));
          return;
        }
        for (const it of r.items) {
          const cb = h('input', {
            type: 'checkbox',
            onchange: (e) => { e.target.checked ? maintSelected.add(it.id) : maintSelected.delete(it.id); },
          });
          maintList.appendChild(h('div.row', {}, cb,
            h('div.row__icon', {}, icon(it.kind === 'pasta' ? 'folder' : 'file', 17)),
            h('div.row__main', {}, h('b', {}, it.label), h('small', {}, it.hint || '')),
            chip(it.sizeMB + ' MB', it.sizeMB > 20 ? 'warn' : '')));
        }
      } catch (e) { mount(maintList, h('div.card__body', {}, h('p.small.err', {}, e.message))); }
    };

    const maintenanceCard = card('Manutencao do programa', {
      subtitle: 'Sobras de extracao, logs antigos e temporarios. Nada e apagado sem a sua confirmacao.',
      actions: [maintTotal, btn('Procurar', { small: true, icon: 'search', onClick: loadMaintenance })],
      flush: true,
      foot: btn('Limpar selecionados', {
        small: true, icon: 'broom', variant: 'danger',
        onClick: async () => {
          if (!maintSelected.size) return toast('Selecione o que deseja apagar', 'warn');
          if (!await confirmBox('Limpar', `Apagar definitivamente ${maintSelected.size} item(ns)?`, { danger: true })) return;
          try {
            const r = await api.get('/api/maintenance/clean', { ids: [...maintSelected].join(',') });
            toast(`${r.removed} item(ns) removidos - ${r.freedMB} MB liberados`, 'ok');
            maintSelected.clear();
            loadMaintenance();
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
    }, maintList);

    /* ---------------------------------------------------- atualizacao ---- */
    const updateInfo = h('div.stack');

    const checkUpdate = async () => {
      mount(updateInfo, h('div.hstack', {}, h('span.spinner'), 'Verificando...'));
      try {
        const j = await api.get('/api/update-check');
        clear(updateInfo);
        if (!j.configured) {
          updateInfo.appendChild(h('p.small.muted', {}, 'A atualizacao online ainda nao foi configurada (update.json sem endereco).'));
          return;
        }
        if (!j.ok) {
          updateInfo.appendChild(h('p.small.err', {}, 'Nao consegui verificar: ' + (j.err || '')));
          return;
        }
        if (!j.total) {
          updateInfo.appendChild(h('div.hstack', {}, chip('atualizado', 'ok'),
            h('span.small.muted', {}, `Voce esta na versao mais recente (${j.versaoRemota}).`)));
          return;
        }
        updateInfo.append(
          h('div.hstack', {}, chip('nova versao ' + j.versaoRemota, 'warn'),
            h('span.small.muted', {}, `atual: ${j.versaoLocal} - ${j.total} arquivo(s) a atualizar`)),
          j.notas ? h('p.small.muted', {}, j.notas) : null,
          h('div.hstack', {},
            btn('Atualizar programa', {
              small: true, variant: 'primary', icon: 'download',
              onClick: () => { toggleDock(true); runTask({ title: 'Atualizar programa', path: '/api/update-run' }); },
            }),
            btn('Atualizar APKs da nuvem', {
              small: true, icon: 'package',
              onClick: () => { toggleDock(true); runTask({ title: 'Atualizar APKs (nuvem)', path: '/api/update-apks-cloud' }); },
            }))
        );
      } catch (e) { mount(updateInfo, h('p.small.err', {}, e.message)); }
      // Um "Verificar" manual pode revelar uma versao mais nova que a que foi
      // dispensada: a faixa do alto tem que reaparecer nesse caso. Se a versao
      // for a mesma ja dispensada, o refresh respeita a dispensa e nao insiste.
      finally { updatebar.refresh(); }
    };

    /* --------------------------------------------------------- sobre ----- */
    const aboutBox = h('div.grid.grid--3');
    const loadAbout = async () => {
      try {
        const info = await api.get('/api/system/info');
        clear(aboutBox);
        aboutBox.append(
          statTile('Versao do programa', info.versao),
          statTile('scrcpy', info.scrcpy.ok ? info.scrcpy.version : 'nao encontrado',
            info.scrcpy.ok ? (info.scrcpy.bundled ? 'embutido no programa' : info.scrcpy.dir) : 'coloque a pasta do scrcpy em scrcpy\\'),
          statTile('Node', info.node),
          statTile('Servidor ativo ha', fmt.uptime(info.uptimeSec)),
          statTile('Pasta do programa', '...' + String(info.base).slice(-28)),
          statTile('Codigo em disco', info.stale ? 'mudou - reinicie' : 'em dia')
        );
        if (info.stale) toast('O codigo do painel mudou no disco - feche e abra o painel para aplicar', 'warn', 6000);
      } catch (e) { mount(aboutBox, h('p.small.err', {}, e.message)); }
    };

    async function save(patch) {
      try {
        const r = await api.post('/api/settings', patch);
        store.set({ settings: r.settings });
        toast('Preferencia salva', 'ok', 1200);
      } catch (e) { toast(e.message, 'err'); }
    }

    mount(root,
      h('div.grid.grid--2', {}, appearance, mirrorCard),
      h('div.grid.grid--2', {}, wifiCard,
        card('Atualizacao', { actions: [btn('Verificar', { small: true, icon: 'refresh', onClick: checkUpdate })] }, updateInfo)),
      maintenanceCard,
      card('Sobre', {
        actions: [
          btn('Abrir a pasta de logs', { small: true, icon: 'folder', onClick: () => api.get('/api/logs/open') }),
          btn('Restaurar padroes', {
            small: true, icon: 'refresh',
            onClick: async () => {
              if (!await confirmBox('Restaurar padroes', 'Voltar todas as preferencias do painel ao padrao? Os aparelhos conhecidos sao mantidos.')) return;
              const r = await api.get('/api/settings/reset');
              store.set({ settings: r.settings });
              theme.apply(r.settings);
              toast('Preferencias restauradas', 'ok');
              go('settings');
            },
          }),
        ],
      }, aboutBox)
    );

    loadAbout();
    checkUpdate();
    loadMaintenance();
  },

  commands: [
    { label: 'Abrir configuracoes', icon: 'settings', run: () => go('settings') },
  ],
};
