// ============================================================================
//  ws.cjs - servidor WebSocket minimo (RFC 6455), sem dependencias
// ----------------------------------------------------------------------------
//  Usado para dois fluxos de tempo real:
//    * video do scrcpy (frames H.264 binarios, alto volume)
//    * eventos do painel (dispositivos, tarefas, logs) em JSON
//  Implementa o que o navegador realmente usa: handshake, frames de texto e
//  binarios, fragmentacao, ping/pong e close. Sem extensoes (permessage-deflate
//  nao faz sentido para video ja comprimido).
// ============================================================================
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_MESSAGE = 8 * 1024 * 1024;   // 8 MB por mensagem recebida

class WebSocketConn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.bufferedLimit = 24 * 1024 * 1024;  // acima disso, descarta frames de video
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOp = 0;
    this._alive = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._shutdown('socket-close'));
    socket.on('error', (e) => { this.emit('error', e); this._shutdown('socket-error'); });

    this._ping = setInterval(() => {
      if (!this.open) return;
      if (!this._alive) return this.close(1001, 'sem resposta');
      this._alive = false;
      this._send(OP.PING, Buffer.alloc(0));
    }, 25000);
  }

  // --- envio ---------------------------------------------------------------
  sendText(str) { return this._send(OP.TEXT, Buffer.from(String(str), 'utf8')); }
  sendJson(obj) { try { return this.sendText(JSON.stringify(obj)); } catch (_) { return false; } }

  // dropIfBusy: para video, e melhor perder um frame do que acumular latencia
  sendBinary(buf, dropIfBusy) {
    if (dropIfBusy && this.socket.writableLength > this.bufferedLimit) return false;
    return this._send(OP.BIN, buf);
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;              // FIN + opcode
    try {
      this.socket.write(header);
      if (len) this.socket.write(payload);
      return true;
    } catch (_) { return false; }
  }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code || 1000, 0);
    r.copy(payload, 2);
    this._send(OP.CLOSE, payload);
    this._shutdown('close');
    try { this.socket.end(); } catch (_) { }
  }

  _shutdown(reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this._ping);
    this.emit('close', reason);
    this.removeAllListeners();
  }

  // --- recepcao ------------------------------------------------------------
  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // laco: um TCP chunk pode conter varios frames (ou meio frame)
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) { this.close(1009, 'frame grande demais'); return null; }
      len = lo; off += 8;
    }
    if (len > MAX_MESSAGE) { this.close(1009, 'mensagem grande demais'); return null; }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));   // copia: o buffer sera fatiado
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    switch (f.opcode) {
      case OP.PING: this._send(OP.PONG, f.payload); return;
      case OP.PONG: this._alive = true; return;
      case OP.CLOSE: this._shutdown('peer-close'); try { this.socket.end(); } catch (_) { } return;
      case OP.CONT: {
        this._frags.push(f.payload);
        if (!f.fin) return;
        const full = Buffer.concat(this._frags);
        const op = this._fragOp;
        this._frags = []; this._fragOp = 0;
        this._deliver(op, full);
        return;
      }
      case OP.TEXT:
      case OP.BIN: {
        if (!f.fin) { this._fragOp = f.opcode; this._frags = [f.payload]; return; }
        this._deliver(f.opcode, f.payload);
        return;
      }
      default: this.close(1002, 'opcode invalido');
    }
  }

  _deliver(opcode, payload) {
    this._alive = true;
    if (opcode === OP.TEXT) {
      const text = payload.toString('utf8');
      this.emit('message', text, false);
      if (text && (text[0] === '{' || text[0] === '[')) {
        try { this.emit('json', JSON.parse(text)); } catch (_) { }
      }
    } else {
      this.emit('message', payload, true);
      this.emit('binary', payload);
    }
  }
}

// Faz o handshake HTTP -> WebSocket. Devolve a conexao, ou null se recusado.
function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return null;
  }
  const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${digest}\r\n\r\n`
  );
  const conn = new WebSocketConn(socket, req);
  if (head && head.length) conn._onData(head);
  return conn;
}

function reject(socket, code, message) {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch (_) { }
}

module.exports = { accept, reject, WebSocketConn };
