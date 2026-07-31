/* ==========================================================================
   views/apps.js - gerenciar apps do painel + clones do perfil de trabalho
   Instalar, reinstalar, limpar dados e desinstalar, em lote ou por app, no
   perfil principal e nos perfis de trabalho (Island / clonador nativo).
   ========================================================================== */

import { h, mount, clear, toast, confirmBox } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, hasDevice } from '../core/state.js';
import { go, toggleDock } from '../core/shell.js';
import { runTask, runSequence, isBusy } from '../core/tasks.js';
import { card, btn, iconBtn, needDevice, sectionTitle } from '../ui/widgets.js';
import { LOGOS, letterTile } from '../ui/logos.js';

const BUILTIN = [
  { id: 'whatsapp', cat: 'Mensageiros', name: 'WhatsApp', pkgs: ['com.whatsapp'] },
  { id: 'wabusiness', cat: 'Mensageiros', name: 'WhatsApp Business', pkgs: ['com.whatsapp.w4b'] },
  { id: 'telegram', cat: 'Mensageiros', name: 'Telegram', pkgs: ['org.telegram.messenger', 'org.telegram.messenger.web'] },
  { id: 'island', cat: 'Perfis e clonagem', name: 'Island', pkgs: ['com.oasisfeng.island'] },
  { id: 'facebook', cat: 'Meta / Facebook', name: 'Facebook', pkgs: ['com.facebook.katana'] },
  { id: 'facebooklite', cat: 'Meta / Facebook', name: 'Facebook Lite', pkgs: ['com.facebook.lite'] },
  { id: 'metaads', cat: 'Meta / Facebook', name: 'Anuncios da Meta', pkgs: ['com.facebook.adsmanager'] },
  { id: 'metabusiness', cat: 'Meta / Facebook', name: 'Meta Business Suite', pkgs: ['com.facebook.pages.app'] },
];
const CATS = ['Mensageiros', 'Perfis e clonagem', 'Meta / Facebook'];

let data = { installed: new Set(), profiles: [], custom: [], versions: { installed: {}, apks: {} } };
let marks = new Set();
let dryRun = false;

const allApps = () => BUILTIN.concat(data.custom);
const allCats = () => {
  const c = [...CATS];
  for (const a of allApps()) if (a.cat && !c.includes(a.cat)) c.push(a.cat);
  return c;
};

function apkVersionByPkg() {
  const map = {};
  for (const info of Object.values(data.versions.apks || {})) {
    if (info && info.pkg) map[info.pkg] = info;
  }
  return map;
}

function iconOf(app) {
  const wrap = h('span.row__icon');
  if (LOGOS[app.id]) { wrap.className = 'row__icon row__icon--plain'; wrap.innerHTML = LOGOS[app.id]; }
  else if (app.custom) { wrap.className = 'row__icon row__icon--plain'; wrap.innerHTML = letterTile(app.name); }
  else wrap.appendChild(icon('package', 18));
  return wrap;
}

function statusOf(app, installed) {
  if (!installed) return h('small.faint', {}, 'nao instalado');
  const pkg = app.pkgs.find((p) => data.installed.has(p));
  const iv = (data.versions.installed || {})[pkg];
  const av = apkVersionByPkg()[pkg];
  const parts = [h('span.ok', {}, 'instalado')];
  if (iv && iv.versionName) parts.push(h('span.muted', {}, ' v' + iv.versionName));
  if (av && av.versionCode && iv && iv.versionCode && Number(av.versionCode) > Number(iv.versionCode)) {
    parts.push(h('span.warn', { title: 'o APK na pasta e mais novo' }, ' - APK v' + av.versionName));
  }
  return h('small', {}, ...parts);
}

async function load() {
  const serial = currentSerial();
  if (!serial) return;
  const [apps, clones, catalog] = await Promise.all([
    api.get('/api/apps', { serial, scope: 'all' }).catch(() => ({ apps: [] })),
    api.get('/api/clones', { serial }).catch(() => ({ profiles: [] })),
    api.get('/api/catalog').catch(() => ({ custom: [] })),
  ]);
  data.installed = new Set(apps.apps || []);
  data.profiles = clones.profiles || [];
  data.custom = (catalog.custom || []).map((a) => Object.assign({}, a, { custom: true }));
  const pkgs = [...new Set(allApps().flatMap((a) => a.pkgs))].join(',');
  data.versions = await api.get('/api/versions', { serial, pkgs }).catch(() => ({ installed: {}, apks: {} }));
}

function appAction(action, app, user) {
  const clone = !!user && user !== '0';
  const where = clone ? ' do clone (perfil de trabalho)' : ' do perfil principal';
  const messages = {
    uninstall: clone
      ? `Remover o clone de ${app.name} do perfil de trabalho?\n\nApaga o clone e seus dados (o app do perfil principal nao e afetado).`
      : `Desinstalar ${app.name}?\n\nRemove o app e seus dados do perfil principal (o clone do Island nao e afetado).`,
    reinstall: `Reinstalar ${app.name}${where}?\n\nRemove e instala de novo - zera TODOS os dados e conversas.`,
    clear: `Limpar os dados de ${app.name}${where}?\n\nApaga conversas, logs e cache (fica como recem-instalado), sem remover o app.`,
    install: clone
      ? `Clonar ${app.name} no perfil de trabalho (user ${user})?\n\nInstala o app oficial nesse perfil (install-existing).`
      : `Instalar ${app.name} a partir da pasta apks?`,
  };
  return confirmBox(
    { uninstall: 'Desinstalar', reinstall: 'Reinstalar', clear: 'Limpar dados', install: 'Instalar' }[action] + ' ' + app.name,
    messages[action],
    { danger: action !== 'install', okLabel: 'Confirmar' }
  ).then((ok) => {
    if (!ok) return;
    toggleDock(true);
    const tag = clone ? ` [clone u${user}]` : '';
    return runTask({
      title: `${app.name}${tag}: ${action}${dryRun ? ' (simulacao)' : ''}`,
      path: '/api/app-action',
      params: { serial: currentSerial(), action, app: app.id, user: user || '0', dry: dryRun ? 1 : 0 },
    }).promise.then(() => refreshAll());
  });
}

let refreshAll = () => { };

export const appsView = {
  id: 'apps',
  title: 'Gerenciar apps',
  subtitle: 'Instalar, reinstalar, limpar dados e clonar - perfil principal e clones',
  icon: 'apps',
  group: 'acoes',

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    const listHost = h('div.list');
    const cloneHost = h('div');
    const countLabel = h('span.chip', {}, '0');

    const paint = () => {
      clear(listHost);
      marks = new Set([...marks].filter((id) => allApps().some((a) => a.id === id)));

      for (const cat of allCats()) {
        const apps = allApps().filter((a) => a.cat === cat);
        if (!apps.length) continue;
        listHost.appendChild(sectionTitle(cat));
        for (const app of apps) {
          const installed = app.pkgs.some((p) => data.installed.has(p));
          const mark = h('input', {
            type: 'checkbox', checked: marks.has(app.id), title: 'marcar para acao em lote',
            onchange: (e) => { e.target.checked ? marks.add(app.id) : marks.delete(app.id); countLabel.textContent = String(marks.size); },
          });
          const actions = installed
            ? [
              btn('Limpar dados', { small: true, icon: 'broom', onClick: () => appAction('clear', app, '0') }),
              btn('Reinstalar', { small: true, icon: 'refresh', onClick: () => appAction('reinstall', app, '0') }),
              btn('Desinstalar', { small: true, icon: 'trash', variant: 'danger', onClick: () => appAction('uninstall', app, '0') }),
            ]
            : [btn('Instalar', { small: true, icon: 'download', variant: 'primary', onClick: () => appAction('install', app, '0') })];

          if (app.custom) {
            actions.push(iconBtn('close', 'Tirar do painel', async () => {
              if (!await confirmBox('Tirar do painel', `Remover "${app.name}" do painel?\n\nRemove so do catalogo - o app no celular e o APK na pasta NAO sao apagados.`)) return;
              await api.post('/api/catalog-remove', { id: app.id });
              toast('Removido do painel', 'ok');
              refreshAll();
            }, { small: true }));
          }

          listHost.appendChild(h('div.row', {}, mark, iconOf(app),
            h('div.row__main', {}, h('b', {}, app.name), statusOf(app, installed)),
            h('div.row__actions', {}, ...actions)));
        }
      }

      // clones (perfis de trabalho do Island / clone nativo)
      const cloneable = BUILTIN.filter((a) => a.cat === 'Mensageiros');
      for (const pf of data.profiles) {
        listHost.appendChild(sectionTitle(`Clones - ${pf.name} (user ${pf.user})`));
        for (const app of cloneable) {
          const inst = app.pkgs.find((p) => pf.pkgs.includes(p));
          const actions = inst
            ? [
              btn('Limpar dados', { small: true, icon: 'broom', onClick: () => appAction('clear', app, pf.user) }),
              btn('Reinstalar', { small: true, icon: 'refresh', onClick: () => appAction('reinstall', app, pf.user) }),
              btn('Remover clone', { small: true, icon: 'trash', variant: 'danger', onClick: () => appAction('uninstall', app, pf.user) }),
            ]
            : [btn('Instalar', { small: true, icon: 'download', variant: 'primary', onClick: () => appAction('install', app, pf.user) })];
          listHost.appendChild(h('div.row', {}, iconOf(app),
            h('div.row__main', {}, h('b', {}, app.name),
              h('small', {}, inst ? h('span.ok', {}, 'clonado') : h('span.faint', {}, 'nao clonado neste perfil'))),
            h('div.row__actions', {}, ...actions)));
        }
      }
    };

    const batch = async (action) => {
      if (!marks.size) return toast('Marque ao menos um app', 'warn');
      const names = [...marks].map((id) => (allApps().find((a) => a.id === id) || {}).name || id);
      const label = { install: 'Instalar', reinstall: 'Reinstalar', clear: 'Limpar dados de' }[action];
      const warn = { install: '', reinstall: ' - ZERA o app (apaga tudo e reinstala)', clear: ' - apaga conversas, logs e cache' }[action];
      if (!await confirmBox(`${label} ${marks.size} app(s)`,
        `${label} os apps marcados${warn}${dryRun ? ' (simulacao)' : ''}?\n\n${names.join(', ')}`,
        { danger: action !== 'install' })) return;

      toggleDock(true);
      const serial = currentSerial();
      await runSequence(`${label} marcados`, [...marks].map((id) => ({
        label: (allApps().find((a) => a.id === id) || {}).name || id,
        path: '/api/app-action',
        params: { serial, action, app: id, user: '0', dry: dryRun ? 1 : 0 },
      })).slice()).promise;
      refreshAll();
    };

    refreshAll = async () => {
      listHost.innerHTML = '';
      listHost.appendChild(h('div.card__body', {}, h('div.hstack', {}, h('span.spinner'), 'Lendo os apps do aparelho...')));
      await load();
      paint();
    };

    mount(root,
      card('Apps do painel', {
        subtitle: 'Acoes no perfil principal e nos clones. Marque varios para agir em lote.',
        actions: [
          h('label.check', {}, h('input', { type: 'checkbox', checked: dryRun, onchange: (e) => { dryRun = e.target.checked; } }), 'Simular'),
          btn('Atualizar', { small: true, icon: 'refresh', onClick: () => refreshAll() }),
        ],
        flush: true,
        foot: h('div.hstack', {},
          btn('Marcar todos', { small: true, onClick: () => { allApps().forEach((a) => marks.add(a.id)); paint(); countLabel.textContent = String(marks.size); } }),
          btn('Nenhum', { small: true, onClick: () => { marks.clear(); paint(); countLabel.textContent = '0'; } }),
          h('span.spacer'),
          h('span.small.muted', {}, 'marcados:'), countLabel,
          btn('Instalar', { small: true, variant: 'primary', icon: 'download', onClick: () => batch('install') }),
          btn('Reinstalar', { small: true, icon: 'refresh', onClick: () => batch('reinstall') }),
          btn('Limpar dados', { small: true, icon: 'broom', onClick: () => batch('clear') })
        ),
      }, listHost)
    );

    refreshAll();
  },

  commands: [
    { label: 'Gerenciar apps (instalar / limpar / reinstalar)', icon: 'apps', run: () => go('apps') },
  ],
};
