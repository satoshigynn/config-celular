// ============================================================================
//  routes/help.cjs - diagnostico guiado e atalhos para as telas do aparelho
// ----------------------------------------------------------------------------
//  A tela de Ajuda nao e so texto: ela RODA verificacoes no aparelho e diz o
//  que exatamente esta faltando. As sondagens sao todas nao-destrutivas.
// ============================================================================
'use strict';

const fs = require('fs');
const { PATHS, ADB, run, logs, util } = require('../core.cjs');
const adb = require('../adb.cjs');
const dist = require('../scrcpy/dist.cjs');

const log = logs.create('rotas:ajuda');

// Telas de configuracao do Android que o painel sabe abrir. Lista fechada:
// nada do que o navegador manda vira intent solto.
const TELAS = {
  dev: { intent: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS', nome: 'Opcoes do desenvolvedor' },
  about: { intent: 'android.settings.DEVICE_INFO_SETTINGS', nome: 'Sobre o telefone' },
  wifi: { intent: 'android.settings.WIFI_SETTINGS', nome: 'Wi-Fi' },
  apps: { intent: 'android.settings.APPLICATION_SETTINGS', nome: 'Aplicativos' },
  security: { intent: 'android.settings.SECURITY_SETTINGS', nome: 'Seguranca' },
  battery: { intent: 'android.settings.BATTERY_SAVER_SETTINGS', nome: 'Economia de bateria' },
  display: { intent: 'android.settings.DISPLAY_SETTINGS', nome: 'Tela' },
  date: { intent: 'android.settings.DATE_SETTINGS', nome: 'Data e hora' },
  accounts: { intent: 'android.settings.SYNC_SETTINGS', nome: 'Contas' },
  update: { intent: 'android.settings.SYSTEM_UPDATE_SETTINGS', nome: 'Atualizacao do sistema' },
};

// Familia do fabricante -> qual guia mostrar
function familia(fabricante, marca, pacotes) {
  const f = ((fabricante || '') + ' ' + (marca || '')).toLowerCase();
  if (/xiaomi|redmi|poco/.test(f) || /com\.miui\.securitycore/.test(pacotes)) return 'xiaomi';
  if (/samsung/.test(f)) return 'samsung';
  if (/realme|oppo|oneplus/.test(f) || /com\.oplus\.|com\.coloros\./.test(pacotes)) return 'realme';
  if (/motorola|lenovo/.test(f)) return 'motorola';
  if (/google/.test(f)) return 'google';
  return 'generico';
}

function register(router) {
  // ------------------------------------------------------------ diagnostico -
  router.get('/api/help/diagnose', async (ctx) => {
    const checagens = [];
    const add = (id, titulo, estado, detalhe, dica) =>
      checagens.push({ id, titulo, estado, detalhe: detalhe || '', dica: dica || '' });

    // 1. ADB no PC
    const temAdb = fs.existsSync(ADB);
    let versaoAdb = '';
    if (temAdb) {
      const r = await run(ADB, ['version'], { timeout: 10000 });
      versaoAdb = ((r.stdout || '').match(/Version ([\d.]+)/) || [])[1] || '';
    }
    add('adb', 'ADB instalado', temAdb ? 'ok' : 'erro',
      temAdb ? `versao ${versaoAdb || '?'} - ${ADB}` : 'nao encontrei o adb.exe',
      temAdb ? '' : 'A pasta platform-tools deveria estar dentro do programa. Reinstale o Config Celular.');

    // 2. scrcpy
    const d = await dist.resolve();
    add('scrcpy', 'scrcpy disponivel', d ? 'ok' : 'aviso',
      d ? `versao ${d.version}${d.bundled ? ' (embutido)' : ' em ' + d.dir}` : 'nao encontrado',
      d ? '' : 'Sem o scrcpy o espelhamento cai no modo simples (prints, sem controle).');

    // 3. aparelho conectado
    const lista = await adb.listDevices();
    const online = lista.filter((x) => x.state === 'device');
    const naoAutorizado = lista.find((x) => x.state === 'unauthorized');
    if (!lista.length) {
      add('device', 'Aparelho conectado', 'erro', 'nenhum aparelho visivel para o ADB',
        'Use um cabo de DADOS (nem todo cabo serve), troque de porta USB e confirme a Depuracao USB ligada.');
    } else if (naoAutorizado && !online.length) {
      add('device', 'Aparelho conectado', 'erro', `${naoAutorizado.serial} aparece como "unauthorized"`,
        'No celular deve ter surgido um popup "Permitir depuracao USB". Toque em PERMITIR e marque "Sempre permitir".');
    } else {
      add('device', 'Aparelho conectado', 'ok', `${online.length} aparelho(s) online`);
    }

    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) {
      return ctx.json({ ok: true, familia: 'generico', checagens, parcial: true });
    }

    // 4. dados do aparelho, numa unica ida
    const info = await adb.deviceInfo(serial);
    const pacotes = (await adb.shell(serial, 'pm list packages | head -400', { timeout: 30000 })).all;
    const fam = familia(info.manufacturer, info.brand, pacotes);

    add('modelo', 'Aparelho identificado', 'ok',
      `${info.manufacturer || '?'} ${info.model || ''} - Android ${info.android || '?'} (API ${info.sdk || '?'})`);

    // 5. bateria e tela
    const nivel = info.battery ? Number(info.battery.level) : 0;
    add('bateria', 'Bateria', nivel >= 20 ? 'ok' : 'aviso', `${nivel}%`,
      nivel >= 20 ? '' : 'Abaixo de 20% algumas etapas longas podem ser interrompidas pelo sistema. Ponha para carregar.');

    const tela = await adb.shell(serial, 'dumpsys window | grep -m1 -oE "isKeyguardShowing=(true|false)"', { timeout: 20000 });
    const bloqueada = /isKeyguardShowing=true/.test(tela.all);
    add('tela', 'Tela desbloqueada', bloqueada ? 'aviso' : 'ok',
      bloqueada ? 'a tela parece bloqueada' : 'desbloqueada',
      bloqueada ? 'Desbloqueie o celular: automacao de tela e instalacao de apps costumam falhar com a tela bloqueada.' : '');

    // 6. pm grant liberado? (a sondagem nao altera nada de verdade)
    const probeGrant = await adb.shell(serial,
      'pm grant android android.permission.CAMERA 2>&1 | head -3', { timeout: 20000 });
    const grantBloqueado = /RUNTIME_PERMISSIONS|SecurityException|not allowed/i.test(probeGrant.all);
    add('permissoes', 'Alterar permissoes pelo ADB', grantBloqueado ? 'erro' : 'ok',
      grantBloqueado ? 'o aparelho recusou (SecurityException)' : 'liberado',
      grantBloqueado
        ? (fam === 'xiaomi'
          ? 'Xiaomi/Redmi/POCO: ligue "Depuracao USB (Configuracoes de seguranca)" nas Opcoes do desenvolvedor. Exige conta Mi conectada, chip no aparelho e internet.'
          : fam === 'realme'
            ? 'realme/OPPO: ligue "Depuracao USB (Config. de seguranca)" e, se existir, "Desativar monitoramento de permissoes" nas Opcoes do desenvolvedor.'
            : 'Procure nas Opcoes do desenvolvedor por "Depuracao USB (Configuracoes de seguranca)" e ligue.')
        : '');

    // 7. instalar app pelo ADB? cria uma sessao de instalacao e a abandona
    const probeInstall = await adb.shell(serial, 'pm install-create -r -d 2>&1 | head -3', { timeout: 25000 });
    const idSessao = (probeInstall.all.match(/\[(\d+)\]/) || [])[1];
    if (idSessao) await adb.shell(serial, `pm install-abandon ${idSessao}`, { timeout: 15000 });
    const instalarBloqueado = !idSessao || /USER_RESTRICTED|SecurityException|denied/i.test(probeInstall.all);
    add('instalar', 'Instalar apps pelo ADB', instalarBloqueado ? 'erro' : 'ok',
      instalarBloqueado ? (probeInstall.all.split('\n')[0] || 'recusado').trim() : 'liberado',
      instalarBloqueado
        ? (fam === 'xiaomi'
          ? 'Xiaomi/Redmi/POCO: ligue "Instalar via USB" nas Opcoes do desenvolvedor (tambem exige conta Mi conectada).'
          : fam === 'samsung'
            ? 'Samsung: desligue o Auto Blocker em Ajustes > Seguranca e privacidade > Auto Blocker.'
            : 'Procure nas Opcoes do desenvolvedor por "Instalar via USB" e ligue.')
        : '');

    // 8. depuracao USB registrada nas settings
    const adbEnabled = (await adb.shell(serial, 'settings get global adb_enabled', { timeout: 15000 })).all.trim();
    add('depuracao', 'Depuracao USB ligada', adbEnabled === '1' ? 'ok' : 'aviso',
      `adb_enabled = ${adbEnabled || '?'}`);

    // 9. espaco livre
    const livre = info.storage ? Number(info.storage.freeGB) : 0;
    add('espaco', 'Espaco livre', livre >= 2 ? 'ok' : 'aviso',
      info.storage ? `${info.storage.freeGB} GB de ${info.storage.totalGB} GB` : '?',
      livre >= 2 ? '' : 'Menos de 2 GB livres: a instalacao de apps grandes (WhatsApp, Facebook) pode falhar.');

    // 10. perfis de trabalho
    const users = (await adb.shell(serial, 'pm list users', { timeout: 20000 })).all;
    const perfis = (users.match(/UserInfo\{\d+:/g) || []).length;
    add('perfis', 'Perfis no aparelho', 'ok', `${perfis} perfil(is) (principal + clones)`);

    ctx.json({
      ok: true,
      serial,
      familia: fam,
      fabricante: info.manufacturer,
      modelo: info.model,
      android: info.android,
      checagens,
      resumo: {
        ok: checagens.filter((c) => c.estado === 'ok').length,
        aviso: checagens.filter((c) => c.estado === 'aviso').length,
        erro: checagens.filter((c) => c.estado === 'erro').length,
      },
    });
  });

  // -------------------------------------------------- abrir tela no aparelho -
  router.any('/api/help/open-setting', async (ctx) => {
    const serial = adb.registry.resolve(ctx.q('serial'));
    if (!serial) return ctx.fail('nenhum aparelho selecionado');
    const alvo = TELAS[ctx.q('screen')];
    if (!alvo) return ctx.fail('tela desconhecida');
    const r = await adb.shell(serial, `am start -a ${alvo.intent}`, { timeout: 20000 });
    const falhou = /Error|Exception|does not exist/i.test(r.all);
    if (falhou) return ctx.fail(`o aparelho nao abriu "${alvo.nome}" - procure a mao nos Ajustes`);
    ctx.ok({ nome: alvo.nome });
  });

  // ---------------------------------------------------- reiniciar o servidor -
  // O erro "adb server version doesn't match" e classico quando outro programa
  // (Android Studio, outro gerenciador) subiu um ADB de versao diferente.
  router.any('/api/help/restart-adb', async (ctx) => {
    await run(ADB, ['kill-server'], { timeout: 15000 });
    await util.sleep(600);
    const r = await run(ADB, ['start-server'], { timeout: 20000 });
    log.info('servidor ADB reiniciado pela tela de Ajuda');
    ctx.ok({ out: ((r.stdout || '') + (r.stderr || '')).trim() || 'servidor ADB reiniciado' });
  });
}

module.exports = { register, TELAS };
