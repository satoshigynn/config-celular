/* ==========================================================================
   views/capture.js - print, gravacao de video e audio, pasta de destino
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, fmt } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store, bus, currentSerial, hasDevice } from '../core/state.js';
import { go } from '../core/shell.js';
import { card, btn, iconBtn, chip, field, selectField, emptyState, needDevice, statTile } from '../ui/widgets.js';

let unsub = [];
let timerHandle = null;

export const captureView = {
  id: 'capture',
  title: 'Captura',
  subtitle: 'Prints, gravacao de tela e de audio direto do aparelho',
  icon: 'capture',
  group: 'acoes',

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    const gallery = h('div.list');
    const folderLabel = h('span.mono.small.muted');
    const recStatus = h('div');

    /* ------------------------------------------------------- galeria ----- */
    const loadGallery = async () => {
      try {
        const { dir, files } = await api.get('/api/capture/files');
        folderLabel.textContent = dir;
        clear(gallery);
        if (!files.length) {
          gallery.appendChild(h('div.card__body', {},
            emptyState('capture', 'Nada capturado ainda', 'Os prints e videos aparecem aqui.')));
          return;
        }
        for (const f of files.slice(0, 40)) {
          const isVideo = /\.(mp4|mkv)$/i.test(f.name);
          const isAudio = /\.(opus|m4a)$/i.test(f.name);
          gallery.appendChild(h('div.row', {},
            h('div.row__icon', {}, icon(isVideo ? 'mirror' : isAudio ? 'volumeUp' : 'capture', 17)),
            h('div.row__main', {}, h('b', {}, f.name), h('small', {}, `${f.sizeMB} MB - ${fmt.date(f.at)}`)),
            h('div.row__actions', {},
              btn('Abrir', { small: true, icon: 'external', onClick: () => api.get('/api/capture/open', { name: f.name }) }))
          ));
        }
      } catch (e) { toast(e.message, 'err'); }
    };

    /* ---------------------------------------------------------- print ---- */
    const shotBtn = btn('Capturar tela agora', {
      variant: 'primary', icon: 'capture',
      onClick: async () => {
        const serial = currentSerial();
        if (!serial) return toast('Selecione um aparelho', 'warn');
        shotBtn.disabled = true;
        try {
          const r = await api.get('/api/capture/screenshot', { serial });
          toast(`Print salvo: ${r.name} (${r.sizeMB} MB)`, 'ok');
          loadGallery();
        } catch (e) { toast(e.message, 'err'); }
        finally { shotBtn.disabled = false; }
      },
    });

    /* -------------------------------------------------------- gravacao --- */
    const formatSel = h('select.select',
      {},
      h('option', { value: 'mp4' }, 'MP4 (compativel com tudo)'),
      h('option', { value: 'mkv' }, 'MKV (Matroska)')
    );
    const audioSel = h('select.select', {},
      h('option', { value: 'output' }, 'Som do aparelho (padrao)'),
      h('option', { value: 'mic' }, 'Microfone'),
      h('option', { value: 'playback' }, 'Reproducao (Android 13+)')
    );
    const withAudio = h('input', { type: 'checkbox', checked: true });
    const audioOnly = h('input', { type: 'checkbox' });
    const preview = h('input', { type: 'checkbox' });
    const sizeIn = h('input.input', { type: 'number', value: 1280, min: 0, max: 4096, step: 80 });
    const fpsIn = h('input.input', { type: 'number', value: 60, min: 5, max: 120, step: 5 });
    const brIn = h('input.input', { type: 'number', value: 8, min: 1, max: 60 });

    const startBtn = btn('Iniciar gravacao', { variant: 'primary', icon: 'record', onClick: startRecording });
    const stopBtn = btn('Parar', { icon: 'stop', variant: 'danger', disabled: true, onClick: stopRecording });
    let activeId = '';
    let startedAt = 0;

    async function startRecording() {
      const serial = currentSerial();
      if (!serial) return toast('Selecione um aparelho', 'warn');
      startBtn.disabled = true;
      try {
        const r = await api.get('/api/capture/record/start', {
          serial,
          format: formatSel.value,
          audio: withAudio.checked ? 1 : 0,
          audioOnly: audioOnly.checked ? 1 : 0,
          audioSource: audioSel.value,
          preview: preview.checked ? 1 : 0,
          maxSize: Number(sizeIn.value) || 0,
          maxFps: Number(fpsIn.value) || 60,
          bitrate: (Number(brIn.value) || 8) * 1000000,
        });
        activeId = r.record.id;
        startedAt = Date.now();
        stopBtn.disabled = false;
        paintStatus();
        timerHandle = setInterval(paintStatus, 1000);
        toast('Gravando...', 'ok');
      } catch (e) {
        toast(e.message, 'err');
        startBtn.disabled = false;
      }
    }

    async function stopRecording() {
      if (!activeId) return;
      stopBtn.disabled = true;
      clearInterval(timerHandle);
      try {
        const r = await api.get('/api/capture/record/stop', { id: activeId });
        const rec = r.record || {};
        toast(rec.fileName ? `Gravacao salva: ${rec.fileName}` : 'Gravacao encerrada', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      activeId = '';
      startBtn.disabled = false;
      paintStatus();
      setTimeout(loadGallery, 700);
    }

    function paintStatus() {
      clear(recStatus);
      if (!activeId) {
        recStatus.appendChild(h('p.small.muted', {}, 'Nenhuma gravacao em andamento.'));
        return;
      }
      recStatus.appendChild(h('div.hstack', {},
        h('span.dot.dot--err.dot--live'),
        h('b', {}, 'Gravando'),
        chip(fmt.duration(Date.now() - startedAt), 'err'),
        h('span.small.muted', {}, audioOnly.checked ? 'somente audio' : (withAudio.checked ? 'video + audio' : 'somente video'))
      ));
    }
    paintStatus();

    /* ---------------------------------------------------------- pasta ---- */
    const folderCard = card('Pasta de destino', {
      subtitle: 'Onde prints e gravacoes sao salvos.',
      actions: [
        btn('Escolher pasta', {
          small: true, icon: 'folder',
          onClick: async () => {
            toast('Abrindo o seletor de pasta do Windows...', 'info');
            try {
              const r = await api.get('/api/capture/choose-folder');
              if (r.cancelled) return;
              folderLabel.textContent = r.dir;
              toast('Pasta alterada', 'ok');
              loadGallery();
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        btn('Abrir pasta', { small: true, icon: 'external', onClick: () => api.get('/api/capture/open') }),
      ],
    }, h('div.hstack', {}, icon('folder', 17), folderLabel));

    mount(root,
      h('div.grid.grid--2', {},
        card('Print da tela', { subtitle: 'Captura instantanea em PNG, direto do aparelho.' },
          h('div.stack', {}, shotBtn,
            h('p.small.muted', {}, 'Dica: no espelhamento, o botao "Print da tela" salva o frame atual sem tocar no aparelho.'))),

        card('Gravacao', { subtitle: 'Video com audio usando o cliente nativo do scrcpy.' },
          h('div.stack', {},
            recStatus,
            h('div.hstack', {}, startBtn, stopBtn),
            field('Formato', formatSel),
            h('label.check', {}, withAudio, 'Gravar audio junto'),
            h('label.check', {}, audioOnly, 'Somente audio (sem video)'),
            field('Fonte do audio', audioSel, 'O audio exige Android 11 ou superior'),
            h('label.check', {}, preview, 'Mostrar a janela durante a gravacao'),
            h('p.xs.faint', {}, 'Sem a previa, a janela fica fora da area visivel - ela existe so para o arquivo ser fechado corretamente ao parar. Sempre use o botao Parar.'),
            h('div.grid.grid--3', {},
              field('Resolucao', sizeIn), field('FPS', fpsIn), field('Mbps', brIn))
          ))
      ),
      folderCard,
      card('Capturas recentes', {
        actions: [btn('Atualizar', { small: true, icon: 'refresh', onClick: loadGallery })],
        flush: true,
      }, gallery)
    );

    loadGallery();
  },

  destroy() {
    clearInterval(timerHandle);
    unsub.forEach((f) => f());
    unsub = [];
  },

  commands: [
    {
      label: 'Capturar a tela do aparelho', icon: 'capture',
      run: async () => {
        const serial = currentSerial();
        if (!serial) return toast('Selecione um aparelho', 'warn');
        try {
          const r = await api.get('/api/capture/screenshot', { serial });
          toast('Print salvo: ' + r.name, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
    },
  ],
};
