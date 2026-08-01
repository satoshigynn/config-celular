// ============================================================================
//  core/updatebar.js - aviso de atualizacao, fixo no alto do painel
// ----------------------------------------------------------------------------
//  Antes, saber que havia versao nova exigia ir ate Configuracoes > Atualizacao
//  e clicar em "Verificar" - ou seja, so descobria quem ja desconfiava. Agora o
//  painel consulta sozinho e, havendo novidade, mostra uma faixa ACIMA da barra
//  de titulo, presente em todas as telas.
//
//  DECISOES QUE VALEM EXPLICAR:
//
//  * A faixa nao e' um popup que rouba o foco. Ela ocupa o topo e fica la ate
//    o usuario atualizar ou dispensar - avisar sem interromper o que ele esta
//    fazendo com o celular.
//
//  * Dispensar guarda a VERSAO dispensada, nao um "ja vi". Assim a 6.3 volta a
//    avisar mesmo que a 6.2 tenha sido dispensada, e ninguem fica preso numa
//    versao velha por um clique dado meses atras.
//
//  * A consulta e' silenciosa quando falha. Sem internet, ou com o update.json
//    apontando para lugar nenhum, a faixa simplesmente nao aparece - erro de
//    rede nao vira alarme na cara de quem so quer usar o programa.
// ============================================================================
'use strict';

import { h, clear, toast } from './kit.js';
import { icon } from './icons.js';
import { api } from './api.js';

const DISPENSADAS = 'painel.update.dispensada';
const INTERVALO = 6 * 60 * 60 * 1000;   // reconsulta a cada 6h com o painel aberto

let barra = null;
let aoAtualizar = null;
let ultima = null;

function foiDispensada(versao) {
  try { return localStorage.getItem(DISPENSADAS) === String(versao); } catch (_) { return false; }
}
function dispensar(versao) {
  try { localStorage.setItem(DISPENSADAS, String(versao)); } catch (_) { }
  esconder();
}

function esconder() {
  if (!barra) return;
  barra.setAttribute('hidden', '');
  clear(barra);
}

function mostrar(info) {
  if (!barra) return;
  clear(barra);
  barra.removeAttribute('hidden');

  const notas = String(info.notas || '').trim();

  barra.append(
    h('span.updatebar__badge', {}, icon('download', 14), 'nova versao'),
    h('strong.updatebar__ver', {}, info.versaoRemota),
    h('span.updatebar__txt', {},
      notas || `${info.total} arquivo(s) para atualizar - voce esta na ${info.versaoLocal}.`),
    h('span.updatebar__spacer'),
    h('button.btn.btn--sm.btn--primary', {
      onclick: () => { if (aoAtualizar) aoAtualizar(info); },
    }, icon('download', 15), 'Atualizar agora'),
    h('button.updatebar__x', {
      title: 'Dispensar ate a proxima versao',
      'aria-label': 'Dispensar',
      onclick: () => dispensar(info.versaoRemota),
    }, icon('close', 15))
  );
}

async function consultar({ avisar = false } = {}) {
  let j;
  try { j = await api.get('/api/update-check'); } catch (_) { return null; }
  if (!j || !j.configured || !j.ok) { esconder(); return null; }

  const temNovidade = Number(j.total) > 0;
  if (!temNovidade) { esconder(); ultima = j; return j; }

  const primeiraVez = !ultima || ultima.versaoRemota !== j.versaoRemota;
  ultima = j;

  if (foiDispensada(j.versaoRemota)) return j;

  mostrar(j);
  // o "popup": so na primeira vez que esta versao aparece, para nao repetir a
  // cada reconsulta de 6 em 6 horas
  if (avisar && primeiraVez) {
    toast(`Versao ${j.versaoRemota} disponivel - veja o aviso no topo`, 'info', 7000);
  }
  return j;
}

export default {
  // Cria o elemento. Vai ACIMA da topbar, dentro de .main.
  create(opts = {}) {
    aoAtualizar = opts.onUpdate || null;
    barra = h('div.updatebar', { id: 'updateBar', role: 'status', hidden: '' });
    return barra;
  },

  // Comeca a consultar: uma vez agora, depois de 6 em 6 horas.
  start() {
    consultar({ avisar: true });
    setInterval(() => consultar({ avisar: true }), INTERVALO);
  },

  // Usado pela tela de Configuracoes depois de um "Verificar" manual.
  refresh() { return consultar({ avisar: false }); },

  hide: esconder,
};
