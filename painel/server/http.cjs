// ============================================================================
//  http.cjs - roteador, arquivos estaticos, SSE e a camada de seguranca local
// ----------------------------------------------------------------------------
//  PROBLEMA QUE ISTO RESOLVE (versao antiga): o servidor mandava
//  'Access-Control-Allow-Origin: *' em TODAS as respostas. Como ele executa
//  comandos no PC e no celular, qualquer site aberto no navegador podia chamar
//  http://localhost:8787/api/app-action?action=uninstall e agir no aparelho.
//  Agora: sem CORS, checagem de Host (anti DNS-rebinding), checagem de Origin
//  e um token de sessao obrigatorio nas rotas /api (via header nas chamadas
//  fetch e via query nas conexoes EventSource, que nao aceitam header).
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS, logs } = require('./core.cjs');

const log = logs.create('http');
const TOKEN = crypto.randomBytes(24).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ------------------------------------------------------------- seguranca ----
// Aceita apenas Host local. Bloqueia DNS-rebinding (dominio malicioso que
// resolve para 127.0.0.1 e passaria pela checagem de Origin).
function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const p = (host.match(/:(\d+)$/) || [])[1];
  if (p && Number(p) !== port) return false;
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;      // navegacao direta / EventSource same-origin antigo
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ].includes(String(origin).toLowerCase());
}

function tokenOf(req, url) {
  return req.headers['x-panel-token'] || url.searchParams.get('_t') || '';
}

function tokenOk(req, url) {
  const t = tokenOf(req, url);
  if (!t || t.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch (_) { return false; }
}

// ---------------------------------------------------------------- respostas -
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, code, type, body, extraHeaders) {
  if (res.writableEnded) return;
  const headers = Object.assign({ 'Content-Type': type }, SECURITY_HEADERS, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}

function json(res, obj, code) {
  send(res, code || 200, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function fail(res, code, message, extra) {
  json(res, Object.assign({ ok: false, err: message }, extra || {}), code || 400);
}

function text(res, body, code) { send(res, code || 200, 'text/plain; charset=utf-8', body); }

// Abre um canal SSE. Devolve helpers: line() manda uma linha de log,
// event() manda um evento nomeado, done() encerra com o codigo de saida.
function sse(req, res) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, SECURITY_HEADERS));
  let closed = false;
  const keep = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch (_) { } } }, 20000);
  const end = () => { if (closed) return; closed = true; clearInterval(keep); try { res.end(); } catch (_) { } };
  req.on('close', end);
  return {
    get closed() { return closed; },
    // compatibilidade: o front antigo le 'data: <linha>' cru
    line(l) { if (!closed) { try { res.write(`data: ${l}\n\n`); } catch (_) { } } },
    event(name, data) {
      if (closed) return;
      try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { }
    },
    done(code) { this.line('__DONE__ ' + (code == null ? 0 : code)); end(); },
    end,
    onClose(fn) { req.on('close', fn); },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 2 * 1024 * 1024;
    const chunks = []; let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > max) { reject(new Error('corpo grande demais')); try { req.destroy(); } catch (_) { } return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// ------------------------------------------------------------------ router -
class Router {
  constructor() { this.routes = []; }

  // handler(ctx) onde ctx = {req,res,url,query,params,json,fail,sse,body}
  add(method, pathname, handler) {
    this.routes.push({ method, pathname, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  // aceita GET e POST (varias rotas legadas usam GET com query)
  any(p, h) { return this.add('*', p, h); }

  find(method, pathname) {
    for (const r of this.routes) {
      if (r.pathname !== pathname) continue;
      if (r.method === '*' || r.method === method) return r;
    }
    return null;
  }
}

// -------------------------------------------------------- arquivos estaticos
const staticCache = new Map();  // path -> {mtime, size, etag}

function serveStatic(req, res, urlPath) {
  // resolve dentro de painel\ e recusa qualquer coisa que escape
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(PATHS.painel, rel);
  if (abs !== PATHS.painel && !abs.startsWith(PATHS.painel + path.sep)) {
    send(res, 403, 'text/plain; charset=utf-8', 'acesso negado');
    return true;
  }
  let st;
  try { st = fs.statSync(abs); } catch (_) { return false; }
  if (!st.isFile()) return false;

  const ext = path.extname(abs).toLowerCase();
  const key = abs;
  let meta = staticCache.get(key);
  if (!meta || meta.mtime !== st.mtimeMs || meta.size !== st.size) {
    meta = { mtime: st.mtimeMs, size: st.size, etag: `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"` };
    staticCache.set(key, meta);
  }
  if (req.headers['if-none-match'] === meta.etag) {
    res.writeHead(304, Object.assign({ ETag: meta.etag }, SECURITY_HEADERS));
    res.end();
    return true;
  }
  res.writeHead(200, Object.assign({
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    ETag: meta.etag,
  }, SECURITY_HEADERS));
  fs.createReadStream(abs).pipe(res);
  return true;
}

// Entrega o index.html injetando o token da sessao (o front le do <meta>).
function serveIndex(res) {
  fs.readFile(path.join(PATHS.painel, 'index.html'), 'utf8', (e, html) => {
    if (e) return send(res, 500, 'text/plain; charset=utf-8', 'index.html nao encontrado');
    send(res, 200, 'text/html; charset=utf-8', html.replace('__PANEL_TOKEN__', TOKEN), {
      'Cache-Control': 'no-store',
    });
  });
}

// ------------------------------------------------------------ handler geral -
function createHandler(router, port) {
  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, `http://localhost:${port}`); }
    catch (_) { return send(res, 400, 'text/plain; charset=utf-8', 'url invalida'); }

    if (!hostAllowed(req, port)) return send(res, 403, 'text/plain; charset=utf-8', 'host nao permitido');
    if (!originAllowed(req, port)) return send(res, 403, 'text/plain; charset=utf-8', 'origem nao permitida');

    const pathname = url.pathname;

    // pagina
    if (pathname === '/' || pathname === '/index.html') return serveIndex(res);

    if (pathname.startsWith('/api/')) {
      // o unico endpoint aberto: devolve o token. Como nao ha CORS, uma pagina
      // de outro site consegue chamar mas NAO consegue ler a resposta.
      if (pathname === '/api/session') {
        return json(res, { ok: true, token: TOKEN, pid: process.pid, node: process.version });
      }
      if (!tokenOk(req, url)) return fail(res, 401, 'sessao invalida - recarregue o painel (F5)');

      const route = router.find(req.method, pathname);
      if (!route) return fail(res, 404, 'rota nao encontrada: ' + pathname);

      const ctx = {
        req, res, url,
        method: req.method,
        query: url.searchParams,
        q: (k, d) => url.searchParams.get(k) || (d === undefined ? '' : d),
        qInt: (k, d) => { const n = parseInt(url.searchParams.get(k), 10); return Number.isFinite(n) ? n : d; },
        qBool: (k) => ['1', 'true', 'yes'].includes(String(url.searchParams.get(k) || '').toLowerCase()),
        json: (o, c) => json(res, o, c),
        ok: (o) => json(res, Object.assign({ ok: true }, o || {})),
        fail: (m, c) => fail(res, c || 400, m),
        text: (b, c) => text(res, b, c),
        send: (c, t, b, h) => send(res, c, t, b, h),
        sse: () => sse(req, res),
        body: () => readJson(req),
        raw: (limit) => readBody(req, limit),
      };

      try {
        await route.handler(ctx);
      } catch (e) {
        log.error(`falha em ${pathname}`, e);
        if (!res.headersSent) fail(res, 500, e && e.message ? e.message : 'erro interno');
        else { try { res.end(); } catch (_) { } }
      }
      return;
    }

    // estaticos (app/, favicon, etc.)
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, pathname)) return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'nao encontrado');
  };
}

module.exports = {
  Router, createHandler, TOKEN,
  send, json, fail, text, sse, readBody, readJson,
  hostAllowed, originAllowed, tokenOk,
};
