// ============================================================================
//  scrcpy/native.cjs - processos scrcpy.exe gerenciados pelo programa
// ----------------------------------------------------------------------------
//  A engine embutida (session.cjs) cuida do espelhamento dentro do painel.
//  O cliente nativo entra onde ele e comprovadamente melhor:
//    * GRAVACAO de video COM AUDIO num container de verdade (mkv/mp4)
//    * JANELA nativa (tela cheia real, sempre-no-topo, multi-monitor)
//
//  Mesmo aqui nada e "so abrir o exe": o programa monta os argumentos, segue o
//  ciclo de vida do processo, le o log linha a linha, detecta erro de verdade
//  e para de forma controlada.
//
//  COMO A GRAVACAO PARA DIREITO (medido, nao suposto):
//    matar o processo    -> arquivo de 0 byte (o container nunca e fechado)
//    --no-window + WM_CLOSE -> nao funciona: sem janela nao ha o que fechar
//    com janela + WM_CLOSE  -> arquivo VALIDO e finalizado (moov gravado)
//  Por isso a gravacao roda COM janela, so que estacionada fora da tela
//  (--window-x/-y negativos) quando o usuario nao pediu previa. Parar =
//  WM_CLOSE via CloseMainWindow; encerramento a forca so como ultimo recurso.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PATHS, settings, logs, util, ensureDir, run } = require('../core.cjs');
const dist = require('./dist.cjs');

const log = logs.create('scrcpy:native');
const procs = new Map();   // id -> registro

class NativeProcs extends EventEmitter { }
const events = new NativeProcs();

function captureDir() {
  const dir = settings.get('capture.dir', PATHS.capturas) || PATHS.capturas;
  ensureDir(dir);
  return dir;
}

function baseArgs(serial, o) {
  const a = [];
  if (serial) a.push('--serial=' + serial);
  if (o.maxSize) a.push('--max-size=' + Math.round(o.maxSize));
  if (o.bitrate) a.push('--video-bit-rate=' + Math.round(o.bitrate));
  if (o.maxFps) a.push('--max-fps=' + Math.round(o.maxFps));
  if (o.codec) a.push('--video-codec=' + o.codec);
  if (o.displayId != null) a.push('--display-id=' + o.displayId);
  if (o.crop) a.push('--crop=' + o.crop);
  if (o.captureOrientation) a.push('--capture-orientation=' + o.captureOrientation);
  if (o.stayAwake) a.push('--stay-awake');
  if (o.turnScreenOff) a.push('--turn-screen-off');
  if (o.showTouches) a.push('--show-touches');
  if (o.noControl) a.push('--no-control');
  if (o.powerOffOnClose) a.push('--power-off-on-close');
  if (o.timeLimit) a.push('--time-limit=' + Math.round(o.timeLimit));
  return a;
}

function register(kind, serial, args, meta) {
  const id = util.id(6);
  const exe = meta.exe;
  const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, detached: false });
  const rec = Object.assign({
    id, kind, serial, args, pid: child.pid,
    startedAt: Date.now(), state: 'running', lines: [], error: '',
  }, meta.extra || {});
  delete rec.exe;
  procs.set(id, rec);

  const onLine = (b) => {
    b.toString('utf8').split(/\r?\n/).forEach((l) => {
      if (!l.trim()) return;
      rec.lines.push(l);
      if (rec.lines.length > 120) rec.lines.shift();
      if (/^ERROR/i.test(l)) rec.error = l.replace(/^ERROR:?\s*/i, '');
      events.emit('log', { id, line: l });
    });
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  child.on('close', (code) => {
    rec.state = code === 0 ? 'finished' : (rec.state === 'stopping' ? 'finished' : 'failed');
    rec.exitCode = code;
    rec.endedAt = Date.now();
    if (rec.file) {
      try { rec.sizeMB = Number(util.bytesToMB(fs.statSync(rec.file).size)); } catch (_) { rec.sizeMB = 0; }
    }
    log.info(`${kind} ${id} encerrou (codigo ${code})`);
    events.emit('end', publicRec(rec));
    setTimeout(() => procs.delete(id), 5 * 60 * 1000);
  });
  child.on('error', (e) => {
    rec.state = 'failed'; rec.error = e.message;
    events.emit('end', publicRec(rec));
  });

  rec._child = child;
  log.info(`${kind} ${id} iniciado: ${path.basename(exe)} ${args.join(' ')}`);
  events.emit('start', publicRec(rec));
  return publicRec(rec);
}

function publicRec(r) {
  return {
    id: r.id, kind: r.kind, serial: r.serial, pid: r.pid, state: r.state,
    file: r.file || '', fileName: r.file ? path.basename(r.file) : '',
    startedAt: r.startedAt, endedAt: r.endedAt || 0, sizeMB: r.sizeMB || 0,
    error: r.error || '', title: r.title || '',
    lastLines: r.lines.slice(-6),
  };
}

// ------------------------------------------------------------ janela nativa -
async function openWindow(serial, options) {
  const d = await dist.resolve();
  if (!d || !d.exe) throw new Error('scrcpy.exe nao encontrado - o espelhamento embutido continua funcionando');
  const o = Object.assign({
    maxSize: settings.get('mirror.maxSize', 1280),
    bitrate: settings.get('mirror.bitrate', 8000000),
    maxFps: settings.get('mirror.maxFps', 60),
    codec: settings.get('mirror.codec', 'h264'),
    stayAwake: settings.get('mirror.stayAwake', true),
    audio: true,
    fullscreen: false,
    alwaysOnTop: false,
    borderless: false,
    title: '',
  }, options || {});

  const args = baseArgs(serial, o);
  if (!o.audio) args.push('--no-audio');
  if (o.fullscreen) args.push('--fullscreen');
  if (o.alwaysOnTop) args.push('--always-on-top');
  if (o.borderless) args.push('--window-borderless');
  if (o.title) args.push('--window-title=' + o.title);
  if (o.width) args.push('--window-width=' + Math.round(o.width));
  if (o.height) args.push('--window-height=' + Math.round(o.height));
  args.push('--disable-screensaver');

  return register('window', serial, args, {
    exe: d.exe,
    extra: { title: o.title || ('Espelho ' + serial) },
  });
}

// ----------------------------------------------------------------- gravacao -
async function startRecording(serial, options) {
  const d = await dist.resolve();
  if (!d || !d.exe) throw new Error('scrcpy.exe nao encontrado - a gravacao precisa dele');

  const o = Object.assign({
    format: settings.get('capture.videoFormat', 'mkv'),
    audio: settings.get('capture.audio', true),
    audioOnly: false,
    maxSize: settings.get('mirror.maxSize', 1280),
    bitrate: settings.get('mirror.bitrate', 8000000),
    maxFps: settings.get('mirror.maxFps', 60),
    codec: settings.get('mirror.codec', 'h264'),
    audioSource: 'output',       // output | mic | playback
    audioCodec: '',              // vazio = padrao do scrcpy (opus/aac)
    preview: false,              // mostrar a janela do scrcpy durante a gravacao
    name: '',
    timeLimit: 0,
  }, options || {});

  const fmt = o.audioOnly ? (o.audioCodec === 'aac' ? 'm4a' : 'opus') : (['mkv', 'mp4'].includes(o.format) ? o.format : 'mp4');
  const base = util.safeName(o.name || serial, 'gravacao');
  const file = path.join(captureDir(), `${base}-${util.timestamp()}.${fmt}`);

  const args = baseArgs(serial, o);
  args.push('--record=' + file);
  if (!o.audioOnly) args.push('--record-format=' + fmt);
  if (o.audioOnly) args.push('--no-video');
  if (!o.audio && !o.audioOnly) args.push('--no-audio');
  if (o.audio || o.audioOnly) {
    args.push('--audio-source=' + (['mic', 'playback', 'output'].includes(o.audioSource) ? o.audioSource : 'output'));
    args.push('--no-audio-playback');    // grava o som sem toca-lo nas caixas do PC
    if (o.audioCodec) args.push('--audio-codec=' + o.audioCodec);
    if (o.audioBitrate) args.push('--audio-bit-rate=' + Math.round(o.audioBitrate));
  }
  // A janela precisa existir para o encerramento limpo; se o usuario nao pediu
  // previa, ela nasce fora da area visivel e sem bordas.
  if (o.audioOnly) {
    args.push('--no-window');           // sem video nao ha janela possivel
  } else if (!o.preview) {
    args.push('--window-x=-3000', '--window-y=-3000', '--window-borderless', '--window-title=gravacao');
  }
  args.push('--no-control');            // gravacao nao precisa injetar eventos
  args.push('--disable-screensaver');

  return register('record', serial, args, {
    exe: d.exe,
    extra: {
      file, format: fmt,
      audio: !!(o.audio || o.audioOnly), audioOnly: !!o.audioOnly,
      graceful: !o.audioOnly,           // audio-only nao tem parada limpa
    },
  });
}

// Manda WM_CLOSE para a janela principal do processo - e o "fechar" normal do
// Windows, que o scrcpy trata como pedido de saida e usa para fechar o arquivo.
async function closeMainWindow(pid) {
  const ps = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.Refresh(); $p.CloseMainWindow()`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 });
  return /true/i.test(r.stdout || '');
}

/**
 * Para um processo gerenciado.
 * Ordem: WM_CLOSE (deixa o arquivo ser finalizado) -> espera -> forca.
 * Encerrar a forca uma gravacao produz arquivo de 0 byte, entao o caminho
 * educado tem prioridade e uma janela generosa de espera.
 */
async function stop(id) {
  const rec = procs.get(id);
  if (!rec) return { ok: false, err: 'processo nao encontrado' };
  if (rec.state !== 'running') return { ok: true, already: true };
  rec.state = 'stopping';

  const finished = () => rec.exitCode !== undefined;

  if (rec.graceful !== false) {
    try { await closeMainWindow(rec.pid); } catch (_) { }
    for (let i = 0; i < 24 && !finished(); i++) await util.sleep(250);   // ate 6s
  }

  if (!finished()) {
    log.warn(`${rec.kind} ${id}: sem saida limpa, encerrando a forca` + (rec.file ? ' (o arquivo pode ficar incompleto)' : ''));
    try { rec._child.kill(); } catch (_) { }
    for (let i = 0; i < 8 && !finished(); i++) await util.sleep(250);
  }
  return { ok: true, graceful: rec.graceful !== false };
}

async function stopAll() {
  for (const id of [...procs.keys()]) await stop(id).catch(() => { });
}

function list() { return [...procs.values()].map(publicRec); }
function get(id) { const r = procs.get(id); return r ? publicRec(r) : null; }

module.exports = { openWindow, startRecording, stop, stopAll, list, get, events, captureDir };
