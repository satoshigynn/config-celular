// ============================================================================
//  apks.cjs - manter a pasta apks\ atualizada
// ----------------------------------------------------------------------------
//  Cada app tem sua FONTE declarada em apks-fontes.json:
//    direto  URL oficial fixa       (WhatsApp, Telegram)
//    github  ultimo release do repo (Island)
//    device  extrai de um celular conectado que tenha o app
//    manual  so o usuario coloca    (WebView Test - fora do automatico)
//
//  REGRA DE SEGURANCA: antes de substituir um APK existente, o certificado de
//  assinatura do arquivo novo tem que bater com o do arquivo atual. Assinatura
//  de APK e criptografica: se bater, o pacote e mesmo do publicador original e
//  nao foi remontado. Se nao bater, o download e descartado e o APK bom fica.
//
//  SOBRE VERSAO: nao ha trava. O que a fonte entregar substitui o que estava,
//  para mais ou para menos - a escolha da fonte manda. A versao e lida so para
//  registrar e mostrar no log ("versao: X -> Y"), nunca para bloquear.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { PATHS, ADB, run, util, logs, ensureDir, settings } = require('./core.cjs');
const adb = require('./adb.cjs');

const log = logs.create('apks');
const FONTES = path.join(PATHS.base, 'apks-fontes.json');
const VERSOES = path.join(PATHS.apks, '_versoes.json');
const CERT_PS = path.join(PATHS.painel, 'server', 'cert-apk.ps1');

let rodando = false;
let ultimo = null;      // resumo da ultima execucao

/* ------------------------------------------------------------- catalogo -- */
function lerFontes() {
  try {
    const c = JSON.parse(util.stripBom(fs.readFileSync(FONTES, 'utf8')));
    c.apps = Array.isArray(c.apps) ? c.apps : [];
    return c;
  } catch (e) {
    log.warn('apks-fontes.json ilegivel: ' + e.message);
    return { apps: [], verificarAssinatura: true };
  }
}

function salvarFontes(cfg) {
  fs.writeFileSync(FONTES, JSON.stringify(cfg, null, 2), 'utf8');
}

function lerVersoes() {
  try { return JSON.parse(util.stripBom(fs.readFileSync(VERSOES, 'utf8'))); } catch (_) { return {}; }
}

function salvarVersoes(v) {
  try { ensureDir(PATHS.apks); fs.writeFileSync(VERSOES, JSON.stringify(v, null, 2), 'utf8'); }
  catch (e) { log.warn('nao gravou _versoes.json: ' + e.message); }
}

/* ------------------------------------------------------------- download -- */
function baixar(url, destino, redirecionamentos) {
  redirecionamentos = redirecionamentos || 0;
  return new Promise((resolve, reject) => {
    if (redirecionamentos > 6) return reject(new Error('muitos redirecionamentos'));
    const lib = url.toLowerCase().startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: {
        // UA proprio, honesto. NAO usar UA de navegador: o whatsapp.com
        // responde 400 para navegador (ele quer mandar a pagina de download,
        // nao o arquivo) e redireciona quem nao manda UA para
        // facebook.com/unsupportedbrowser. Identificando-se como ferramenta,
        // ele entrega o APK direto - medido nas duas pontas.
        'User-Agent': 'ConfigCelular/6.0 (atualizador de APK)',
        Accept: '*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let proxima;
        try { proxima = new URL(res.headers.location, url).toString(); } catch (e) { return reject(e); }
        return baixar(proxima, destino, redirecionamentos + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }

      const out = fs.createWriteStream(destino);
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ bytes, tipo: res.headers['content-type'] || '' })));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('tempo esgotado')));
  });
}

// um APK e um ZIP: tem que comecar com 'PK'
function pareceApk(arquivo) {
  try {
    const fd = fs.openSync(arquivo, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch (_) { return false; }
}

/* --------------------------------------------------- assinatura do APK --- */
// Delegado ao PowerShell: usa o apksigner do Android SDK quando existir (que
// reconfere os digests de verdade) e, na falta dele, um parser proprio em .NET
// que apenas LE o certificado.
//   codigos: 0 ok | 2 sem assinatura | 3 arquivo ilegivel | 4 assinatura INVALIDA
async function certificadoDe(arquivoApk) {
  if (!fs.existsSync(CERT_PS)) return { ok: false, err: 'cert-apk.ps1 ausente' };
  const r = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CERT_PS, '-Apk', arquivoApk],
    { timeout: 120000 });
  const saida = ((r.stdout || '') + (r.stderr || '')).trim();
  const campo = (k) => (saida.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';

  if (r.code === 4) return { ok: false, invalido: true, err: campo('ERRO') || 'assinatura invalida' };
  const sha = campo('SHA256');
  if (/^[0-9A-Fa-f]{64}$/.test(sha)) {
    return {
      ok: true,
      sha256: sha.toUpperCase(),
      verificado: campo('VERIFICADO') || 'parcial',   // sim = digests reconferidos
      metodo: campo('METODO') || 'parser',
    };
  }
  return { ok: false, err: (saida.split('\n')[0] || 'nao consegui ler o certificado').replace(/^ERRO:\s*/, '') };
}

/**
 * O APK novo pode substituir o atual?
 *   assinatura invalida       -> NAO (pacote adulterado)
 *   nao existe atual          -> sim (primeira vez, sem referencia)
 *   certificados iguais       -> sim
 *   certificados diferentes   -> NAO (outro assinante)
 */
async function mesmoAssinante(novo, atual) {
  const a = await certificadoDe(novo);

  // ponto de corte: se o proprio pacote nao confere, nem chega a comparar
  if (a.invalido) return { ok: false, motivo: 'ARQUIVO ADULTERADO - ' + a.err };
  if (!a.ok) return { ok: false, motivo: 'nao li a assinatura do arquivo baixado: ' + a.err };

  const forca = a.verificado === 'sim'
    ? 'verificado pelo apksigner'
    : 'so leitura do certificado (Android SDK ausente)';

  if (!fs.existsSync(atual)) {
    return { ok: true, motivo: `primeiro download, sem referencia anterior - ${forca}` };
  }

  const b = await certificadoDe(atual);
  if (b.invalido || !b.ok) {
    return { ok: true, motivo: `o APK atual nao serviu de referencia (${b.err}) - aceito com ${forca}` };
  }
  if (a.sha256 === b.sha256) {
    return { ok: true, motivo: `assinante confere ${a.sha256.slice(0, 16)}... - ${forca}` };
  }
  return {
    ok: false,
    motivo: `ASSINANTE DIFERENTE - baixado ${a.sha256.slice(0, 16)}... x atual ${b.sha256.slice(0, 16)}...`,
  };
}

/* ------------------------------------------------ versao de um arquivo ---- */
// Le pacote/versao direto do .apk com o aapt2 do Android SDK, quando existir.
// E so INFORMATIVO: serve para registrar a versao guardada e mostrar no log o
// que entrou no lugar do que. NAO bloqueia nada - a fonte sempre manda.
let _aapt;
function acharAapt() {
  if (_aapt !== undefined) return _aapt;
  _aapt = null;
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'build-tools'),
    'C:\\Android\\Sdk\\build-tools',
  ];
  for (const b of bases) {
    let versoes = [];
    try { versoes = fs.readdirSync(b).sort().reverse(); } catch (_) { continue; }
    for (const v of versoes) {
      for (const exe of ['aapt2.exe', 'aapt.exe']) {
        const p = path.join(b, v, exe);
        if (fs.existsSync(p)) { _aapt = p; return _aapt; }
      }
    }
  }
  return _aapt;
}

async function versaoDoApk(caminho) {
  const exe = acharAapt();
  if (!exe) return null;
  const r = await run(exe, ['dump', 'badging', caminho], { timeout: 60000 });
  const saida = (r.stdout || '');
  const vc = Number((saida.match(/versionCode='(\d+)'/) || [])[1] || 0);
  if (!vc) return null;
  return {
    pkg: (saida.match(/package: name='([^']+)'/) || [])[1] || '',
    versionName: (saida.match(/versionName='([^']*)'/) || [])[1] || '',
    versionCode: vc,
  };
}

/**
 * Descreve a troca de versao apenas para o LOG. Nunca decide nada: a versao
 * que a fonte entregar substitui a que estava, para mais ou para menos.
 */
async function descreverTroca(novo, atual) {
  if (!fs.existsSync(atual)) return '';
  const [a, b] = await Promise.all([versaoDoApk(novo), versaoDoApk(atual)]);
  if (!a || !b) return '';
  if (a.versionCode > b.versionCode) return `versao: ${b.versionName} -> ${a.versionName}`;
  if (a.versionCode < b.versionCode) return `versao: ${b.versionName} -> ${a.versionName} (REBAIXANDO, a pedido)`;
  return `versao: ${a.versionName} (mesma de antes, reinstalada)`;
}

/* --------------------------------------------- bundles .apks / .xapk ------ */
// Um .apks (ou .xapk/.apkm) e um ZIP com base.apk + splits dentro. O Android
// nao instala esse pacote direto: e preciso descompactar e mandar todos os
// .apk de uma vez com "adb install-multiple".
const EXT_BUNDLE = /\.(apks|xapk|apkm)$/i;
const ehBundle = (arquivo) => EXT_BUNDLE.test(arquivo);

async function extrairBundle(arquivo, destino) {
  fs.rmSync(destino, { recursive: true, force: true });
  ensureDir(destino);
  // Sem o 3o argumento de proposito: o overload (string,string,bool) nao e o
  // que o PowerShell escolhe - ele cai no (string,string,Encoding) e quebra.
  // O destino ja foi apagado acima, entao nao ha o que sobrescrever.
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${arquivo.replace(/'/g, "''")}','${destino.replace(/'/g, "''")}')`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 240000 });
  if (r.code !== 0) throw new Error('nao consegui descompactar: ' + ((r.stderr || '').split('\n')[0] || 'erro'));
  const dentro = fs.readdirSync(destino).filter((f) => /\.apk$/i.test(f));
  if (!dentro.length) throw new Error('o pacote nao tem nenhum .apk dentro');
  return dentro.map((f) => path.join(destino, f));
}

/**
 * Confere a assinatura de TODOS os .apk de um bundle.
 * Exige que passem na verificacao e que compartilhem o mesmo certificado -
 * base e splits de um app real sao sempre assinados pela mesma chave.
 */
async function verificarConjunto(caminhos, diga) {
  const certs = new Set();
  let verificados = 0;
  for (const c of caminhos) {
    const r = await certificadoDe(c);
    if (r.invalido) throw new Error(`${path.basename(c)}: ADULTERADO - ${r.err}`);
    if (!r.ok) throw new Error(`${path.basename(c)}: nao consegui ler a assinatura (${r.err})`);
    if (r.verificado === 'sim') verificados++;
    certs.add(r.sha256);
  }
  if (certs.size > 1) {
    throw new Error(`o pacote mistura ${certs.size} assinantes diferentes - recusado`);
  }
  const cert = [...certs][0];
  diga(`  assinatura: ${caminhos.length} arquivo(s), assinante unico ${cert.slice(0, 16)}...` +
    (verificados === caminhos.length ? ' (verificado pelo apksigner)' : ' (so leitura do certificado)'));
  return cert;
}

/**
 * Adota um .apks baixado a mao: verifica tudo e grava como bundle na pasta
 * apks\, no lugar do que estava. Se ja houver um bundle do mesmo app, o
 * assinante do novo tem que bater com o do antigo.
 */
async function adotarBundle(arquivo, appId, diga) {
  const cfg = lerFontes();
  const app = cfg.apps.find((a) => a.id === appId);
  if (!app) throw new Error('app desconhecido: ' + appId);

  const nomeBundle = app.bundle || (app.arquivo.replace(/\.apk$/i, '') + '-bundle');
  const destino = path.join(PATHS.apks, nomeBundle);
  const temporario = destino + '.part';

  diga(`  descompactando ${path.basename(arquivo)}...`);
  const dentro = await extrairBundle(arquivo, temporario);
  diga(`  ${dentro.length} arquivo(s): ${dentro.map((f) => path.basename(f)).join(', ')}`);

  try {
    const certNovo = await verificarConjunto(dentro, diga);

    if (cfg.verificarAssinatura !== false) {
      // compara com o que ja existe (bundle antigo ou o .apk simples do app)
      const refs = [];
      if (fs.existsSync(destino)) {
        const b = fs.readdirSync(destino).find((f) => /base\.apk$/i.test(f)) || fs.readdirSync(destino).find((f) => /\.apk$/i.test(f));
        if (b) refs.push(path.join(destino, b));
      }
      const simples = path.join(PATHS.apks, app.arquivo);
      if (fs.existsSync(simples)) refs.push(simples);

      if (refs.length) {
        const r = await certificadoDe(refs[0]);
        if (r.ok && r.sha256 !== certNovo) {
          throw new Error(`ASSINANTE DIFERENTE do que voce ja tem (${r.sha256.slice(0, 16)}... x ${certNovo.slice(0, 16)}...) - recusado`);
        }
        if (r.ok) diga(`  confere com o ${path.basename(refs[0])} que ja estava na pasta`);
      } else {
        diga('  (sem referencia anterior para comparar)');
      }
    }

    fs.rmSync(destino, { recursive: true, force: true });
    fs.renameSync(temporario, destino);

    // UM artefato por app: vale o que voce acabou de adotar, seja mais novo ou
    // mais antigo. O .apk avulso sai para nao restar duvida de qual instala.
    const simplesAntigo = path.join(PATHS.apks, app.arquivo);
    if (fs.existsSync(simplesAntigo)) {
      fs.rmSync(simplesAntigo, { force: true });
      diga(`  (${app.arquivo} removido: agora vale o bundle)`);
    }

    const bytes = fs.readdirSync(destino).reduce((s, f) => s + fs.statSync(path.join(destino, f)).size, 0);
    diga(`  [ok] ${nomeBundle} (${util.bytesToMB(bytes)} MB, ${dentro.length} arquivos)`);
    return { bundle: nomeBundle, arquivos: dentro.length, bytes };
  } catch (e) {
    fs.rmSync(temporario, { recursive: true, force: true });
    throw e;
  }
}

/* ------------------------------------------------------------- versoes --- */
async function versaoInstalada(serial, pkg) {
  const { all } = await adb.shell(serial, `dumpsys package ${pkg} | grep -m1 versionName; dumpsys package ${pkg} | grep -m1 versionCode`, { timeout: 25000 });
  return {
    versionName: (all.match(/versionName=(\S+)/) || [])[1] || '',
    versionCode: (all.match(/versionCode=(\d+)/) || [])[1] || '',
  };
}

/* ------------------------------------------------------------- fontes ---- */
async function daUrlDireta(app, diga) {
  const destino = path.join(PATHS.apks, app.arquivo);
  const tmp = destino + '.part';
  diga(`  baixando de ${app.fonte.origem || app.fonte.url}`);
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { }

  const r = await baixar(app.fonte.url, tmp);
  if (!pareceApk(tmp)) {
    try { fs.unlinkSync(tmp); } catch (_) { }
    throw new Error('o arquivo baixado nao e um APK (o site pode ter devolvido uma pagina)');
  }

  // A versao que a fonte entregar SUBSTITUI a que estava, para mais ou para
  // menos. A comparacao abaixo e so para o log.
  const bundleDir = app.bundle ? path.join(PATHS.apks, app.bundle) : '';
  let referencia = destino;
  if (bundleDir && fs.existsSync(bundleDir)) {
    const base = fs.readdirSync(bundleDir).find((f) => /base\.apk$/i.test(f))
      || fs.readdirSync(bundleDir).find((f) => /\.apk$/i.test(f));
    if (base) referencia = path.join(bundleDir, base);
  }
  const troca = await descreverTroca(tmp, referencia);

  const cfg = lerFontes();
  if (cfg.verificarAssinatura !== false) {
    const v = await mesmoAssinante(tmp, referencia);
    diga('  assinatura: ' + v.motivo);
    if (!v.ok) {
      try { fs.unlinkSync(tmp); } catch (_) { }
      throw new Error('DESCARTADO por assinatura diferente - o APK anterior foi mantido');
    }
  }

  fs.renameSync(tmp, destino);
  if (troca) diga('  ' + troca);

  // UM artefato por app: vale o que acabou de chegar da fonte. Deixar os dois
  // formatos faria a tela mostrar uma versao e a instalacao usar outra.
  if (bundleDir && fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    diga(`  (bundle ${app.bundle} removido: agora vale o .apk da fonte)`);
  }
  return { bytes: r.bytes, arquivo: app.arquivo };
}

async function daGithub(app, diga) {
  const api = `https://api.github.com/repos/${app.fonte.repo}/releases/latest`;
  const tmpJson = path.join(PATHS.apks, '.release.json');
  await baixar(api, tmpJson);
  let rel;
  try { rel = JSON.parse(fs.readFileSync(tmpJson, 'utf8')); } finally { try { fs.unlinkSync(tmpJson); } catch (_) { } }
  const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
  if (!asset) throw new Error('nenhum APK no ultimo release');
  diga(`  release ${rel.tag_name}`);
  return daUrlDireta(Object.assign({}, app, {
    fonte: { tipo: 'direto', url: asset.browser_download_url, origem: `GitHub ${rel.tag_name}` },
  }), diga);
}

async function doAparelho(app, serial, diga) {
  if (!serial) throw new Error('nenhum celular conectado - conecte um que tenha este app instalado');
  const r = await adb.shell(serial, `pm path ${app.pkg}`, { timeout: 25000 });
  const caminhos = r.all.split(/\r?\n/)
    .map((l) => l.replace('package:', '').trim())
    .filter((l) => l.endsWith('.apk'));
  if (!caminhos.length) throw new Error(`${app.pkg} nao esta instalado no celular conectado`);

  ensureDir(PATHS.apks);

  // um so arquivo -> .apk simples
  if (caminhos.length === 1) {
    const destino = path.join(PATHS.apks, app.arquivo);
    const tmp = destino + '.part';
    const p = await adb.pull(serial, caminhos[0], tmp);
    if (!p.ok || !pareceApk(tmp)) {
      try { fs.unlinkSync(tmp); } catch (_) { }
      throw new Error('a extracao falhou - o APK anterior foi mantido');
    }
    const cfg = lerFontes();
    if (cfg.verificarAssinatura !== false) {
      const v = await mesmoAssinante(tmp, destino);
      diga('  assinatura: ' + v.motivo);
      if (!v.ok) { try { fs.unlinkSync(tmp); } catch (_) { } throw new Error('DESCARTADO por assinatura diferente'); }
    }
    fs.renameSync(tmp, destino);
    return { bytes: fs.statSync(destino).size, arquivo: app.arquivo };
  }

  // varios arquivos -> pasta de bundle (base + splits)
  const nomeBundle = app.bundle || (app.arquivo.replace(/\.apk$/i, '') + '-bundle');
  const dir = path.join(PATHS.apks, nomeBundle);
  const tmpDir = dir + '.part';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(tmpDir);

  let ok = 0;
  for (const c of caminhos) {
    const alvo = path.join(tmpDir, path.basename(c));
    const p = await adb.pull(serial, c, alvo);
    if (p.ok && pareceApk(alvo)) ok++;
  }
  if (ok !== caminhos.length) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`extrai ${ok}/${caminhos.length} arquivos - bundle anterior mantido`);
  }

  const cfg = lerFontes();
  if (cfg.verificarAssinatura !== false) {
    const baseNovo = path.join(tmpDir, fs.readdirSync(tmpDir).find((f) => /base\.apk$/i.test(f)) || fs.readdirSync(tmpDir)[0]);
    const antigos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /base\.apk$/i.test(f)) : [];
    const baseAntigo = antigos.length ? path.join(dir, antigos[0]) : path.join(dir, '__nao_existe__');
    const v = await mesmoAssinante(baseNovo, baseAntigo);
    diga('  assinatura: ' + v.motivo);
    if (!v.ok) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw new Error('DESCARTADO por assinatura diferente'); }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmpDir, dir);
  const bytes = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  return { bytes, arquivo: nomeBundle, splits: caminhos.length };
}

/* ---------------------------------------------------------- orquestracao -- */
/**
 * Atualiza os APKs marcados com auto:true.
 * @param {function} diga  recebe cada linha de log
 * @param {string[]} somente  ids especificos (vazio = todos os automaticos)
 */
async function atualizar(escrever, somente) {
  if (rodando) { escrever('[!] Ja existe uma atualizacao de APKs em andamento.'); return { ok: false }; }
  rodando = true;
  // tudo que vai para o painel tambem vai para o log em disco: sem isso, uma
  // atualizacao disparada pelo agendador (sem ninguem olhando) nao deixa rastro
  const diga = (l) => {
    try { escrever(l); } catch (_) { }
    if (/^\s*\[!\]/.test(l)) log.warn(l.trim()); else log.info(l.trim());
  };
  const inicio = Date.now();
  const cfg = lerFontes();
  const versoes = lerVersoes();
  const serial = adb.registry.resolve('');
  const alvos = cfg.apps.filter((a) => (somente && somente.length ? somente.includes(a.id) : a.auto !== false));
  const pulados = cfg.apps.filter((a) => a.auto === false).map((a) => a.nome);

  const resumo = { atualizados: [], falhas: [], pulados, inicio };
  diga(`>> Atualizando ${alvos.length} APK(s)...`);
  if (pulados.length) diga(`>> Fora do automatico: ${pulados.join(', ')}`);
  if (!serial) diga('>> (nenhum celular conectado: os apps que dependem de extracao serao pulados)');

  for (const app of alvos) {
    if (app.auto === false && !(somente || []).includes(app.id)) continue;
    diga(`== ${app.nome} ==`);
    try {
      let r;
      if (app.fonte.tipo === 'direto') r = await daUrlDireta(app, diga);
      else if (app.fonte.tipo === 'github') r = await daGithub(app, diga);
      else if (app.fonte.tipo === 'device') r = await doAparelho(app, serial, diga);
      else { diga('  [--] fonte manual: nada a baixar'); continue; }

      // registra a versao DO ARQUIVO que acabou de entrar na pasta - nao a do
      // celular. Sao coisas diferentes: o aparelho pode ter uma versao antiga
      // instalada, e a coluna aqui fala sobre o APK guardado.
      const alvoLido = r.bundle
        ? (() => {
          const d = path.join(PATHS.apks, r.bundle);
          const b = fs.readdirSync(d).find((f) => /base\.apk$/i.test(f)) || fs.readdirSync(d).find((f) => /\.apk$/i.test(f));
          return b ? path.join(d, b) : null;
        })()
        : path.join(PATHS.apks, r.arquivo);
      const vf = alvoLido ? await versaoDoApk(alvoLido).catch(() => null) : null;
      const v = vf || (serial ? await versaoInstalada(serial, app.pkg).catch(() => null) : null);
      if (v && (v.versionName || v.versionCode)) {
        versoes[r.arquivo] = {
          pkg: app.pkg,
          versionName: v.versionName,
          versionCode: String(v.versionCode),
          data: new Date().toISOString().slice(0, 19),
          origem: vf ? 'arquivo' : 'aparelho',
        };
      }
      diga(`  [ok] ${r.arquivo} (${util.bytesToMB(r.bytes)} MB${r.splits ? `, ${r.splits} arquivos` : ''})`);
      resumo.atualizados.push(app.nome);
    } catch (e) {
      diga(`  [!] ${app.nome}: ${e.message}`);
      resumo.falhas.push({ app: app.nome, erro: e.message });
    }
  }

  salvarVersoes(versoes);
  resumo.fim = Date.now();
  resumo.segundos = ((resumo.fim - inicio) / 1000).toFixed(1);
  diga(`>> Concluido em ${resumo.segundos}s: ${resumo.atualizados.length} atualizado(s), ${resumo.falhas.length} falha(s).`);
  ultimo = resumo;
  settings.patch({ apks: { ultimaAtualizacao: Date.now() } });
  rodando = false;
  return resumo;
}

/* ------------------------------------------------------------ agendador -- */
let timer = null;

function iniciarAgendador() {
  pararAgendador();
  const liga = settings.get('apks.autoAtualizar', false);
  if (!liga) return;
  const horas = Math.max(1, Number(settings.get('apks.intervaloHoras', 24)) || 24);

  const tentar = async () => {
    const ultima = Number(settings.get('apks.ultimaAtualizacao', 0)) || 0;
    if (Date.now() - ultima < horas * 3600 * 1000) return;
    if (rodando) return;
    log.info('atualizacao automatica de APKs disparada pelo agendador');
    await atualizar((l) => log.info('[auto] ' + l)).catch((e) => log.error('auto-atualizacao falhou', e));
  };

  // primeira checagem 2 min depois de subir, para nao brigar com o boot
  timer = setTimeout(function ciclo() {
    tentar().finally(() => { timer = setTimeout(ciclo, 60 * 60 * 1000); });
  }, 2 * 60 * 1000);
  log.info(`agendador de APKs ligado (a cada ${horas}h)`);
}

function pararAgendador() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* --------------------------------------------------------------- estado -- */
function estado() {
  const cfg = lerFontes();
  const versoes = lerVersoes();
  const apps = cfg.apps.map((a) => {
    const alvo = path.join(PATHS.apks, a.arquivo);
    const dirBundle = a.bundle ? path.join(PATHS.apks, a.bundle) : '';
    let tamanhoMB = 0, quando = 0, existe = false, formato = '';
    try {
      // O BUNDLE tem prioridade sobre o .apk avulso: quando os dois existem,
      // o bundle e o artefato completo (base + splits) e costuma ser o mais
      // novo. Mostrar o .apk antigo aqui daria a impressao errada de versao.
      if (dirBundle && fs.existsSync(dirBundle)) {
        const arquivos = fs.readdirSync(dirBundle).filter((f) => /\.apk$/i.test(f));
        tamanhoMB = Number(util.bytesToMB(arquivos.reduce((s, f) => s + fs.statSync(path.join(dirBundle, f)).size, 0)));
        quando = fs.statSync(dirBundle).mtimeMs;
        existe = true;
        formato = `bundle (${arquivos.length} arquivos)`;
      } else if (fs.existsSync(alvo)) {
        const s = fs.statSync(alvo);
        tamanhoMB = Number(util.bytesToMB(s.size));
        quando = s.mtimeMs;
        existe = true;
        formato = 'apk unico';
      }
    } catch (_) { }
    const v = (formato.startsWith('bundle') ? versoes[a.bundle] : versoes[a.arquivo])
      || versoes[a.arquivo] || versoes[a.bundle] || null;
    return {
      id: a.id, nome: a.nome, pkg: a.pkg, arquivo: a.arquivo, bundle: a.bundle || '',
      auto: a.auto !== false, fonte: a.fonte, nota: a.nota || '',
      existe, tamanhoMB, quando, formato,
      versao: v ? (v.versionName || '') : '',
    };
  });
  return {
    ok: true,
    apps,
    verificarAssinatura: cfg.verificarAssinatura !== false,
    autoAtualizar: !!settings.get('apks.autoAtualizar', false),
    intervaloHoras: Number(settings.get('apks.intervaloHoras', 24)) || 24,
    ultimaAtualizacao: Number(settings.get('apks.ultimaAtualizacao', 0)) || 0,
    rodando,
    ultimo,
  };
}

function definirAuto(id, ligado) {
  const cfg = lerFontes();
  const app = cfg.apps.find((a) => a.id === id);
  if (!app) return false;
  app.auto = !!ligado;
  salvarFontes(cfg);
  return true;
}

module.exports = {
  atualizar, estado, definirAuto, lerFontes, salvarFontes,
  certificadoDe, mesmoAssinante,
  ehBundle, extrairBundle, verificarConjunto, adotarBundle,
  versaoDoApk, descreverTroca,
  iniciarAgendador, pararAgendador,
  get rodando() { return rodando; },
};
