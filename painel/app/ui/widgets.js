/* ==========================================================================
   widgets.js - pecas de UI reaproveitadas pelas telas
   ========================================================================== */

import { h } from '../core/kit.js';
import { icon } from '../core/icons.js';

export function card(title, opts = {}, ...body) {
  // titulo e subtitulo ficam num bloco proprio que QUEBRA quando falta largura.
  // Antes eram irmaos diretos do flex do cabecalho e, num painel estreito, o
  // subtitulo era espremido ao lado do titulo.
  const head = title || opts.actions || opts.subtitle
    ? h('div.card__head', {},
      (title || opts.subtitle)
        ? h('div.card__titles', {},
          title ? h('h2', {}, title) : null,
          opts.subtitle ? h('p', {}, opts.subtitle) : null)
        : null,
      h('span.spacer'),
      ...(opts.actions || []))
    : null;
  return h('section.card', { id: opts.id || null },
    head,
    h('div.card__body', { class: opts.flush ? 'card__body--flush' : '' }, ...body),
    opts.foot ? h('div.card__foot', {}, opts.foot) : null
  );
}

/** Metrica compacta, para painel estreito (2 por linha). */
export function statMini(label, value, sub) {
  return h('div.statmini', {},
    h('span.statmini__label', {}, label),
    h('b.statmini__value', {}, value == null || value === '' ? '-' : String(value)),
    sub ? h('span.statmini__sub', {}, sub) : null
  );
}

export function statTile(label, value, sub) {
  return h('div.stat', {},
    h('div.stat__label', {}, label),
    h('div.stat__value', {}, value == null || value === '' ? '-' : String(value)),
    sub ? h('div.stat__sub', {}, sub) : null
  );
}

export function gauge(percent, color, label, sub, size = 92) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = size / 2 - 8;
  const circ = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(ns, 'svg');
  svgEl.setAttribute('width', size);
  svgEl.setAttribute('height', size);
  svgEl.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svgEl.innerHTML =
    `<circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="8"/>` +
    `<circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="8" stroke="${color}"` +
    ` stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - pct / 100)).toFixed(1)}"/>`;

  return h('div.gauge', {},
    h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px' } },
      svgEl,
      h('div.gauge__center', {
        style: {
          position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
          fontSize: '17px', fontWeight: '700',
        },
      }, Math.round(pct) + '%')
    ),
    h('div.center', {}, h('div.bold.small', {}, label), sub ? h('div.xs.faint', {}, sub) : null)
  );
}

export function emptyState(iconName, title, message, action) {
  return h('div.empty', {}, icon(iconName, 40), h('b', {}, title), message ? h('p', {}, message) : null, action || null);
}

export function chip(text, kind, iconName) {
  return h('span.chip', { class: kind ? 'chip--' + kind : '' }, iconName ? icon(iconName, 12) : null, text);
}

export function field(label, control, hint) {
  return h('label.field', {}, h('label', {}, label), control, hint ? h('span.hint', {}, hint) : null);
}

export function toggleRow(label, description, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('div.row', {},
    h('div.row__main', {}, h('b', {}, label), description ? h('small', {}, description) : null),
    h('span.switch', {}, input, h('i'))
  );
}

export function selectField(label, value, options, onChange, hint) {
  const sel = h('select.select', { onchange: (e) => onChange(e.target.value) },
    ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  return field(label, sel, hint);
}

export function btn(label, opts = {}) {
  return h('button.btn', {
    class: (opts.variant ? 'btn--' + opts.variant : 'btn--ghost') + (opts.small ? ' btn--sm' : '') + (opts.block ? ' btn--block' : ''),
    title: opts.title || null,
    disabled: opts.disabled || false,
    onclick: opts.onClick,
  }, opts.icon ? icon(opts.icon, opts.small ? 14 : 16) : null, label);
}

export function iconBtn(iconName, title, onClick, opts = {}) {
  return h('button.btn.btn--icon', {
    class: (opts.variant ? 'btn--' + opts.variant : 'btn--quiet') + (opts.small ? ' btn--sm' : ''),
    title, 'aria-label': title, onclick: onClick, disabled: opts.disabled || false,
  }, icon(iconName, opts.small ? 14 : 17));
}

export function sectionTitle(text) { return h('div.section-title', {}, text); }

export function progressBar(pct) {
  return h('div.bar', {}, h('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } }));
}

/** Bloco padronizado de "sem aparelho conectado". */
export function needDevice(goDevices) {
  return emptyState('devices', 'Nenhum aparelho selecionado',
    'Conecte o celular por USB com a Depuracao USB ligada, ou conecte por Wi-Fi na tela de Dispositivos.',
    btn('Ir para Dispositivos', { variant: 'primary', icon: 'devices', onClick: goDevices }));
}
