/* ==========================================================================
   rename.js - renomear aparelho, em um lugar so
   --------------------------------------------------------------------------
   Fica aqui (e nao dentro da tela Dispositivos) porque a doca do espelho
   tambem oferece a acao. Depende so de kit.js e api.js, entao nao cria ciclo
   de importacao com shell.js/mirrordock.js.
   ========================================================================== */

import { h, dialog, toast } from './kit.js';
import { api } from './api.js';

/**
 * Abre o dialogo de renomear.
 * @param {object} dev  item do snapshot: {serial, name, alias, realName, model}
 * @returns {Promise<string|null>} o novo nome exibido, ou null se cancelou
 */
export async function renameDevice(dev) {
  if (!dev || !dev.serial) { toast('Selecione um aparelho', 'warn'); return null; }

  const original = dev.realName || dev.model || dev.serial;
  const campo = h('input.input', { value: dev.alias || '', placeholder: original, maxlength: 40 });

  const escolha = await dialog({
    title: 'Renomear aparelho',
    body: [
      h('p', {}, 'O apelido aparece no painel inteiro e tambem nos nomes dos prints e gravacoes.'),
      h('label.field', {},
        h('label', {}, 'Apelido'),
        campo,
        h('span.hint', {}, `Nome original: ${original}`)),
      h('p.xs.faint', {},
        'O apelido fica ligado ao serial de hardware, entao continua valendo quando este aparelho conectar por Wi-Fi.'),
    ],
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Usar o nome original', value: '__reset__' },
      { label: 'Salvar', variant: 'primary', primary: true, value: () => campo.value.trim() },
    ],
    onMount: () => setTimeout(() => { campo.focus(); campo.select(); }, 40),
  });

  if (escolha === null) return null;

  const nome = escolha === '__reset__' ? '' : escolha;
  try {
    const r = await api.get('/api/devices/rename', { serial: dev.serial, name: nome });
    toast(nome ? `Agora chama "${r.name}"` : `Voltou para "${r.name}"`, 'ok');
    return r.name;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}
