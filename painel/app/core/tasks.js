/* ==========================================================================
   tasks.js - fila de tarefas longas + log ao vivo
   --------------------------------------------------------------------------
   PROBLEMA QUE ISTO RESOLVE: a versao antiga tinha duas variaveis globais
   (running e es). Qualquer botao sobrescrevia o EventSource anterior e o
   painel inteiro travava numa tarefa so. Aqui existe uma FILA: quem precisa de
   exclusividade (scripts que mexem no aparelho) entra na fila; o resto roda em
   paralelo. Tudo com log unificado, cancelamento e notificacao no fim.
   ========================================================================== */

import { createBus, h, toast, download, fmt } from './kit.js';
import { api } from './api.js';

export const taskBus = createBus();

const lines = [];         // historico do log (para baixar)
const MAX_LINES = 4000;
let running = null;       // tarefa exclusiva em execucao
const queue = [];         // tarefas exclusivas aguardando
let seq = 0;

/* ------------------------------------------------------------ classificacao */
export function classify(line) {
  if (/^(>>|==)/.test(line)) return 'head';
  if (/\[!\]|\[err|\[erro|FALHOU|FALTA|AVISO|ERROR/i.test(line)) return 'err';
  if (/seria |verifique|ausente|pulad|\[--\]|nao encontr/i.test(line)) return 'warn';
  if (/\[removido\]|\[clonado\]|\[instalado\]|\[congelado\]|\[restaurado\]|\[ja |\[ok\]|INSTALADO|sucesso|criado|ativado|desligado|concluido/i.test(line)) return 'ok';
  return '';
}

export function logLine(text, kind) {
  const entry = { text, kind: kind || classify(text), at: Date.now() };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.shift();
  taskBus.emit('line', entry);
  return entry;
}

export function clearLog() { lines.length = 0; taskBus.emit('clear'); }
export function logHistory() { return lines; }
export function downloadLog() {
  const txt = lines.map((l) => l.text).join('\r\n');
  download(`log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, txt);
}

/* ----------------------------------------------------------------- estado -- */
export function isBusy() { return !!running; }
export function currentTask() { return running; }
export function pending() { return queue.length; }

/* ---------------------------------------------------------------- notificar */
function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    gain.gain.value = 0.05;
    osc.frequency.value = ok ? 880 : 420;
    osc.start();
    setTimeout(() => { osc.frequency.value = ok ? 1175 : 320; }, 110);
    setTimeout(() => { osc.stop(); ctx.close(); }, 240);
  } catch (_) { }
}

function notify(title, body, ok) {
  if (window.__painelSounds !== false) beep(ok);
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body });
    }
  } catch (_) { }
}

/* ------------------------------------------------------------------ runner -- */
/**
 * Roda uma tarefa SSE.
 *  opts: {title, path, params, exclusive=true, silent=false, onLine, banner}
 *  devolve {id, promise, cancel}
 */
export function runTask(opts) {
  const task = {
    id: ++seq,
    title: opts.title || 'Tarefa',
    path: opts.path,
    params: opts.params || {},
    exclusive: opts.exclusive !== false,
    startedAt: 0,
    state: 'queued',
    code: null,
    stream: null,
  };

  let resolveDone;
  task.promise = new Promise((r) => { resolveDone = r; });
  task.cancel = () => {
    if (task.stream) task.stream.close();
    else {
      const i = queue.indexOf(task);
      if (i >= 0) queue.splice(i, 1);
      task.state = 'cancelled';
      resolveDone(-2);
      taskBus.emit('change');
    }
  };

  const start = () => {
    task.state = 'running';
    task.startedAt = Date.now();
    if (task.exclusive) running = task;
    taskBus.emit('start', task);
    taskBus.emit('change');
    if (!opts.silent) logLine(`== ${task.title} ==`, 'head');

    task.stream = api.stream(task.path, task.params, {
      onLine: (line) => {
        if (!opts.silent) logLine(line);
        opts.onLine?.(line);
      },
      onError: (e) => logLine('[!] ' + e.message, 'err'),
      onDone: (code) => {
        task.code = code;
        task.state = code === 0 ? 'done' : code === -2 ? 'cancelled' : 'failed';
        const secs = ((Date.now() - task.startedAt) / 1000).toFixed(1);
        if (!opts.silent) {
          logLine(
            task.state === 'done' ? `>> ${task.title}: concluido em ${secs}s.`
              : task.state === 'cancelled' ? `>> ${task.title}: cancelado.`
                : `>> ${task.title}: terminou com erro (codigo ${code}).`,
            task.state === 'done' ? 'ok' : task.state === 'cancelled' ? 'warn' : 'err'
          );
        }
        if (!opts.silent) {
          if (task.state === 'done') { toast(`${task.title}: concluido`, 'ok'); notify(task.title, 'Concluido', true); }
          else if (task.state === 'failed') { toast(`${task.title}: veja o log`, 'err'); notify(task.title, 'Terminou com erro', false); }
        }
        if (running === task) running = null;
        taskBus.emit('end', task);
        taskBus.emit('change');
        resolveDone(code);
        next();
      },
    });
  };

  const next = () => {
    if (running || !queue.length) return;
    queue.shift().__start();
  };

  task.__start = start;

  if (!task.exclusive) start();
  else if (!running) start();
  else {
    queue.push(task);
    taskBus.emit('change');
    if (!opts.silent) toast(`${task.title} entrou na fila (${queue.length})`, 'info');
  }

  return task;
}

/** Roda varias tarefas em sequencia como uma unica tarefa exclusiva. */
export function runSequence(title, steps, opts = {}) {
  const task = {
    id: ++seq, title, state: 'running', startedAt: Date.now(), exclusive: true, sequence: true,
  };
  let cancelled = false;
  let current = null;
  task.cancel = () => { cancelled = true; current?.close(); };

  task.promise = (async () => {
    if (running) await new Promise((r) => { queue.push({ __start: r, exclusive: true, title, state: 'queued' }); taskBus.emit('change'); });
    running = task;
    taskBus.emit('start', task);
    taskBus.emit('change');
    logLine(`== ${title} ==`, 'head');

    let failures = 0;
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) break;
      const step = steps[i];
      if (step.label) logLine(`-- ${step.label} (${i + 1}/${steps.length}) --`, 'head');
      const code = await new Promise((resolve) => {
        current = api.stream(step.path, step.params || {}, {
          onLine: (l) => { logLine(l); step.onLine?.(l); },
          onError: (e) => logLine('[!] ' + e.message, 'err'),
          onDone: resolve,
        });
      });
      if (code !== 0) failures++;
      step.onDone?.(code);
    }

    task.state = cancelled ? 'cancelled' : failures ? 'failed' : 'done';
    logLine(
      cancelled ? `>> ${title}: cancelado.`
        : failures ? `>> ${title}: ${failures} etapa(s) com erro.`
          : `>> ${title}: concluido.`,
      cancelled ? 'warn' : failures ? 'err' : 'ok'
    );
    if (!opts.silent) {
      toast(task.state === 'done' ? `${title}: concluido` : `${title}: veja o log`, task.state === 'done' ? 'ok' : 'err');
      notify(title, task.state === 'done' ? 'Concluido' : 'Terminou com erro', task.state === 'done');
    }
    running = null;
    taskBus.emit('end', task);
    taskBus.emit('change');
    // libera quem estava na fila
    if (queue.length) queue.shift().__start();
    return task.state === 'done' ? 0 : 1;
  })();

  return task;
}

/* --------------------------------------------------- renderizador do log --- */
export function createLogPane() {
  const pane = h('div.log', { role: 'log', 'aria-live': 'polite' });
  let stick = true;

  pane.addEventListener('scroll', () => {
    stick = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
  });

  const push = (entry) => {
    pane.appendChild(h('div.log__line', { class: entry.kind ? 'log__line--' + entry.kind : '' }, entry.text));
    while (pane.childElementCount > MAX_LINES) pane.firstChild.remove();
    if (stick) pane.scrollTop = pane.scrollHeight;
  };

  for (const l of lines) push(l);
  taskBus.on('line', push);
  taskBus.on('clear', () => { while (pane.firstChild) pane.firstChild.remove(); });

  return pane;
}
