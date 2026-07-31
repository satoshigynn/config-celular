/* ==========================================================================
   state.js - estado da aplicacao alimentado por WebSocket
   --------------------------------------------------------------------------
   PROBLEMA QUE ISTO RESOLVE: a versao antiga perguntava /api/device a cada 4
   segundos (2 processos ADB por ciclo, para sempre) e cada aba recarregava
   tudo do zero. Agora o servidor AVISA quando algo muda; a UI so escuta.
   ========================================================================== */

import { createStore, createBus, toast } from './kit.js';
import { api } from './api.js';

export const bus = createBus();

export const store = createStore({
  connected: false,
  devices: [],
  selected: '',
  sessions: [],
  processes: [],
  settings: null,
  adbOk: true,
  serverLogs: [],
});

let socket = null;
let retry = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  try { socket = api.socket('/ws/events'); }
  catch (_) { return scheduleRetry(); }

  socket.onopen = () => {
    retry = 0;
    store.set({ connected: true });
    bus.emit('connection', true);
  };

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    switch (msg.t) {
      case 'hello':
        store.set({
          devices: msg.devices || [],
          selected: msg.selected || '',
          sessions: msg.sessions || [],
          processes: msg.processes || [],
          settings: msg.settings || null,
        });
        bus.emit('hello', msg);
        break;
      case 'devices': {
        const before = store.get('devices').map((d) => d.serial).join(',');
        const after = (msg.devices || []).map((d) => d.serial).join(',');
        store.set({ devices: msg.devices || [], selected: msg.selected || '' });
        if (before && before !== after) bus.emit('devices-changed', msg.devices);
        break;
      }
      case 'sessions': store.set({ sessions: msg.sessions || [] }); break;
      case 'process':
        store.set({ processes: (msg.processes) || store.get('processes') });
        bus.emit('process', msg);
        break;
      case 'process-log': bus.emit('process-log', msg); break;
      case 'log': {
        const logs = store.get('serverLogs').concat(msg.entry).slice(-300);
        store.set({ serverLogs: logs });
        bus.emit('server-log', msg.entry);
        break;
      }
      default: bus.emit('ws:' + msg.t, msg);
    }
  };

  socket.onclose = () => {
    store.set({ connected: false });
    bus.emit('connection', false);
    scheduleRetry();
  };
  socket.onerror = () => { try { socket.close(); } catch (_) { } };
}

function scheduleRetry() {
  retry = Math.min(retry + 1, 8);
  const wait = Math.min(500 * retry, 5000);
  retryTimer = setTimeout(connect, wait);
}

export function startRealtime() { connect(); }

/* ------------------------------------------------------------- ajudantes -- */
export function devices() { return store.get('devices'); }
export function onlineDevices() { return store.get('devices').filter((d) => d.state === 'device'); }
export function currentSerial() {
  const sel = store.get('selected');
  if (sel) return sel;
  const on = onlineDevices();
  return on.length === 1 ? on[0].serial : '';
}
export function currentDevice() {
  const s = currentSerial();
  return store.get('devices').find((d) => d.serial === s) || null;
}
export function hasDevice() {
  const d = currentDevice();
  return !!d && d.state === 'device';
}
export function sessionFor(serial) {
  return store.get('sessions').find((s) => s.serial === (serial || currentSerial())) || null;
}

export async function selectDevice(serial) {
  try {
    await api.get('/api/devices/select', { serial });
    store.set({ selected: serial });
    bus.emit('device-selected', serial);
  } catch (e) { toast(e.message, 'err'); }
}

/** Garante que ha um aparelho pronto antes de uma acao; avisa se nao houver. */
export function requireDevice() {
  if (hasDevice()) return currentSerial();
  const any = store.get('devices').length;
  toast(any ? 'Escolha um aparelho online na aba Dispositivos' : 'Conecte um celular por USB com a Depuracao USB ligada', 'warn');
  return '';
}
