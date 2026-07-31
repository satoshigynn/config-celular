/* ==========================================================================
   views/advanced.js - escaneamento de apps, listas do config.json e extracao
   Mantem tudo que existia na aba "Avancado": classificacao de risco, adicionar
   as listas, extrair APK, adicionar ao painel e permissoes em massa.
   ========================================================================== */

import { h, mount, clear, toast, confirmBox, debounce, download } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, hasDevice } from '../core/state.js';
import { go, toggleDock } from '../core/shell.js';
import { runTask, runSequence } from '../core/tasks.js';
import { card, btn, iconBtn, chip, emptyState, needDevice, field } from '../ui/widgets.js';
import { labelFor } from '../ui/logos.js';

let appsCache = [];
let thirdParty = new Set();
let lists = null;
let selected = new Set();

async function ensureLists() {
  if (lists) return;
  try {
    const cfg = await api.get('/api/config');
    const rx = (arr) => (arr || []).map((s) => { try { return new RegExp(s); } catch (_) { return null; } }).filter(Boolean);
    lists = {
      P: rx(cfg.protect), B: rx(cfg.bloatPatterns), K: rx(cfg.keepThirdParty),
      force: new Set(cfg.forceRemove || []),
    };
  } catch (_) { lists = null; }
}

// Classificacao de risco: verde = seguro remover, amarelo = cuidado, vermelho = essencial
function classify(pkg) {
  if (!lists) return { sym: '', label: '', rank: 1, kind: '' };
  const any = (s, L) => L.some((r) => r.test(s));
  if (any(pkg, lists.P)) return { sym: 'essencial', label: 'nao remover', rank: 2, kind: 'err' };
  if (lists.force.has(pkg) || any(pkg, lists.B) || (thirdParty.has(pkg) && !any(pkg, lists.K))) {
    return { sym: 'seguro', label: 'seguro remover', rank: 0, kind: 'ok' };
  }
  return { sym: 'cuidado', label: 'avalie antes', rank: 1, kind: 'warn' };
}

export const advancedView = {
  id: 'advanced',
  title: 'Avancado',
  subtitle: 'Escanear apps, ajustar as listas do debloat e extrair APKs',
  icon: 'advanced',
  group: 'sistema',

  async render(root) {
    if (!hasDevice()) return mount(root, needDevice(() => go('devices')));

    const listEl = h('div.list', { style: { maxHeight: '460px', overflow: 'auto' } });
    const filterInput = h('input.input', { placeholder: 'filtrar por nome ou pacote...' });
    const allScope = h('input', { type: 'checkbox' });
    const countChip = h('span.chip', {}, '0 selecionados');

    const paint = () => {
      const q = filterInput.value.trim().toLowerCase();
      const list = appsCache
        .filter((p) => !q || p.toLowerCase().includes(q) || labelFor(p).toLowerCase().includes(q))
        .sort((a, b) => classify(a).rank - classify(b).rank || labelFor(a).localeCompare(labelFor(b)))
        .slice(0, 500);

      clear(listEl);
      if (!list.length) {
        listEl.appendChild(h('div.card__body', {},
          emptyState('search', 'Nada encontrado', 'Clique em Escanear para ler os apps do aparelho.')));
        return;
      }
      for (const pkg of list) {
        const c = classify(pkg);
        const cb = h('input', {
          type: 'checkbox', checked: selected.has(pkg), value: pkg,
          onchange: (e) => {
            e.target.checked ? selected.add(pkg) : selected.delete(pkg);
            countChip.textContent = selected.size + ' selecionados';
          },
        });
        listEl.appendChild(h('div.row.row--tight', {}, cb,
          h('div.row__main', {}, h('b', {}, labelFor(pkg)), h('small.mono', {}, pkg)),
          c.sym ? chip(c.sym, c.kind) : null
        ));
      }
    };

    const scan = async () => {
      const serial = currentSerial();
      if (!serial) return toast('Conecte o celular primeiro', 'warn');
      mount(listEl, h('div.card__body', {}, h('div.hstack', {}, h('span.spinner'), 'Escaneando os apps...')));
      await ensureLists();
      try {
        const tp = await api.get('/api/apps', { serial, scope: '3' });
        thirdParty = new Set(tp.apps || []);
        const r = await api.get('/api/apps', { serial, scope: allScope.checked ? 'all' : '3' });
        appsCache = r.apps || [];
        selected.clear();
        countChip.textContent = '0 selecionados';
        if (!appsCache.length) {
          mount(listEl, h('div.card__body', {}, h('p.small.warn', {},
            'Nenhum app retornado - verifique se o celular esta autorizado (popup "Permitir depuracao USB").')));
          return;
        }
        paint();
        toast(`${appsCache.length} apps encontrados`, 'ok');
      } catch (e) { mount(listEl, h('div.card__body', {}, h('p.small.err', {}, e.message))); }
    };

    filterInput.addEventListener('input', debounce(paint, 180));

    const addToList = async (list) => {
      if (!selected.size) return toast('Selecione apps primeiro', 'warn');
      const nome = list === 'forceRemove' ? 'remocao' : 'protecao';
      try {
        const r = await api.post('/api/config-add', { list, pkgs: [...selected] });
        toast(`${r.added} adicionado(s) a lista de ${nome}`, 'ok');
        lists = null;
        await ensureLists();
        paint();
      } catch (e) { toast(e.message, 'err'); }
    };

    const extract = async (alsoRegister) => {
      if (!selected.size) return toast('Selecione apps primeiro', 'warn');
      const pkgs = [...selected];
      const title = alsoRegister ? 'Adicionar ao painel' : 'Extrair APK';
      if (!await confirmBox(title,
        `${alsoRegister ? 'Extrai o APK e inclui na aba Gerenciar apps' : 'Extrai o APK para a pasta apks\\'} de ${pkgs.length} app(s):\n\n${pkgs.map(labelFor).join(', ')}`)) return;

      toggleDock(true);
      const serial = currentSerial();
      const steps = pkgs.map((p) => {
        const nome = (labelFor(p) || p).normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim() || p;
        return {
          label: `${nome} (${p})`,
          path: '/api/extract',
          params: { serial, pkg: p, nome },
          onDone: async (code) => {
            if (code === 0 && alsoRegister) {
              try { await api.post('/api/catalog-add', { pkg: p, name: nome, cat: 'Outros' }); }
              catch (_) { }
            }
          },
        };
      });
      await runSequence(title, steps).promise;
      if (alsoRegister) toast('Apps adicionados ao painel', 'ok');
    };

    const perms = async (action) => {
      if (!selected.size) return toast('Selecione apps primeiro', 'warn');
      const verbo = action === 'grant' ? 'Conceder' : 'Revogar';
      if (!await confirmBox(verbo + ' permissoes',
        `${verbo} as permissoes comuns de ${selected.size} app(s)?\n\n${[...selected].map(labelFor).join(', ')}`)) return;
      toggleDock(true);
      const serial = currentSerial();
      await runSequence(`${verbo} permissoes`, [...selected].map((p) => ({
        label: `${labelFor(p)} (${p})`,
        path: '/api/perms-bulk',
        params: { serial, action, pkg: p },
      }))).promise;
    };

    /* ------------------------------------------------------ config.json -- */
    const cfgArea = h('textarea.textarea', { spellcheck: 'false', style: { minHeight: '320px' } });
    const cfgMsg = h('span.small.muted');

    const loadCfg = async () => {
      try {
        const cfg = await api.get('/api/config');
        cfgArea.value = JSON.stringify(cfg, null, 2);
        cfgMsg.textContent = 'Carregado.';
        cfgMsg.className = 'small ok';
      } catch (e) { cfgMsg.textContent = 'Falha ao carregar: ' + e.message; cfgMsg.className = 'small err'; }
    };

    const saveCfg = async () => {
      try { JSON.parse(cfgArea.value); }
      catch (e) { cfgMsg.textContent = 'JSON invalido: ' + e.message; cfgMsg.className = 'small err'; return; }
      try {
        await api.post('/api/config', cfgArea.value);
        cfgMsg.textContent = 'Salvo - vale na proxima execucao.';
        cfgMsg.className = 'small ok';
        lists = null;
        toast('config.json salvo', 'ok');
      } catch (e) { cfgMsg.textContent = 'Erro: ' + e.message; cfgMsg.className = 'small err'; }
    };

    mount(root,
      card('Apps do celular', {
        subtitle: 'Escaneia os pacotes instalados e classifica pelo risco de remocao, usando as listas do config.json.',
        actions: [
          h('label.check', {}, allScope, 'Incluir apps de sistema'),
          btn('Escanear', { small: true, variant: 'primary', icon: 'search', onClick: scan }),
        ],
        flush: true,
        foot: h('div.hstack', {},
          countChip,
          btn('Selecionar os seguros', {
            small: true,
            onClick: () => {
              selected = new Set(appsCache.filter((p) => classify(p).rank === 0));
              countChip.textContent = selected.size + ' selecionados';
              paint();
            },
          }),
          h('span.spacer'),
          btn('Marcar para remover', { small: true, icon: 'trash', onClick: () => addToList('forceRemove') }),
          btn('Proteger', { small: true, icon: 'shield', onClick: () => addToList('keepThirdParty') }),
          btn('Extrair APK', { small: true, icon: 'download', onClick: () => extract(false) }),
          btn('Adicionar ao painel', { small: true, icon: 'plus', onClick: () => extract(true) }),
          btn('Conceder perms', { small: true, icon: 'shield', onClick: () => perms('grant') }),
          btn('Revogar perms', { small: true, icon: 'close', onClick: () => perms('revoke') })
        ),
      },
        h('div.card__body', {}, filterInput),
        listEl,
        h('div.card__body', {}, h('div.hstack', {},
          chip('seguro remover', 'ok'), chip('avalie antes', 'warn'), chip('nao remover', 'err')))
      ),

      card('Listas do debloat (config.json)', {
        subtitle: 'protect e a rede de seguranca; bloatPatterns e keepThirdParty definem o que sai e o que fica.',
        actions: [
          btn('Recarregar', { small: true, icon: 'refresh', onClick: loadCfg }),
          btn('Baixar copia', { small: true, icon: 'download', onClick: () => download('config.json', cfgArea.value, 'application/json') }),
          btn('Salvar', { small: true, variant: 'primary', icon: 'check', onClick: saveCfg }),
        ],
      }, h('div.stack', {}, cfgArea, cfgMsg))
    );

    loadCfg();
  },

  commands: [
    { label: 'Escanear os apps do celular', icon: 'search', run: () => go('advanced') },
    { label: 'Editar as listas do debloat', icon: 'edit', run: () => go('advanced') },
  ],
};
