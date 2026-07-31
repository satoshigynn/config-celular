// ============================================================================
//  scrcpy/control.cjs - codificador do protocolo de CONTROLE do scrcpy
// ----------------------------------------------------------------------------
//  E aqui que "controlar pelo codigo" acontece de verdade: cada clique, tecla,
//  rolagem ou colagem vira um pacote binario escrito no socket de controle do
//  scrcpy-server, exatamente no formato que ele espera (ControlMessageReader).
//
//  Formatos (big-endian, o Java escreve em network order):
//    0  keycode : u8 tipo | u8 acao | i32 keycode | i32 repeat | i32 metaState
//    1  texto   : u8 tipo | u32 tamanho | bytes utf-8
//    2  toque   : u8 tipo | u8 acao | i64 pointerId | POS | u16 pressao
//                 | i32 actionButton | i32 buttons
//    3  scroll  : u8 tipo | POS | i16 h | i16 v | i32 buttons
//    4  voltar  : u8 tipo | u8 acao
//    8  ler CB  : u8 tipo | u8 copyKey
//    9  set CB  : u8 tipo | i64 sequencia | u8 colar | u32 tamanho | bytes
//   10  tela    : u8 tipo | u8 ligada
//   16  abrir   : u8 tipo | u8 tamanho | bytes
//   21  resize  : u8 tipo | u16 largura | u16 altura
//   5,6,7,11,15,17,19,20 : so o byte do tipo
//    POS = i32 x | i32 y | u16 larguraTela | u16 alturaTela
// ============================================================================
'use strict';

const TYPE = {
  KEYCODE: 0,
  TEXT: 1,
  TOUCH: 2,
  SCROLL: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
};

// android.view.MotionEvent
const ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };
// android.view.KeyEvent
const KEY_ACTION = { DOWN: 0, UP: 1 };
const BUTTON = { PRIMARY: 1, SECONDARY: 2, TERTIARY: 4, BACK: 8, FORWARD: 16 };
const META = {
  SHIFT: 0x01, ALT: 0x02, SYM: 0x04, CTRL: 0x1000, METAKEY: 0x10000,
  CAPS_LOCK: 0x100000, NUM_LOCK: 0x200000, SCROLL_LOCK: 0x400000,
};
const POINTER_MOUSE = -1n;   // scrcpy usa -1 (0xFFFFFFFFFFFFFFFF) para o mouse

// android.view.KeyEvent - so o que um teclado de PC precisa
const KEYCODE = {
  UNKNOWN: 0, HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27, CLEAR: 28,
  DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  COMMA: 55, PERIOD: 56, ALT_LEFT: 57, ALT_RIGHT: 58, SHIFT_LEFT: 59, SHIFT_RIGHT: 60,
  TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, GRAVE: 68, MINUS: 69, EQUALS: 70,
  LEFT_BRACKET: 71, RIGHT_BRACKET: 72, BACKSLASH: 73, SEMICOLON: 74, APOSTROPHE: 75,
  SLASH: 76, AT: 77, MENU: 82, NOTIFICATION: 83,
  MEDIA_PLAY_PAUSE: 85, MEDIA_STOP: 86, MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88,
  PAGE_UP: 92, PAGE_DOWN: 93, ESCAPE: 111, FORWARD_DEL: 112,
  CTRL_LEFT: 113, CTRL_RIGHT: 114, CAPS_LOCK: 115, SCROLL_LOCK: 116,
  META_LEFT: 117, META_RIGHT: 118, ZOOM_IN: 168, ZOOM_OUT: 169,
  MOVE_HOME: 122, MOVE_END: 123, INSERT: 124, SETTINGS: 176, APP_SWITCH: 187, ASSIST: 219,
};
// digitos, letras e teclas de funcao seguem sequencias fixas
for (let i = 0; i <= 9; i++) KEYCODE['N' + i] = 7 + i;
for (let i = 0; i < 26; i++) KEYCODE[String.fromCharCode(65 + i)] = 29 + i;
for (let i = 1; i <= 12; i++) KEYCODE['F' + i] = 130 + i;

// KeyboardEvent.code do navegador -> keycode do Android
const CODE_MAP = {
  Backspace: KEYCODE.DEL, Tab: KEYCODE.TAB, Enter: KEYCODE.ENTER, NumpadEnter: KEYCODE.ENTER,
  ShiftLeft: KEYCODE.SHIFT_LEFT, ShiftRight: KEYCODE.SHIFT_RIGHT,
  ControlLeft: KEYCODE.CTRL_LEFT, ControlRight: KEYCODE.CTRL_RIGHT,
  AltLeft: KEYCODE.ALT_LEFT, AltRight: KEYCODE.ALT_RIGHT,
  MetaLeft: KEYCODE.META_LEFT, MetaRight: KEYCODE.META_RIGHT,
  CapsLock: KEYCODE.CAPS_LOCK, Escape: KEYCODE.ESCAPE, Space: KEYCODE.SPACE,
  PageUp: KEYCODE.PAGE_UP, PageDown: KEYCODE.PAGE_DOWN,
  End: KEYCODE.MOVE_END, Home: KEYCODE.MOVE_HOME,
  ArrowLeft: KEYCODE.DPAD_LEFT, ArrowUp: KEYCODE.DPAD_UP,
  ArrowRight: KEYCODE.DPAD_RIGHT, ArrowDown: KEYCODE.DPAD_DOWN,
  Insert: KEYCODE.INSERT, Delete: KEYCODE.FORWARD_DEL,
  Minus: KEYCODE.MINUS, Equal: KEYCODE.EQUALS,
  BracketLeft: KEYCODE.LEFT_BRACKET, BracketRight: KEYCODE.RIGHT_BRACKET,
  Backslash: KEYCODE.BACKSLASH, Semicolon: KEYCODE.SEMICOLON, Quote: KEYCODE.APOSTROPHE,
  Backquote: KEYCODE.GRAVE, Comma: KEYCODE.COMMA, Period: KEYCODE.PERIOD, Slash: KEYCODE.SLASH,
  NumpadAdd: KEYCODE.EQUALS, NumpadSubtract: KEYCODE.MINUS,
  AudioVolumeUp: KEYCODE.VOLUME_UP, AudioVolumeDown: KEYCODE.VOLUME_DOWN,
};
for (let i = 0; i <= 9; i++) { CODE_MAP['Digit' + i] = KEYCODE['N' + i]; CODE_MAP['Numpad' + i] = KEYCODE['N' + i]; }
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); CODE_MAP['Key' + c] = KEYCODE[c]; }
for (let i = 1; i <= 12; i++) CODE_MAP['F' + i] = KEYCODE['F' + i];

// --------------------------------------------------------------- helpers ---
function clampI32(v) { return Math.max(-2147483648, Math.min(2147483647, Math.round(v || 0))); }
function clampU16(v) { return Math.max(0, Math.min(65535, Math.round(v || 0))); }

// pressao 0..1 -> u16 (0xffff = 1.0)
function encodePressure(p) {
  const v = Math.max(0, Math.min(1, Number(p == null ? 1 : p)));
  return v >= 1 ? 0xffff : Math.round(v * 65536) & 0xffff;
}
// o servidor multiplica por 16 ao decodificar, entao dividimos aqui
function encodeScroll(v) {
  const norm = Math.max(-1, Math.min(1, (Number(v) || 0) / 16));
  if (norm >= 1) return 0x7fff;
  return Math.max(-32768, Math.min(32767, Math.round(norm * 32768)));
}

function writePosition(buf, off, x, y, w, h) {
  buf.writeInt32BE(clampI32(x), off);
  buf.writeInt32BE(clampI32(y), off + 4);
  buf.writeUInt16BE(clampU16(w), off + 8);
  buf.writeUInt16BE(clampU16(h), off + 10);
  return off + 12;
}

// ------------------------------------------------------------ construtores --
const msg = {
  empty(type) { return Buffer.from([type]); },

  keycode(action, keycode, repeat, metaState) {
    const b = Buffer.allocUnsafe(14);
    b.writeUInt8(TYPE.KEYCODE, 0);
    b.writeUInt8(action & 0xff, 1);
    b.writeInt32BE(clampI32(keycode), 2);
    b.writeInt32BE(clampI32(repeat || 0), 6);
    b.writeInt32BE(clampI32(metaState || 0), 10);
    return b;
  },

  text(str) {
    const data = Buffer.from(String(str), 'utf8').subarray(0, 300);
    const b = Buffer.allocUnsafe(5 + data.length);
    b.writeUInt8(TYPE.TEXT, 0);
    b.writeUInt32BE(data.length, 1);
    data.copy(b, 5);
    return b;
  },

  touch(action, x, y, screenW, screenH, opts) {
    opts = opts || {};
    const b = Buffer.allocUnsafe(32);
    b.writeUInt8(TYPE.TOUCH, 0);
    b.writeUInt8(action & 0xff, 1);
    b.writeBigInt64BE(opts.pointerId == null ? POINTER_MOUSE : BigInt(opts.pointerId), 2);
    let off = writePosition(b, 10, x, y, screenW, screenH);
    b.writeUInt16BE(encodePressure(action === ACTION.UP ? 0 : opts.pressure), off);
    b.writeInt32BE(clampI32(opts.actionButton == null ? BUTTON.PRIMARY : opts.actionButton), off + 2);
    b.writeInt32BE(clampI32(opts.buttons == null ? (action === ACTION.UP ? 0 : BUTTON.PRIMARY) : opts.buttons), off + 6);
    return b;
  },

  scroll(x, y, screenW, screenH, hScroll, vScroll, buttons) {
    const b = Buffer.allocUnsafe(21);
    b.writeUInt8(TYPE.SCROLL, 0);
    let off = writePosition(b, 1, x, y, screenW, screenH);
    b.writeInt16BE(encodeScroll(hScroll), off);
    b.writeInt16BE(encodeScroll(vScroll), off + 2);
    b.writeInt32BE(clampI32(buttons || 0), off + 4);
    return b;
  },

  backOrScreenOn(action) {
    return Buffer.from([TYPE.BACK_OR_SCREEN_ON, (action == null ? KEY_ACTION.DOWN : action) & 0xff]);
  },

  getClipboard(copyKey) {
    return Buffer.from([TYPE.GET_CLIPBOARD, (copyKey || 0) & 0xff]);
  },

  setClipboard(textStr, paste, sequence) {
    const data = Buffer.from(String(textStr), 'utf8');
    const b = Buffer.allocUnsafe(14 + data.length);
    b.writeUInt8(TYPE.SET_CLIPBOARD, 0);
    b.writeBigInt64BE(BigInt(sequence || 0), 1);
    b.writeUInt8(paste ? 1 : 0, 9);
    b.writeUInt32BE(data.length, 10);
    data.copy(b, 14);
    return b;
  },

  displayPower(on) { return Buffer.from([TYPE.SET_DISPLAY_POWER, on ? 1 : 0]); },
  rotate() { return Buffer.from([TYPE.ROTATE_DEVICE]); },
  resetVideo() { return Buffer.from([TYPE.RESET_VIDEO]); },
  expandNotifications() { return Buffer.from([TYPE.EXPAND_NOTIFICATION_PANEL]); },
  expandSettings() { return Buffer.from([TYPE.EXPAND_SETTINGS_PANEL]); },
  collapsePanels() { return Buffer.from([TYPE.COLLAPSE_PANELS]); },

  startApp(name) {
    const data = Buffer.from(String(name), 'utf8').subarray(0, 255);
    const b = Buffer.allocUnsafe(2 + data.length);
    b.writeUInt8(TYPE.START_APP, 0);
    b.writeUInt8(data.length, 1);
    data.copy(b, 2);
    return b;
  },

  resizeDisplay(w, h) {
    const b = Buffer.allocUnsafe(5);
    b.writeUInt8(TYPE.RESIZE_DISPLAY, 0);
    b.writeUInt16BE(clampU16(w), 1);
    b.writeUInt16BE(clampU16(h), 3);
    return b;
  },
};

// ------------------------------------------------- mensagens vindas do device
// type 0 = clipboard (u32 tamanho + bytes) | 1 = ack (i64) | 2 = uhid output
function parseDeviceMessages(buffer) {
  const out = [];
  let off = 0;
  while (off < buffer.length) {
    const type = buffer[off];
    if (type === 0) {
      if (buffer.length < off + 5) break;
      const len = buffer.readUInt32BE(off + 1);
      if (buffer.length < off + 5 + len) break;
      out.push({ type: 'clipboard', text: buffer.toString('utf8', off + 5, off + 5 + len) });
      off += 5 + len;
    } else if (type === 1) {
      if (buffer.length < off + 9) break;
      out.push({ type: 'ack', sequence: buffer.readBigInt64BE(off + 1).toString() });
      off += 9;
    } else if (type === 2) {
      if (buffer.length < off + 5) break;
      const len = buffer.readUInt16BE(off + 3);
      if (buffer.length < off + 5 + len) break;
      off += 5 + len;
    } else {
      off = buffer.length;   // tipo desconhecido: descarta o resto
    }
  }
  return { messages: out, rest: buffer.subarray(off) };
}

// Traduz um evento vindo do navegador na mensagem binaria correspondente.
// Devolve null quando o evento nao mapeia para nada (tecla desconhecida).
function fromClientEvent(ev, screen) {
  const w = screen && screen.width, h = screen && screen.height;
  switch (ev.t) {
    case 'touch': {
      const action = ev.a === 'up' ? ACTION.UP : ev.a === 'move' ? ACTION.MOVE : ev.a === 'cancel' ? ACTION.CANCEL : ACTION.DOWN;
      return msg.touch(action, ev.x, ev.y, w, h, {
        pointerId: ev.p == null ? undefined : ev.p,
        pressure: ev.pr,
        buttons: ev.b,
        actionButton: ev.ab,
      });
    }
    case 'scroll':
      return msg.scroll(ev.x, ev.y, w, h, ev.h || 0, ev.v || 0, ev.b || 0);
    case 'key': {
      const code = typeof ev.k === 'number' ? ev.k : CODE_MAP[ev.k];
      if (!code) return null;
      return msg.keycode(ev.a === 'up' ? KEY_ACTION.UP : KEY_ACTION.DOWN, code, ev.r || 0, ev.m || 0);
    }
    case 'text': return ev.s ? msg.text(ev.s) : null;
    case 'back': return msg.backOrScreenOn(ev.a === 'up' ? KEY_ACTION.UP : KEY_ACTION.DOWN);
    case 'rotate': return msg.rotate();
    case 'power': return msg.displayPower(ev.on !== false);
    case 'reset': return msg.resetVideo();
    case 'clipboard-get': return msg.getClipboard(ev.copy || 0);
    case 'clipboard-set': return msg.setClipboard(ev.s || '', !!ev.paste, ev.seq || 0);
    case 'notifications': return msg.expandNotifications();
    case 'settings-panel': return msg.expandSettings();
    case 'collapse': return msg.collapsePanels();
    case 'start-app': return ev.s ? msg.startApp(ev.s) : null;
    case 'resize': return msg.resizeDisplay(ev.w, ev.h);
    default: return null;
  }
}

module.exports = { TYPE, ACTION, KEY_ACTION, BUTTON, META, KEYCODE, CODE_MAP, msg, parseDeviceMessages, fromClientEvent };
