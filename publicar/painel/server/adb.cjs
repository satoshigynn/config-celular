// ============================================================================
//  adb.cjs - camada unica de acesso ao ADB + registro de dispositivos
// ----------------------------------------------------------------------------
//  PROBLEMA QUE ISTO RESOLVE (versao antiga): cada rota do server.cjs fazia seu
//  proprio spawn(ADB, [...]) e parseava a saida na mao. O front perguntava
//  /api/device a cada 4s, o que disparava 2 processos ADB por ciclo, para
//  sempre. Agora existe UM registro no servidor que faz o polling barato
//  (adb devices -l), enriquece os dados so quando mudam (ou a cada 20s para a
//  bateria) e avisa a UI por evento - a UI nao pergunta mais nada.
// ============================================================================
'use strict';

const { EventEmitter } = require('events');
const { ADB, run, runBuffer, util, settings, logs } = require('./core.cjs');

const log = logs.create('adb');

// --------------------------------------------------------------- comandos --
function args(serial, rest) {
  return serial ? ['-s', serial].concat(rest) : rest.slice();
}

async function exec(serial, rest, opts) {
  const r = await run(ADB, args(serial, rest), opts);
  if (r.error && r.code === -1 && /ENOENT/i.test(r.error.code || '')) {
    log.error('adb.exe nao encontrado em ' + ADB);
  }
  return r;
}

// Mesma coisa, mas com stdout binario (screencap, exec-out de arquivos...).
function execBuffer(serial, rest, opts) {
  return runBuffer(ADB, args(serial, rest), opts);
}

// Roda um comando de shell e devolve o stdout (string). O adb junta stderr
// do device no stdout em varios casos - por isso devolvemos os dois.
async function shell(serial, cmd, opts) {
  const r = await exec(serial, ['shell', cmd], opts);
  return { out: r.stdout || '', err: r.stderr || '', code: r.code, all: (r.stdout || '') + (r.stderr || '') };
}

async function shellOk(serial, cmd, opts) {
  const r = await shell(serial, cmd, opts);
  return r.code === 0;
}

// --------------------------------------------------------------- listagem --
const RX_TCP = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;

function parseDevices(stdout) {
  const list = [];
  String(stdout || '').split(/\r?\n/).slice(1).forEach((line) => {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized|authorizing|recovery|sideload|bootloader|host|no permissions)\b/);
    if (!m) return;
    const serial = m[1];
    const field = (k) => (line.match(new RegExp(k + ':(\\S+)')) || [])[1] || '';
    list.push({
      serial,
      state: m[2] === 'no permissions' ? 'unauthorized' : m[2],
      model: (field('model') || '').replace(/_/g, ' '),
      product: field('product'),
      deviceName: field('device'),
      transportId: field('transport_id'),
      transport: RX_TCP.test(serial) ? 'wifi' : 'usb',
    });
  });
  return list;
}

async function listDevices() {
  const r = await exec(null, ['devices', '-l'], { timeout: 12000 });
  return parseDevices(r.stdout);
}

// -------------------------------------------------------- info do aparelho --
// Uma unica ida ao aparelho para tudo que a UI mostra. Marcadores '@@k=v'
// evitam depender da ordem das linhas.
const INFO_CMD = [
  'echo "@@manufacturer=$(getprop ro.product.manufacturer)"',
  'echo "@@brand=$(getprop ro.product.brand)"',
  'echo "@@model=$(getprop ro.product.model)"',
  // O nome COMERCIAL fica numa propriedade diferente em cada fabricante e
  // varias delas nem existem no aparelho. Concatenar e pegar a primeira nao
  // vazia e mais confiavel do que chutar uma so. (Ex.: o realme Note 60x so
  // publica em ro.oppo.market.name.)
  'echo "@@market=$(getprop ro.product.marketname)|$(getprop ro.oppo.market.name)|' +
  '$(getprop ro.vendor.oplus.market.name)|$(getprop ro.product.odm.marketname)|' +
  '$(getprop ro.product.vendor.marketname)|$(getprop ro.config.marketing_name)|' +
  '$(getprop ro.semc.product.name)"',
  // nome que o proprio usuario deu ao aparelho nos Ajustes
  'echo "@@devicename=$(settings get global device_name)"',
  'echo "@@android=$(getprop ro.build.version.release)"',
  'echo "@@sdk=$(getprop ro.build.version.sdk)"',
  'echo "@@rom=$(getprop ro.build.display.id)"',
  'echo "@@abi=$(getprop ro.product.cpu.abi)"',
  'echo "@@serialno=$(getprop ro.serialno)"',
  'echo "@@wifi=$(getprop service.adb.tcp.port)"',
  'echo "@@uptime=$(cat /proc/uptime)"',
  'echo "@@size=$(wm size)"',
  'echo "@@density=$(wm density)"',
  'dumpsys battery | grep -E "level|status|temperature|health"',
  'echo "@@mem=$(grep -m1 MemTotal /proc/meminfo)"',
  'echo "@@memfree=$(grep -m1 MemAvailable /proc/meminfo)"',
  'echo "@@df=$(df /data | tail -1)"',
].join('; ');

const BATTERY_STATUS = { 1: 'desconhecido', 2: 'carregando', 3: 'descarregando', 4: 'nao carrega', 5: 'cheia' };
const BATTERY_HEALTH = { 1: 'desconhecida', 2: 'boa', 3: 'superaquecida', 4: 'morta', 5: 'sobretensao', 6: 'falha', 7: 'fria' };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function gb(kb) { return kb ? (kb / 1048576).toFixed(kb / 1048576 >= 10 ? 0 : 1) : ''; }

async function deviceInfo(serial) {
  const { all } = await shell(serial, INFO_CMD, { timeout: 20000 });
  const g = (k) => ((all.match(new RegExp('@@' + k + '=(.*)')) || [])[1] || '').trim();
  const size = (all.match(/Physical size:\s*(\d+x\d+)/) || [])[1] ||
    (all.match(/@@size=.*?(\d+x\d+)/) || [])[1] || '';
  const override = (all.match(/Override size:\s*(\d+x\d+)/) || [])[1] || '';
  const dens = (all.match(/Physical density:\s*(\d+)/) || [])[1] || '';
  const memTotal = num((all.match(/MemTotal:\s*(\d+)/) || [])[1]);
  const memFree = num((all.match(/MemAvailable:\s*(\d+)/) || [])[1]);
  const df = all.match(/@@df=\S+\s+(\d+)\s+(\d+)\s+(\d+)/);
  const temp = num((all.match(/temperature:\s*(\d+)/) || [])[1]);
  const model = g('model');
  // primeira propriedade de marketing nao vazia
  const market = g('market').split('|').map((s) => s.trim())
    .find((s) => s && s !== 'null' && s.toLowerCase() !== 'other') || '';
  const nomeDoUsuario = (() => {
    const v = g('devicename').trim();
    return (!v || v === 'null' || v === model) ? '' : v;
  })();

  return {
    manufacturer: g('manufacturer'),
    brand: g('brand'),
    model,
    // ordem: nome comercial > nome que o usuario deu no aparelho > modelo
    name: market || nomeDoUsuario || model || serial,
    marketName: market,
    deviceName: nomeDoUsuario,
    android: g('android'),
    sdk: g('sdk'),
    rom: g('rom'),
    abi: g('abi'),
    hwSerial: g('serialno'),
    tcpPort: g('wifi'),
    uptimeSec: Math.round(parseFloat((g('uptime') || '0').split(' ')[0]) || 0),
    resolution: override || size,
    physicalResolution: size,
    density: dens,
    battery: {
      level: num((all.match(/level:\s*(\d+)/) || [])[1]),
      status: BATTERY_STATUS[num((all.match(/status:\s*(\d+)/) || [])[1])] || '',
      health: BATTERY_HEALTH[num((all.match(/health:\s*(\d+)/) || [])[1])] || '',
      tempC: temp ? (temp / 10).toFixed(1) : '',
    },
    ram: { totalGB: gb(memTotal), availGB: gb(memFree) },
    storage: df ? { totalGB: gb(num(df[1])), usedGB: gb(num(df[2])), freeGB: gb(num(df[3])) } : null,
    readAt: Date.now(),
  };
}

// ------------------------------------------------------------------- wifi --
async function ipOf(serial) {
  const { all } = await shell(serial, 'ip -f inet addr show wlan0 2>/dev/null | grep -m1 inet; ip route 2>/dev/null | grep -m1 wlan0', { timeout: 8000 });
  const m = all.match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/) || all.match(/src\s+(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? m[1] : '';
}

async function tcpip(serial, port) {
  const p = Number(port) || settings.get('wifi.port', 5555);
  const r = await exec(serial, ['tcpip', String(p)], { timeout: 15000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim(), port: p };
}

async function connect(hostPort) {
  const r = await exec(null, ['connect', hostPort], { timeout: 12000 });
  const out = (r.stdout + r.stderr).trim();
  return { ok: /connected to/i.test(out) && !/failed|cannot|refused/i.test(out), out };
}

async function disconnect(hostPort) {
  const r = await exec(null, ['disconnect', hostPort], { timeout: 8000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
}

// ---------------------------------------------------------------- forward --
async function forward(serial, local, remote) {
  const r = await exec(serial, ['forward', local, remote], { timeout: 10000 });
  return r.code === 0;
}
async function forwardRemove(serial, local) {
  await exec(serial, ['forward', '--remove', local], { timeout: 8000 });
}

// ------------------------------------------------------------ transferencia -
async function push(serial, local, remote) {
  const r = await exec(serial, ['push', local, remote], { timeout: 180000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
}
async function pull(serial, remote, local) {
  const r = await exec(serial, ['pull', remote, local], { timeout: 300000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
}

// --------------------------------------------------------- alvo (legado) ---
// O setup-celular.ps1 e os demais .ps1 obedecem a ANDROID_SERIAL. Manter isso
// aqui garante que o comportamento antigo continua identico.
let selectedSerial = '';
function setTarget(serial) {
  selectedSerial = serial || '';
  if (selectedSerial) process.env.ANDROID_SERIAL = selectedSerial;
  else delete process.env.ANDROID_SERIAL;
  return selectedSerial;
}
function getTarget() { return selectedSerial; }

// ---------------------------------------------------------------- registro --
class DeviceRegistry extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.devices = new Map();      // serial -> {serial, state, transport, model, info, ...}
    this.pollMs = 2200;
    this.infoTtl = 20000;
    this.timer = null;
    this.reconnectTimer = null;
    this.busy = false;
    this.lastSignature = '';
    this.adbOk = true;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.reconnectTimer = setInterval(() => this.autoReconnect(), 15000);
    log.info('registro de dispositivos iniciado (adb: ' + ADB + ')');
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    clearInterval(this.reconnectTimer); this.reconnectTimer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await listDevices();
      this.adbOk = true;
      const seen = new Set();
      let changed = false;

      for (const d of list) {
        seen.add(d.serial);
        const prev = this.devices.get(d.serial);
        if (!prev) {
          this.devices.set(d.serial, Object.assign({ info: null, infoAt: 0 }, d));
          changed = true;
        } else if (prev.state !== d.state || prev.transport !== d.transport || prev.model !== d.model) {
          Object.assign(prev, d);
          prev.info = null; prev.infoAt = 0;
          changed = true;
        }
      }
      for (const serial of [...this.devices.keys()]) {
        if (!seen.has(serial)) { this.devices.delete(serial); changed = true; }
      }

      // alvo legado: some -> limpa; um unico online -> fixa automaticamente
      const online = this.online();
      if (selectedSerial && !online.some((d) => d.serial === selectedSerial)) setTarget('');
      if (!selectedSerial && online.length === 1) setTarget(online[0].serial);

      // enriquece o que precisa (novo, ou info velha)
      const now = Date.now();
      for (const d of online) {
        if (d.info && now - d.infoAt < this.infoTtl) continue;
        if (d.loading) continue;
        d.loading = true;
        deviceInfo(d.serial).then((info) => {
          const cur = this.devices.get(d.serial);
          if (!cur) return;
          cur.info = info; cur.infoAt = Date.now(); cur.loading = false;
          this.remember(cur);
          this.emitChange();
        }).catch((e) => {
          const cur = this.devices.get(d.serial);
          if (cur) cur.loading = false;
          log.warn('info falhou para ' + d.serial, e.message);
        });
      }

      if (changed) this.emitChange();
    } catch (e) {
      this.adbOk = false;
      log.error('polling falhou', e);
    } finally {
      this.busy = false;
    }
  }

  emitChange() {
    const snap = this.snapshot();
    const sig = JSON.stringify(snap.map((d) => [d.serial, d.state, d.battery, d.resolution]));
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.emit('change', snap);
  }

  online() { return [...this.devices.values()].filter((d) => d.state === 'device'); }

  get(serial) { return this.devices.get(serial) || null; }

  // Resolve o serial que uma acao deve usar: o pedido, o alvo fixado, ou o
  // unico online. Devolve '' quando ha ambiguidade.
  resolve(requested) {
    if (requested && this.devices.has(requested)) return requested;
    if (selectedSerial) return selectedSerial;
    const on = this.online();
    return on.length === 1 ? on[0].serial : '';
  }

  // Chave estavel do aparelho: o serial de HARDWARE nao muda quando ele sai do
  // USB e volta por Wi-Fi (ai o "serial" do adb vira IP:porta). E por ele que
  // o apelido dado pelo usuario e guardado.
  idOf(dev) {
    return (dev && dev.info && dev.info.hwSerial) || (dev && dev.serial) || '';
  }

  aliasOf(dev) {
    const aliases = settings.get('aliases', {}) || {};
    return aliases[this.idOf(dev)] || aliases[dev.serial] || '';
  }

  /** Nome que o painel deve mostrar: apelido, senao o nome comercial. */
  displayName(serial) {
    const d = this.devices.get(serial);
    if (!d) return serial;
    return this.aliasOf(d) || (d.info && d.info.name) || d.model || serial;
  }

  setAlias(serial, nome) {
    const d = this.devices.get(serial);
    if (!d) return false;
    const id = this.idOf(d);
    if (!id) return false;
    const aliases = Object.assign({}, settings.get('aliases', {}) || {});
    if (nome) aliases[id] = nome;
    else { delete aliases[id]; delete aliases[serial]; }
    settings.set('aliases', aliases);   // set(), nao patch(): precisa REMOVER a chave
    this.lastSignature = '';        // forca o evento de mudanca
    this.emitChange();
    return true;
  }

  snapshot() {
    return [...this.devices.values()].map((d) => {
      const i = d.info || {};
      const alias = this.aliasOf(d);
      return {
        id: this.idOf(d),
        serial: d.serial,
        state: d.state,
        transport: d.transport,
        model: i.model || d.model || '',
        alias,
        realName: i.name || d.model || d.serial,
        name: alias || i.name || d.model || d.serial,
        manufacturer: i.manufacturer || '',
        brand: i.brand || '',
        android: i.android || '',
        sdk: i.sdk || '',
        rom: i.rom || '',
        abi: i.abi || '',
        resolution: i.resolution || '',
        density: i.density || '',
        battery: i.battery ? i.battery.level : null,
        batteryStatus: i.battery ? i.battery.status : '',
        batteryTemp: i.battery ? i.battery.tempC : '',
        ram: i.ram || null,
        storage: i.storage || null,
        uptimeSec: i.uptimeSec || 0,
        tcpPort: i.tcpPort || '',
        selected: d.serial === selectedSerial,
        ready: !!d.info,
      };
    }).sort((a, b) => (a.transport === b.transport ? a.serial.localeCompare(b.serial) : a.transport === 'usb' ? -1 : 1));
  }

  // Guarda os aparelhos conhecidos para a reconexao automatica por Wi-Fi.
  remember(dev) {
    if (!dev.info) return;
    const known = settings.get('known', []).slice();
    const id = dev.info.hwSerial || dev.serial;
    const idx = known.findIndex((k) => k.id === id);
    const entry = {
      id,
      serial: dev.serial,
      name: this.aliasOf(dev) || dev.info.name,
      realName: dev.info.name,
      model: dev.info.model,
      android: dev.info.android,
      transport: dev.transport,
      lastSeen: Date.now(),
    };
    if (dev.transport === 'wifi') entry.address = dev.serial;
    else if (idx >= 0 && known[idx].address) entry.address = known[idx].address;
    if (idx >= 0) known[idx] = Object.assign({}, known[idx], entry);
    else known.push(entry);
    settings.patch({ known: known.slice(-24) });
  }

  // Tenta reconectar aparelhos Wi-Fi conhecidos que sumiram.
  async autoReconnect() {
    if (!settings.get('wifi.autoReconnect', true)) return;
    const known = settings.get('known', []);
    const alive = new Set([...this.devices.keys()]);
    for (const k of known) {
      if (!k.address || alive.has(k.address)) continue;
      if (Date.now() - (k.lastSeen || 0) > 7 * 24 * 3600 * 1000) continue;  // some depois de 7 dias
      const r = await connect(k.address);
      if (r.ok) log.info('reconectado por Wi-Fi: ' + k.address);
    }
  }
}

const registry = new DeviceRegistry();

module.exports = {
  ADB, exec, execBuffer, shell, shellOk, listDevices, parseDevices, deviceInfo,
  ipOf, tcpip, connect, disconnect, forward, forwardRemove, push, pull,
  setTarget, getTarget, registry, RX_TCP,
};
