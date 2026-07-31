/* ==========================================================================
   views/tools.js - ferramentas ADB: reinicio, apps, shell e comandos
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, promptBox, debounce, copy } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, hasDevice } from '../core/state.js';
import { go, toggleDock } from '../core/shell.js';
import { runTask } from '../core/tasks.js';
import { card, btn, iconBtn, chip, field, emptyState, needDevice } from '../ui/widgets.js';
import { labelFor } from '../ui/logos.js';

let appsCache = [];
let selected = new Set();
let shellSocket = null;

const REBOOTS = [
  { mode: 'normal', label: 'Reiniciar', icon: 'refresh', desc: 'Reinicio normal do sistema' },
  { mode: 'recovery', label: 'Recovery', icon: 'shield', desc: 'Modo de recuperacao' },
  { mode: 'bootloader', label: 'Bootloader', icon: 'bolt', desc: 'Modo fastboot classico' },
  { mode: 'fastboot', label: 'Fastboot (fastbootd)', icon: 'bolt', desc: 'Fastboot moderno - Android 10+' },
  { mode: 'sideload', label: 'Sideload', icon: 'package', desc: 'Aplicar update.zip via ADB' },
];

export const toolsView = {
  id: 'tools',
  title: 'Ferramentas',
  subtitle: 'Reinicio, apps do sistema, shell e comandos personalizados',
  icon: 'tools',
  group: 'acoes',

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    /* --------------------------------------------------------- reinicio -- */
    const rebootCard = card('Reiniciar o aparelho', {
      subtitle: 'Recovery, bootloader e fastboot desconectam o ADB ate voltar ao sistema.',
    },
      h('div.btnrow', {}, ...REBOOTS.map((r) => btn(r.label, {
        small: true, icon: r.icon, title: r.desc,
        variant: r.mode === 'normal' ? 'primary' : undefined,
        onClick: async () => {
          if (!await confirmBox('Reiniciar em modo ' + r.label,
            `${r.desc}.\n\nO aparelho vai reiniciar agora. Continuar?`,
            { danger: r.mode !== 'normal' })) return;
          try {
            await api.get('/api/tools/reboot', { serial: currentSerial(), mode: r.mode });
            toast('Comando enviado - reiniciando', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      }))),
      h('div.hstack.mt-3', {},
        btn('Ver aparelhos em fastboot', {
          small: true, icon: 'eye',
          onClick: async () => {
            try {
              const r = await api.get('/api/tools/fastboot', { action: 'devices' });
              await confirmBox('fastboot devices', r.out || '(nenhum)', { okLabel: 'Fechar' });
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Sair do fastboot', {
          small: true, icon: 'refresh',
          onClick: async () => {
            try { const r = await api.get('/api/tools/fastboot', { action: 'reboot' }); toast(r.out || 'ok', 'info'); }
            catch (e) { toast(e.message, 'err'); }
          },
        })
      )
    );

    /* ------------------------------------------------------------- apps -- */
    const appList = h('div.list', { style: { maxHeight: '420px', overflow: 'auto' } });
    const filterInput = h('input.input', { placeholder: 'filtrar por nome ou pacote...' });
    const scopeSel = h('select.select', { style: { maxWidth: '190px' } },
      h('option', { value: '3' }, 'Apps de terceiros'),
      h('option', { value: 'all' }, 'Todos (inclui sistema)'),
      h('option', { value: 'disabled' }, 'Somente desativados'));
    const countChip = h('span.chip', {}, '0 selecionados');

    const paintApps = () => {
      const q = filterInput.value.trim().toLowerCase();
      const scope = scopeSel.value;
      const list = appsCache.filter((a) => {
        if (scope === '3' && !a.third) return false;
        if (scope === 'disabled' && !a.disabled) return false;
        if (!q) return true;
        return a.pkg.toLowerCase().includes(q) || labelFor(a.pkg).toLowerCase().includes(q);
      }).slice(0, 400);

      clear(appList);
      if (!list.length) {
        appList.appendChild(h('div.card__body', {}, h('p.small.muted', {}, 'Nenhum app encontrado.')));
        return;
      }
      for (const a of list) {
        const cb = h('input', {
          type: 'checkbox', checked: selected.has(a.pkg), value: a.pkg,
          onchange: (e) => {
            e.target.checked ? selected.add(a.pkg) : selected.delete(a.pkg);
            countChip.textContent = selected.size + ' selecionados';
          },
        });
        appList.appendChild(h('div.row.row--tight', {}, cb,
          h('div.row__main', {},
            h('b', {}, labelFor(a.pkg)),
            h('small.mono', {}, a.pkg)),
          h('div.row__actions', {},
            a.system ? chip('sistema', 'warn') : chip('terceiro'),
            a.disabled ? chip('desativado', 'err') : null)
        ));
      }
    };

    const loadApps = async () => {
      mount(appList, h('div.card__body', {}, h('div.hstack', {}, h('span.spinner'), 'Lendo os apps...')));
      try {
        const r = await api.get('/api/tools/apps', { serial: currentSerial() });
        appsCache = r.apps || [];
        selected.clear();
        countChip.textContent = '0 selecionados';
        paintApps();
      } catch (e) { mount(appList, h('div.card__body', {}, h('p.small.err', {}, e.message))); }
    };

    const bulk = async (action, title, message, danger) => {
      if (!selected.size) return toast('Selecione ao menos um app', 'warn');
      const names = [...selected].slice(0, 25).map(labelFor).join(', ') + (selected.size > 25 ? '...' : '');
      if (!await confirmBox(title, `${message}\n\n${selected.size} app(s): ${names}`, { danger })) return;
      toggleDock(true);
      await runTask({
        title,
        path: '/api/tools/' + action,
        params: { serial: currentSerial(), pkgs: [...selected].join(',') },
      }).promise;
      loadApps();
    };

    const appsCard = card('Apps instalados', {
      subtitle: 'Desinstalar, desativar (sem apagar do firmware) ou limpar dados.',
      actions: [
        btn('Atualizar', { small: true, icon: 'refresh', onClick: loadApps }),
      ],
      flush: true,
      foot: h('div.hstack', {},
        countChip,
        h('span.spacer'),
        btn('Desativar', {
          small: true, icon: 'eye',
          onClick: () => bulk('disable', 'Desativar apps',
            'Os apps somem da gaveta e param de rodar, mas continuam no firmware (da para reativar).', true),
        }),
        btn('Reativar', {
          small: true, icon: 'check',
          onClick: () => bulk('enable', 'Reativar apps', 'Os apps voltam a aparecer e funcionar.'),
        }),
        btn('Limpar dados', {
          small: true, icon: 'broom',
          onClick: () => bulk('clear', 'Limpar dados', 'Apaga conversas, logins e cache. O app fica como recem-instalado.', true),
        }),
        btn('Desinstalar', {
          small: true, icon: 'trash', variant: 'danger',
          onClick: () => bulk('uninstall', 'Desinstalar apps', 'Remove o app e seus dados do perfil principal.', true),
        })
      ),
    },
      h('div.card__body', {}, h('div.hstack', {}, filterInput, scopeSel)),
      appList
    );

    filterInput.addEventListener('input', debounce(paintApps, 180));
    scopeSel.addEventListener('change', paintApps);

    /* -------------------------------------------------------- manutencao - */
    const maintenanceCard = card('Manutencao do aparelho', {},
      h('div.btnrow', {},
        btn('Limpar cache de todos os apps', {
          small: true, icon: 'broom',
          onClick: async () => {
            if (!await confirmBox('Limpar cache',
              'Roda "pm trim-caches" e apaga o cache de todos os apps.\n\nNao apaga conversas nem logins - so arquivos temporarios.')) return;
            toast('Limpando cache...', 'info');
            try {
              const r = await api.get('/api/tools/trim-caches', { serial: currentSerial() });
              toast(`Cache limpo - ${r.freedMB} MB liberados`, 'ok');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Alterar resolucao', {
          small: true, icon: 'mirror',
          onClick: async () => {
            const v = await promptBox('Resolucao do aparelho',
              'Informe no formato LARGURAxALTURA (ex.: 1080x2400). Isso muda a resolucao REAL do celular, nao a do espelho.', '');
            if (!v) return;
            try { const r = await api.get('/api/tools/wm', { serial: currentSerial(), action: 'size', value: v }); toast(r.out, 'ok'); }
            catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Alterar densidade (dpi)', {
          small: true, icon: 'chart',
          onClick: async () => {
            const v = await promptBox('Densidade da tela', 'Valor entre 80 e 900 (o padrao costuma ser 320 ou 440).', '');
            if (!v) return;
            try { const r = await api.get('/api/tools/wm', { serial: currentSerial(), action: 'density', value: v }); toast(r.out, 'ok'); }
            catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Restaurar tela padrao', {
          small: true, icon: 'refresh',
          onClick: async () => {
            try { const r = await api.get('/api/tools/wm', { serial: currentSerial(), action: 'reset' }); toast(r.out, 'ok'); }
            catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Logcat ao vivo', {
          small: true, icon: 'logs',
          onClick: () => {
            toggleDock(true);
            runTask({ title: 'Logcat', path: '/api/tools/logcat', params: { serial: currentSerial(), level: 'I' }, exclusive: false });
            toast('Logcat na doca de log - use Parar para encerrar', 'info');
          },
        })
      )
    );

    /* ------------------------------------------------------------ shell -- */
    const term = h('div.term', {});
    const cmdInput = h('input.input', { placeholder: 'digite um comando e pressione Enter (ex.: getprop ro.product.model)' });
    const history = [];
    let histIndex = -1;

    const write = (text, cls) => {
      term.appendChild(h('div', { class: cls || '' }, text));
      term.scrollTop = term.scrollHeight;
    };

    const openShell = () => {
      if (shellSocket) return;
      shellSocket = api.socket('/ws/shell', { serial: currentSerial() });
      shellSocket.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.t === 'ready') write('# shell conectado - ' + m.note, 'muted');
        else if (m.t === 'out') write(m.data.replace(/\s+$/, ''), m.kind === 'err' ? 'term__err' : '');
        else if (m.t === 'exit') { write('# shell encerrado (' + m.code + ')', 'muted'); shellSocket = null; }
        else if (m.t === 'error') write('# ' + m.message, 'term__err');
      };
      shellSocket.onclose = () => { shellSocket = null; };
    };

    const runCommand = async () => {
      const cmd = cmdInput.value.trim();
      if (!cmd) return;
      history.push(cmd);
      histIndex = history.length;
      cmdInput.value = '';
      write('$ ' + cmd, 'term__cmd');

      if (shellSocket && shellSocket.readyState === 1) {
        shellSocket.send(JSON.stringify({ t: 'in', data: cmd }));
        return;
      }
      try {
        const r = await api.get('/api/tools/exec', { serial: currentSerial(), cmd });
        write((r.out || '(sem saida)').replace(/\s+$/, ''));
        write(`# ${r.ms} ms`, 'muted');
      } catch (e) { write('# ' + e.message, 'term__err'); }
    };

    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runCommand(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (histIndex > 0) cmdInput.value = history[--histIndex]; }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histIndex < history.length - 1) cmdInput.value = history[++histIndex];
        else { histIndex = history.length; cmdInput.value = ''; }
      }
    });

    const shellCard = card('Shell e comandos', {
      subtitle: 'Comandos rodam no aparelho. Prefixe com "adb " para rodar no PC (ex.: adb devices).',
      actions: [
        btn('Sessao interativa', {
          small: true, icon: 'terminal',
          onClick: () => { openShell(); toast('Shell aberto - o estado (cd, variaveis) e mantido', 'ok'); },
        }),
        btn('Encerrar shell', {
          small: true, icon: 'stop',
          onClick: () => { try { shellSocket?.close(); } catch (_) { } shellSocket = null; write('# shell encerrado', 'muted'); },
        }),
        iconBtn('copy', 'Copiar saida', () => copy(term.textContent, 'Saida copiada'), { small: true }),
        iconBtn('trash', 'Limpar', () => clear(term), { small: true }),
      ],
    },
      term,
      h('div.term-input', {}, cmdInput, btn('Executar', { variant: 'primary', icon: 'play', onClick: runCommand })),
      h('div.hstack.mt-3', {},
        ...[
          ['Modelo', 'getprop ro.product.model'],
          ['Bateria', 'dumpsys battery'],
          ['Wi-Fi', 'dumpsys wifi | head -30'],
          ['Espaco', 'df -h'],
          ['Processos', 'top -b -n 1 | head -20'],
          ['App em foco', 'dumpsys window | grep -m1 mCurrentFocus'],
        ].map(([label, cmd]) => btn(label, {
          small: true,
          onClick: () => { cmdInput.value = cmd; runCommand(); },
        })))
    );

    mount(root, rebootCard, appsCard, maintenanceCard, shellCard);
    loadApps();
  },

  destroy() {
    try { shellSocket?.close(); } catch (_) { }
    shellSocket = null;
  },

  commands: [
    { label: 'Abrir o shell do aparelho', icon: 'terminal', run: () => go('tools') },
    { label: 'Reiniciar o aparelho', icon: 'refresh', run: () => go('tools') },
  ],
};
