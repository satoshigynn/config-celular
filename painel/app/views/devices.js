/* ==========================================================================
   views/devices.js - dispositivos conectados, detalhes e conexao Wi-Fi
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, promptBox, copy, fmt } from '../core/kit.js';
import { renameDevice } from '../core/rename.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store, bus, currentSerial, selectDevice, onlineDevices } from '../core/state.js';
import { go } from '../core/shell.js';
import { card, statTile, gauge, emptyState, chip, btn, iconBtn, sectionTitle, needDevice } from '../ui/widgets.js';

let unsub = [];

function stateLabel(state) {
  return {
    device: ['online', 'ok'],
    unauthorized: ['autorize no celular', 'warn'],
    offline: ['offline', 'err'],
    authorizing: ['autorizando...', 'warn'],
    recovery: ['recovery', 'warn'],
    bootloader: ['bootloader', 'warn'],
    sideload: ['sideload', 'warn'],
  }[state] || [state, ''];
}

function deviceCard(d) {
  const [label, kind] = stateLabel(d.state);
  const selected = d.serial === currentSerial();

  const specs = [];
  if (d.android) specs.push(chip('Android ' + d.android, '', 'info'));
  if (d.resolution) specs.push(chip(d.resolution));
  if (d.battery != null) {
    const bk = d.battery > 50 ? 'ok' : d.battery >= 20 ? 'warn' : 'err';
    specs.push(chip(d.battery + '%' + (d.batteryStatus === 'carregando' ? ' carregando' : ''), bk, 'battery'));
  }
  if (d.ram && d.ram.totalGB) specs.push(chip(d.ram.totalGB + ' GB RAM', '', 'cpu'));
  if (d.storage && d.storage.freeGB) specs.push(chip(d.storage.freeGB + ' GB livres', '', 'storage'));

  return h('button.devcard', {
    'data-selected': selected ? '1' : '0',
    onclick: () => selectDevice(d.serial),
  },
    h('div.devcard__top', {},
      h('div.devcard__phone', {}, icon('devices', 22)),
      h('div.devcard__id', {},
        h('b', {}, d.name || d.model || d.serial),
        h('small', {}, d.alias
          ? `${d.realName || d.model} - ${d.serial}`
          : (d.manufacturer ? d.manufacturer + ' - ' + d.serial : d.serial))
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end' } },
        chip(label, kind),
        chip(d.transport === 'wifi' ? 'Wi-Fi' : 'USB', d.transport === 'wifi' ? 'info' : '', d.transport === 'wifi' ? 'wifi' : 'usb')
      ),
      iconBtn('edit', 'Renomear este aparelho', (e) => { e.stopPropagation(); renameDevice(d); }, { small: true })
    ),
    specs.length ? h('div.devcard__specs', {}, ...specs) : h('div.xs.faint', {}, 'lendo informacoes...'),
    selected ? h('div.hstack', { style: { marginTop: '4px' } }, chip('selecionado', 'accent', 'check')) : null
  );
}

function detailsPanel(d) {
  if (!d) return emptyState('devices', 'Nenhum aparelho selecionado', 'Escolha um aparelho acima para ver os detalhes.');
  const bat = d.battery || 0;
  const st = d.storage || {};
  const ram = d.ram || {};
  const stPct = st.totalGB ? (Number(st.usedGB) / Number(st.totalGB)) * 100 : 0;
  const ramPct = ram.totalGB ? ((Number(ram.totalGB) - Number(ram.availGB)) / Number(ram.totalGB)) * 100 : 0;
  const batColor = bat > 50 ? 'var(--ok)' : bat >= 20 ? 'var(--warn)' : 'var(--err)';

  return h('div.stack--lg.stack', {},
    h('div.hstack', { style: { justifyContent: 'center', gap: '26px', padding: '8px 0' } },
      gauge(bat, batColor, 'Bateria', (d.batteryTemp ? d.batteryTemp + ' C' : '') + (d.batteryStatus ? ' - ' + d.batteryStatus : '')),
      gauge(stPct, 'var(--info)', 'Armazenamento', st.totalGB ? `${st.freeGB} de ${st.totalGB} GB livres` : '-'),
      gauge(ramPct, 'var(--accent)', 'RAM', ram.totalGB ? `${ram.availGB} de ${ram.totalGB} GB livre` : '-')
    ),
    h('div.grid.grid--3', {},
      statTile('Nome', d.name, d.alias ? 'apelido - original: ' + (d.realName || d.model) : d.model),
      statTile('Fabricante', d.manufacturer || '-', d.brand),
      statTile('Android', d.android ? 'Android ' + d.android : '-', d.sdk ? 'API ' + d.sdk : ''),
      statTile('Resolucao', d.resolution || '-', d.density ? d.density + ' dpi' : ''),
      statTile('Conexao', d.transport === 'wifi' ? 'Wi-Fi' : 'USB', d.serial),
      statTile('Estado', stateLabel(d.state)[0], d.ready ? 'dados atualizados' : 'lendo...'),
      statTile('ROM', d.rom || '-', d.abi || ''),
      statTile('Ligado ha', d.uptimeSec ? fmt.uptime(d.uptimeSec) : '-'),
      statTile('Serial', d.serial, 'clique para copiar')
    )
  );
}

function wifiPanel() {
  const known = store.get('devices');
  const list = h('div.list');

  const paintKnown = async () => {
    try {
      const { known: items } = await api.get('/api/wifi/known');
      clear(list);
      if (!items.length) {
        list.appendChild(h('div.card__body', {}, h('p.muted.small', {},
          'Nenhum aparelho salvo ainda. Ligue o Wi-Fi num aparelho conectado por USB para salva-lo aqui.')));
        return;
      }
      for (const k of items) {
        const connected = store.get('devices').some((d) => d.serial === k.address && d.state === 'device');
        list.appendChild(h('div.row', {},
          h('div.row__icon', {}, icon('wifi', 18)),
          h('div.row__main', {},
            h('b', {}, k.name || k.model || k.id),
            h('small', {}, (k.address || 'sem endereco salvo') + ' - visto ' + fmt.date(k.lastSeen))
          ),
          h('div.row__actions', {},
            connected ? chip('conectado', 'ok') : null,
            k.address && !connected ? btn('Conectar', {
              small: true, icon: 'link', variant: 'primary',
              onClick: async (e) => {
                e.stopPropagation();
                try {
                  await api.get('/api/wifi/connect', { address: k.address });
                  toast('Conectado a ' + k.address, 'ok');
                } catch (err) { toast(err.message, 'err'); }
              },
            }) : null,
            connected ? btn('Desconectar', {
              small: true, icon: 'unlink',
              onClick: async (e) => {
                e.stopPropagation();
                await api.get('/api/wifi/disconnect', { address: k.address });
                toast('Desconectado', 'info');
              },
            }) : null,
            iconBtn('trash', 'Esquecer', async (e) => {
              e.stopPropagation();
              if (!await confirmBox('Esquecer aparelho', `Remover "${k.name || k.id}" da lista de conhecidos? Ele nao sera mais reconectado automaticamente.`)) return;
              await api.get('/api/wifi/forget', { id: k.id });
              paintKnown();
            }, { small: true })
          )
        ));
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  paintKnown();

  return card('Conexao sem fio', {
    subtitle: 'Use o celular sem cabo. O ADB precisa de um primeiro pareamento por USB.',
    actions: [
      btn('Ligar Wi-Fi neste aparelho', {
        variant: 'primary', icon: 'wifi', small: true,
        onClick: async () => {
          const serial = currentSerial();
          if (!serial) return toast('Selecione um aparelho conectado por USB', 'warn');
          toast('Ligando o modo TCP/IP...', 'info');
          try {
            const r = await api.get('/api/wifi/enable', { serial });
            if (r.ok) { toast('Conectado por Wi-Fi em ' + r.address, 'ok'); paintKnown(); }
            else toast(r.err || 'falhou', 'err');
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
      btn('Conectar por IP', {
        small: true, icon: 'link',
        onClick: async () => {
          const addr = await promptBox('Conectar por IP', 'Informe o endereco do aparelho (ex.: 192.168.0.15 ou 192.168.0.15:5555).', '', { placeholder: '192.168.0.15' });
          if (!addr) return;
          try {
            const r = await api.get('/api/wifi/connect', { address: addr });
            toast('Conectado a ' + r.address, 'ok');
            paintKnown();
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
    ],
    flush: true,
  }, list);
}

export const devicesView = {
  id: 'devices',
  title: 'Dispositivos',
  subtitle: 'Aparelhos conectados por USB ou Wi-Fi',
  icon: 'devices',
  group: 'aparelho',

  actions: () => [
    btn('Atualizar', {
      icon: 'refresh', small: true,
      onClick: async () => { await api.get('/api/devices'); toast('Lista atualizada', 'ok', 1200); },
    }),
  ],

  async render(root) {
    const cards = h('div.grid.grid--2');
    const details = h('div');

    const paint = () => {
      const list = store.get('devices');
      clear(cards);
      if (!list.length) {
        cards.appendChild(emptyState('devices', 'Nenhum aparelho conectado',
          'Ligue a Depuracao USB nas Opcoes do desenvolvedor, conecte o cabo e toque em PERMITIR no celular.'));
      } else {
        for (const d of list) cards.appendChild(deviceCard(d));
      }
      const cur = store.get('devices').find((d) => d.serial === currentSerial());
      mount(details, detailsPanel(cur));
    };

    unsub.forEach((f) => f());
    unsub = [store.subscribe(paint)];

    mount(root,
      cards,
      card('Detalhes do aparelho', {
        actions: [
          btn('Renomear', {
            small: true, icon: 'edit',
            onClick: () => {
              const cur = store.get('devices').find((x) => x.serial === currentSerial());
              if (cur) renameDevice(cur); else toast('Selecione um aparelho', 'warn');
            },
          }),
          btn('Copiar serial', {
            small: true, icon: 'copy',
            onClick: () => { const s = currentSerial(); if (s) copy(s, 'Serial copiado'); },
          }),
          btn('Espelhar', { small: true, variant: 'primary', icon: 'mirror', onClick: () => go('mirror') }),
        ],
      }, details),
      wifiPanel()
    );

    paint();
  },

  destroy() { unsub.forEach((f) => f()); unsub = []; },

  commands: [
    { label: 'Ligar Wi-Fi no aparelho atual', icon: 'wifi', run: () => go('devices') },
  ],
};
