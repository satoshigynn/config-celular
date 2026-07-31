// ============================================================================
//  Config Celular - painel local
//  Ponto de entrada do servidor. Mantido neste caminho porque o "Abrir
//  Painel.exe" e o iniciar-painel.bat chamam exatamente painel\server.cjs.
//
//  A logica vive em painel\server\:
//    core.cjs      caminhos, logger, preferencias, processos
//    http.cjs      roteador, estaticos, SSE e seguranca local
//    ws.cjs        WebSocket (RFC 6455) sem dependencias
//    adb.cjs       ADB + registro de dispositivos (polling barato + eventos)
//    scrcpy/       engine nativa: protocolo, controle, sessoes e scrcpy.exe
//    routes/       as rotas HTTP, separadas por assunto
//
//  Uso:  node server.cjs   ->   http://localhost:8787
// ============================================================================
'use strict';

const http = require('http');
const { logs, settings } = require('./server/core.cjs');
const httpx = require('./server/http.cjs');
const ws = require('./server/ws.cjs');
const adb = require('./server/adb.cjs');
const dist = require('./server/scrcpy/dist.cjs');
const { manager } = require('./server/scrcpy/session.cjs');
const native = require('./server/scrcpy/native.cjs');

const routes = {
  devices: require('./server/routes/devices.cjs'),
  mirror: require('./server/routes/mirror.cjs'),
  capture: require('./server/routes/capture.cjs'),
  files: require('./server/routes/files.cjs'),
  tools: require('./server/routes/tools.cjs'),
  legacy: require('./server/routes/legacy.cjs'),
  system: require('./server/routes/system.cjs'),
  help: require('./server/routes/help.cjs'),
  apks: require('./server/routes/apks.cjs'),
};

const apksManager = require('./server/apks.cjs');

const PORT = Number(process.env.PAINEL_PORT) || 8787;
const log = logs.create('painel');

// ------------------------------------------------------------------ rotas --
const router = new httpx.Router();
for (const name of Object.keys(routes)) routes[name].register(router);

const server = http.createServer(httpx.createHandler(router, PORT));

// ------------------------------------------------------------- WebSockets --
// Canal de eventos: a UI recebe dispositivos, sessoes e logs sem ficar
// perguntando. Substitui o polling de 4 segundos da versao antiga.
const eventClients = new Set();

function broadcast(payload) {
  const dead = [];
  for (const c of eventClients) {
    if (!c.open || !c.sendJson(payload)) dead.push(c);
  }
  dead.forEach((c) => eventClients.delete(c));
}

adb.registry.on('change', (devices) => broadcast({ t: 'devices', devices, selected: adb.getTarget() }));
manager.on('change', (sessions) => broadcast({ t: 'sessions', sessions }));
native.events.on('start', (rec) => broadcast({ t: 'process', event: 'start', process: rec }));
native.events.on('end', (rec) => broadcast({ t: 'process', event: 'end', process: rec }));
native.events.on('log', (m) => broadcast({ t: 'process-log', id: m.id, line: m.line }));
logs.subscribe((entry) => {
  if (entry.level === 'debug') return;
  broadcast({ t: 'log', entry });
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); }
  catch (_) { return ws.reject(socket, 400, 'Bad Request'); }

  if (!httpx.hostAllowed(req, PORT) || !httpx.originAllowed(req, PORT)) {
    return ws.reject(socket, 403, 'Forbidden');
  }
  if (url.searchParams.get('_t') !== httpx.TOKEN) {
    return ws.reject(socket, 401, 'Unauthorized');
  }

  const conn = ws.accept(req, socket, head);
  if (!conn) return;

  switch (url.pathname) {
    case '/ws/events':
      eventClients.add(conn);
      conn.on('close', () => eventClients.delete(conn));
      conn.sendJson({
        t: 'hello',
        devices: adb.registry.snapshot(),
        selected: adb.getTarget(),
        sessions: manager.list(),
        processes: native.list(),
        settings: settings.all(),
      });
      break;

    case '/ws/mirror':
      routes.mirror.attach(conn, url).catch((e) => {
        conn.sendJson({ t: 'error', message: e.message || String(e) });
        conn.close(1011, 'falha');
      });
      break;

    case '/ws/shell':
      routes.tools.attachShell(conn, url);
      break;

    default:
      conn.close(1008, 'canal desconhecido');
  }
});

// ------------------------------------------------------------------ subida --
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  A porta ${PORT} ja esta em uso.`);
    console.error(`  O painel provavelmente ja esta aberto em http://localhost:${PORT}\n`);
  } else {
    console.error('Erro no servidor:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  adb.registry.start();
  apksManager.iniciarAgendador();
  const d = await dist.resolve();
  console.log('');
  console.log('  ============================================================');
  console.log('   Config Celular - painel de gerenciamento Android');
  console.log('  ============================================================');
  console.log('   Abra no navegador:  http://localhost:' + PORT);
  console.log('   ADB    : ' + adb.ADB);
  console.log('   scrcpy : ' + (d ? `${d.version} (${d.bundled ? 'embutido' : d.dir})` : 'NAO ENCONTRADO - espelhamento em modo simples'));
  console.log('   Node   : ' + process.version);
  console.log('   (feche esta janela para encerrar)');
  console.log('  ============================================================');
  console.log('');
  log.info(`painel no ar em http://localhost:${PORT}`);
});

// --------------------------------------------------------------- desligar --
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('encerrando (' + reason + ')');
  adb.registry.stop();
  apksManager.pararAgendador();
  try { await manager.stopAll(); } catch (_) { }
  try { await native.stopAll(); } catch (_) { }
  settings.flush();
  try { server.close(); } catch (_) { }
  setTimeout(() => process.exit(0), 400);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log.error('excecao nao tratada', e);
});
process.on('unhandledRejection', (e) => {
  log.error('promessa rejeitada sem tratamento', e instanceof Error ? e : new Error(String(e)));
});
