/* ==========================================================================
   views/files.js - transferencia: instalar APK, enviar, exportar, navegar
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, fmt } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, hasDevice } from '../core/state.js';
import { go, toggleDock } from '../core/shell.js';
import { runTask } from '../core/tasks.js';
import { card, btn, iconBtn, chip, emptyState, needDevice, progressBar, field, selectField } from '../ui/widgets.js';

/* ==========================================================================
   Manter os APKs atualizados
   --------------------------------------------------------------------------
   Cada app tem sua fonte declarada em apks-fontes.json. Antes de substituir
   um APK, o painel compara o certificado de assinatura do arquivo novo com o
   do atual - se nao bater, descarta e mantem o antigo.
   ========================================================================== */
function cardAtualizacao(recarregarLista) {
  const corpo = h('div');

  const pintar = async () => {
    mount(corpo, h('div.hstack', {}, h('span.spinner'), 'Lendo o estado dos APKs...'));
    let s;
    try { s = await api.get('/api/apks/status'); }
    catch (e) { return mount(corpo, h('p.small.err', {}, e.message)); }

    const autoSwitch = h('input', {
      type: 'checkbox', checked: s.autoAtualizar,
      onchange: async (e) => {
        try {
          await api.get('/api/apks/schedule', { on: e.target.checked ? 1 : 0 });
          toast(e.target.checked ? 'Atualizacao automatica ligada' : 'Atualizacao automatica desligada', 'ok');
          pintar();
        } catch (err) { toast(err.message, 'err'); }
      },
    });

    const verifySwitch = h('input', {
      type: 'checkbox', checked: s.verificarAssinatura,
      onchange: async (e) => {
        if (!e.target.checked) {
          const ok = await confirmBox('Desligar a verificacao de assinatura?',
            'Com ela ligada, um APK baixado so substitui o atual se tiver sido assinado pelo MESMO publicador.\n\n' +
            'Desligando, o painel passa a aceitar qualquer arquivo que pareca um APK - inclusive uma versao remontada por terceiros.\n\n' +
            'Recomendo manter ligada.', { danger: true, okLabel: 'Desligar mesmo assim' });
          if (!ok) { e.target.checked = true; return; }
        }
        await api.get('/api/apks/verify-toggle', { on: e.target.checked ? 1 : 0 });
        toast('Verificacao de assinatura ' + (e.target.checked ? 'ligada' : 'desligada'), e.target.checked ? 'ok' : 'warn');
        pintar();
      },
    });

    const lista = h('div.list');
    for (const a of s.apps) {
      const origem = (a.fonte && a.fonte.origem) || (a.fonte && a.fonte.tipo) || '';
      const kindFonte = a.fonte.tipo === 'device' ? 'warn' : a.fonte.tipo === 'manual' ? '' : 'ok';
      lista.appendChild(h('div.row', {},
        h('div.row__icon', {}, icon('package', 16)),
        h('div.row__main', {},
          h('b', {}, a.nome),
          h('small', { style: { whiteSpace: 'normal' } },
            (a.existe ? `${a.tamanhoMB} MB` : 'sem arquivo na pasta') +
            (a.versao ? ` - v${a.versao}` : '') +
            (a.quando ? ` - ${fmt.date(a.quando)}` : '')),
          a.nota ? h('small', { style: { whiteSpace: 'normal', color: 'var(--text-faint)' } }, a.nota) : null),
        h('div.row__actions', {},
          chip(origem, kindFonte),
          iconBtn('shield', 'Ver o certificado de assinatura', async () => {
            try {
              const r = await api.get('/api/apks/cert', { arquivo: a.bundle && !a.existe ? a.bundle : a.arquivo });
              await confirmBox(`Assinatura de ${a.nome}`,
                `SHA-256 do certificado:\n\n${r.sha256.replace(/(.{32})/, '$1\n')}\n\n` +
                'E esta impressao digital que o painel compara antes de aceitar um APK novo.',
                { okLabel: 'Fechar' });
            } catch (e) { toast(e.message, 'err'); }
          }, { small: true }),
          h('span.switch', { title: a.auto ? 'entra na atualizacao automatica' : 'fora do automatico' },
            h('input', {
              type: 'checkbox', checked: a.auto,
              onchange: async (e) => {
                await api.get('/api/apks/auto', { id: a.id, on: e.target.checked ? 1 : 0 });
                toast(`${a.nome}: ${e.target.checked ? 'entra' : 'fica fora'} do automatico`, 'info', 1600);
              },
            }), h('i')))
      ));
    }

    clear(corpo);
    corpo.append(
      h('div.switchrow', {},
        h('div.switchrow__tx', {},
          h('b', {}, 'Atualizar automaticamente'),
          h('small', {}, s.ultimaAtualizacao ? 'ultima vez: ' + fmt.date(s.ultimaAtualizacao) : 'ainda nao rodou')),
        h('span.switch', {}, autoSwitch, h('i'))),
      h('div.switchrow', {},
        h('div.switchrow__tx', {},
          h('b', {}, 'Exigir a mesma assinatura'),
          h('small', {}, 'descarta o download se o certificado nao bater com o APK atual')),
        h('span.switch', {}, verifySwitch, h('i'))),
      h('div.mt-3', {}, selectField('Verificar a cada', String(s.intervaloHoras), [
        { value: '6', label: '6 horas' },
        { value: '12', label: '12 horas' },
        { value: '24', label: '1 dia' },
        { value: '72', label: '3 dias' },
        { value: '168', label: '1 semana' },
      ], async (v) => {
        await api.get('/api/apks/schedule', { horas: v });
        toast('Intervalo salvo', 'ok', 1400);
      })),
      h('div.section-title', { style: { paddingLeft: 0 } }, 'APKs e suas fontes'),
      lista
    );
  };

  const atualizarAgora = async () => {
    toggleDock(true);
    await runTask({ title: 'Atualizar APKs', path: '/api/apks/update' }).promise;
    pintar();
    recarregarLista?.();
  };

  const c = card('Manter os APKs atualizados', {
    subtitle: 'De onde vem cada APK e quando o painel busca versao nova.',
    actions: [
      btn('Atualizar agora', { small: true, variant: 'primary', icon: 'download', onClick: atualizarAgora }),
      iconBtn('refresh', 'Recarregar', () => pintar(), { small: true }),
    ],
  }, corpo);

  pintar();
  return c;
}

let pending = [];           // arquivos enviados ao servidor, aguardando acao
let browsePath = '/sdcard';
let selection = new Set();

export const filesView = {
  id: 'files',
  title: 'Arquivos',
  subtitle: 'Instalar APKs, enviar arquivos e exportar do aparelho',
  icon: 'files',
  group: 'acoes',

  async render(root) {
    // A atualizacao dos APKs vindos de URL oficial NAO precisa de aparelho,
    // entao este cartao aparece mesmo sem nada conectado.
    if (!hasDevice()) {
      return mount(root,
        cardAtualizacao(null),
        card('Enviar, exportar e navegar', {},
          needDevice(() => go('devices'))));
    }

    const queue = h('div.list');
    const apkList = h('div.list');
    const browser = h('div.list');
    const crumbs = h('div.crumbs');
    const grantAll = h('input', { type: 'checkbox' });

    /* ------------------------------------------------------ fila local --- */
    const paintQueue = () => {
      clear(queue);
      if (!pending.length) {
        queue.appendChild(h('div.card__body', {}, h('p.small.muted', {},
          'Arraste APKs ou qualquer arquivo para a area acima. APKs viram instalacao; o resto vai para uma pasta do celular.')));
        return;
      }
      for (const f of pending) {
        queue.appendChild(h('div.row', {},
          h('div.row__icon', {}, icon(f.isApk ? 'package' : 'file', 17)),
          h('div.row__main', {}, h('b', {}, f.name), h('small', {}, `${f.sizeMB} MB`)),
          h('div.row__actions', {},
            f.isApk ? chip('APK', 'accent') : null,
            iconBtn('trash', 'Descartar', async () => {
              await api.get('/api/files/discard', { id: f.id });
              pending = pending.filter((x) => x.id !== f.id);
              paintQueue();
            }, { small: true }))
        ));
      }
    };

    const uploadFiles = async (fileList) => {
      const files = [...fileList];
      if (!files.length) return;
      const bar = progressBar(0);
      const label = h('span.small.muted', {}, 'enviando...');
      const holder = h('div.card__body', {}, h('div.stack', {}, h('div.hstack', {}, label), bar));
      queue.prepend(holder);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        label.textContent = `enviando ${f.name} (${i + 1}/${files.length})`;
        try {
          const r = await api.upload(f, (p) => { bar.firstChild.style.width = Math.round(p * 100) + '%'; });
          pending.push(r);
        } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
      }
      holder.remove();
      paintQueue();
      toast(`${files.length} arquivo(s) prontos`, 'ok');
    };

    const drop = h('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.dataset.over = '1'; },
      ondragleave: () => { drop.dataset.over = '0'; },
      ondrop: (e) => {
        e.preventDefault();
        drop.dataset.over = '0';
        uploadFiles(e.dataTransfer.files);
      },
      onclick: () => picker.click(),
    },
      icon('upload', 34),
      h('b', {}, 'Arraste arquivos aqui'),
      h('p.small', {}, 'APKs (inclusive varios de uma vez), fotos, documentos - ou clique para escolher')
    );
    const picker = h('input', {
      type: 'file', multiple: true, style: { display: 'none' },
      onchange: (e) => { uploadFiles(e.target.files); e.target.value = ''; },
    });

    const installPending = async () => {
      const apks = pending.filter((f) => f.isApk);
      if (!apks.length) return toast('Nenhum APK na fila', 'warn');
      if (!await confirmBox('Instalar APKs', `Instalar ${apks.length} APK(s) no aparelho?\n\n${apks.map((a) => a.name).join('\n')}`)) return;
      toggleDock(true);
      await runTask({
        title: `Instalar ${apks.length} APK(s)`,
        path: '/api/files/install',
        params: { serial: currentSerial(), ids: apks.map((a) => a.id).join(','), grantAll: grantAll.checked ? 1 : 0 },
      }).promise;
      pending = pending.filter((f) => !f.isApk);
      paintQueue();
    };

    const pushPending = async () => {
      const others = pending.filter((f) => !f.isApk);
      if (!others.length) return toast('Nenhum arquivo comum na fila', 'warn');
      const dest = browsePath || '/sdcard/Download';
      if (!await confirmBox('Enviar arquivos', `Enviar ${others.length} arquivo(s) para ${dest}?`)) return;
      toggleDock(true);
      await runTask({
        title: `Enviar ${others.length} arquivo(s)`,
        path: '/api/files/push',
        params: { serial: currentSerial(), ids: others.map((a) => a.id).join(','), dest },
      }).promise;
      pending = pending.filter((f) => f.isApk);
      paintQueue();
      loadBrowser(browsePath);
    };

    /* ------------------------------------------------- APKs do programa --- */
    const loadApks = async () => {
      try {
        const { items } = await api.get('/api/files/apks');
        clear(apkList);
        if (!items.length) return apkList.appendChild(h('div.card__body', {}, h('p.small.muted', {}, 'A pasta apks esta vazia.')));
        for (const it of items) {
          apkList.appendChild(h('div.row', {},
            h('div.row__icon', {}, icon('package', 17)),
            h('div.row__main', {}, h('b', {}, it.name), h('small', {}, `${it.sizeMB} MB${it.bundle ? ' - bundle (base + splits)' : ''}`)),
            h('div.row__actions', {},
              btn('Instalar', {
                small: true, icon: 'download', variant: 'primary',
                onClick: async () => {
                  if (!await confirmBox('Instalar', `Instalar ${it.name} no aparelho?`)) return;
                  toggleDock(true);
                  runTask({
                    title: 'Instalar ' + it.name,
                    path: '/api/files/install',
                    params: { serial: currentSerial(), local: it.name, grantAll: grantAll.checked ? 1 : 0 },
                  });
                },
              }))
          ));
        }
      } catch (e) { toast(e.message, 'err'); }
    };

    /* ---------------------------------------------------- navegador ------ */
    const paintCrumbs = (path) => {
      clear(crumbs);
      const parts = path.split('/').filter(Boolean);
      crumbs.appendChild(h('button', { onclick: () => loadBrowser('/') }, '/'));
      let acc = '';
      parts.forEach((p, i) => {
        acc += '/' + p;
        const target = acc;
        crumbs.appendChild(h('span', {}, '/'));
        crumbs.appendChild(h('button', { onclick: () => loadBrowser(target) }, p));
      });
    };

    const loadBrowser = async (path) => {
      browsePath = path;
      selection.clear();
      paintCrumbs(path);
      mount(browser, h('div.card__body', {}, h('div.hstack', {}, h('span.spinner'), 'Lendo ' + path)));
      try {
        const { entries } = await api.get('/api/files/ls', { serial: currentSerial(), path });
        clear(browser);
        if (!entries.length) {
          browser.appendChild(h('div.card__body', {}, h('p.small.muted', {}, 'Pasta vazia.')));
          return;
        }
        for (const e of entries) {
          const full = (path.replace(/\/+$/, '') + '/' + e.name);
          const check = e.type === 'file'
            ? h('input', {
              type: 'checkbox',
              onchange: (ev) => { ev.target.checked ? selection.add(full) : selection.delete(full); },
            })
            : h('span', { style: { width: '16px' } });
          browser.appendChild(h('div.row.row--tight', {},
            check,
            h('div.row__icon', {}, icon(e.type === 'dir' ? 'folder' : e.type === 'link' ? 'link' : 'file', 16)),
            h('div.row__main', {},
              e.type === 'dir'
                ? h('button.bold', { style: { textAlign: 'left' }, onclick: () => loadBrowser(full) }, e.name)
                : h('b', {}, e.name),
              h('small', {}, `${e.type === 'dir' ? 'pasta' : fmt.bytes(e.size)} - ${e.modified}`))
          ));
        }
      } catch (err) {
        mount(browser, h('div.card__body', {}, h('p.small.err', {}, err.message)));
      }
    };

    const exportSelected = async () => {
      if (!selection.size) return toast('Marque os arquivos que quer exportar', 'warn');
      if (!await confirmBox('Exportar', `Copiar ${selection.size} arquivo(s) do celular para o PC?`)) return;
      toggleDock(true);
      await runTask({
        title: `Exportar ${selection.size} arquivo(s)`,
        path: '/api/files/pull',
        params: { serial: currentSerial(), paths: [...selection].join('|') },
      }).promise;
    };

    mount(root,
      cardAtualizacao(loadApks),
      card('Enviar para o aparelho', {
        subtitle: 'Arraste e solte. APKs sao instalados; os demais arquivos vao para a pasta aberta no navegador abaixo.',
        actions: [
          h('label.check', {}, grantAll, 'Conceder permissoes ao instalar'),
          btn('Instalar APKs da fila', { small: true, variant: 'primary', icon: 'download', onClick: installPending }),
          btn('Enviar arquivos', { small: true, icon: 'upload', onClick: pushPending }),
        ],
      }, drop, picker),
      card('Fila de envio', { flush: true }, queue),

      h('div.grid.grid--2', {},
        card('APKs do programa', {
          subtitle: 'Conteudo da pasta apks\\ - instale com um clique.',
          actions: [btn('Atualizar', { small: true, icon: 'refresh', onClick: loadApks })],
          flush: true,
        }, apkList),

        card('Arquivos do aparelho', {
          subtitle: 'Navegue, marque e exporte para o PC.',
          actions: [
            btn('Exportar marcados', { small: true, icon: 'download', onClick: exportSelected }),
            iconBtn('refresh', 'Recarregar', () => loadBrowser(browsePath), { small: true }),
          ],
          flush: true,
          foot: crumbs,
        }, browser)
      )
    );

    paintQueue();
    loadApks();
    loadBrowser(browsePath);
  },

  commands: [
    { label: 'Instalar um APK', icon: 'package', run: () => go('files') },
    { label: 'Abrir os arquivos do aparelho', icon: 'folder', run: () => go('files') },
  ],
};
