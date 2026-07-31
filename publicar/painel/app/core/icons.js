/* ==========================================================================
   icons.js - conjunto de icones no tracado Fluent (Windows 11)
   --------------------------------------------------------------------------
   SVG inline: sem fonte de icone, sem requisicao externa, herda a cor do texto
   e escala sem borrar. Substitui os emojis espalhados pela versao antiga.
   ========================================================================== */

const S = 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor"';

export const ICONS = {
  // --- navegacao ---------------------------------------------------------
  devices: `<rect x="6" y="2.5" width="12" height="19" rx="2.6" ${S}/><path d="M10.5 5.5h3M12 18.2h.01" ${S}/>`,
  mirror: `<rect x="2.5" y="4" width="14" height="11" rx="2" ${S}/><path d="M6 19h7" ${S}/><rect x="18" y="9" width="3.5" height="10" rx="1.2" ${S}/>`,
  apps: `<rect x="3" y="3" width="7" height="7" rx="2" ${S}/><rect x="14" y="3" width="7" height="7" rx="2" ${S}/><rect x="3" y="14" width="7" height="7" rx="2" ${S}/><rect x="14" y="14" width="7" height="7" rx="2" ${S}/>`,
  setup: `<path d="M12 3v2m0 14v2M4.2 4.2l1.5 1.5m12.6 12.6 1.5 1.5M3 12h2m14 0h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" ${S}/><circle cx="12" cy="12" r="4" ${S}/>`,
  capture: `<path d="M4 7.5h3l1.4-2.2h7.2L17 7.5h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z" ${S}/><circle cx="12" cy="13" r="3.6" ${S}/>`,
  files: `<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2.2H19a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" ${S}/>`,
  tools: `<path d="M14.3 6.2a4.2 4.2 0 0 1 5.6 5.3l-2.2-2.2-2.1.5-.6-2.1Z" ${S}/><path d="m15.4 10.8-9 9a2.1 2.1 0 0 1-3-3l9-9" ${S}/>`,
  terminal: `<rect x="2.5" y="4" width="19" height="16" rx="2.4" ${S}/><path d="m7 10 2.6 2.4L7 14.8M12.8 15h4" ${S}/>`,
  advanced: `<path d="M4 6h16M4 12h16M4 18h16" ${S}/><circle cx="9" cy="6" r="2" ${S}/><circle cx="15" cy="12" r="2" ${S}/><circle cx="8" cy="18" r="2" ${S}/>`,
  settings: `<path d="M10.6 3.3a1.4 1.4 0 0 1 2.8 0l.15 1a1.4 1.4 0 0 0 1.95 1.08l.9-.4a1.4 1.4 0 0 1 1.8.6l.5.87a1.4 1.4 0 0 1-.35 1.83l-.78.6a1.4 1.4 0 0 0 0 2.24l.78.6a1.4 1.4 0 0 1 .35 1.83l-.5.87a1.4 1.4 0 0 1-1.8.6l-.9-.4a1.4 1.4 0 0 0-1.95 1.08l-.15 1a1.4 1.4 0 0 1-2.8 0l-.15-1a1.4 1.4 0 0 0-1.95-1.08l-.9.4a1.4 1.4 0 0 1-1.8-.6l-.5-.87a1.4 1.4 0 0 1 .35-1.83l.78-.6a1.4 1.4 0 0 0 0-2.24l-.78-.6a1.4 1.4 0 0 1-.35-1.83l.5-.87a1.4 1.4 0 0 1 1.8-.6l.9.4A1.4 1.4 0 0 0 10.45 4.3Z" ${S}/><circle cx="12" cy="12" r="2.6" ${S}/>`,

  // --- acoes -------------------------------------------------------------
  search: `<circle cx="11" cy="11" r="6.5" ${S}/><path d="m20 20-3.6-3.6" ${S}/>`,
  refresh: `<path d="M20 11.5A8 8 0 1 0 18.3 17" ${S}/><path d="M20 5v6h-6" ${S}/>`,
  play: `<path d="M8 5.5v13l10.5-6.5Z" ${S}/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2" ${S}/>`,
  record: `<circle cx="12" cy="12" r="6.5" ${F}/>`,
  pause: `<path d="M9 5v14M15 5v14" ${S}/>`,
  download: `<path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4 17v1.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V17" ${S}/>`,
  upload: `<path d="M12 20.5v-11m0 0 4 4m-4-4-4 4M4 7V5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5V7" ${S}/>`,
  trash: `<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12.2A2 2 0 0 0 9.3 20.5h5.4a2 2 0 0 0 2-1.8l.8-12.2" ${S}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${S}/>`,
  check: `<path d="M20 6.5 9.5 17 4 11.5" ${S}/>`,
  close: `<path d="M6 6l12 12M18 6 6 18" ${S}/>`,
  edit: `<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" ${S}/>`,
  copy: `<rect x="8.5" y="8.5" width="12" height="12" rx="2" ${S}/><path d="M15.5 5.5A2 2 0 0 0 13.5 3.5h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" ${S}/>`,
  external: `<path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" ${S}/>`,
  folder: `<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2.2H19a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" ${S}/>`,
  file: `<path d="M13.5 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" ${S}/><path d="M13.5 3.5V9H19" ${S}/>`,
  filter: `<path d="M4 6h16l-6.2 7.2v5.3l-3.6 2v-7.3Z" ${S}/>`,
  more: `<circle cx="12" cy="5.5" r="1.4" ${F}/><circle cx="12" cy="12" r="1.4" ${F}/><circle cx="12" cy="18.5" r="1.4" ${F}/>`,
  sidebar: `<rect x="3" y="4.5" width="18" height="15" rx="2.4" ${S}/><path d="M9.5 4.5v15" ${S}/>`,

  // --- conexao -----------------------------------------------------------
  usb: `<path d="M12 21V6" ${S}/><path d="m9 9 3-4.5L15 9Z" ${S}/><path d="M12 15.5 7.5 13v-2.5" ${S}/><circle cx="7.5" cy="9.5" r="1.4" ${F}/><path d="m12 12.5 4.5-2.5V7.5" ${S}/><rect x="15" y="5" width="3" height="2.6" rx=".6" ${F}/>`,
  wifi: `<path d="M2.8 9.2a14 14 0 0 1 18.4 0M6 12.6a9.2 9.2 0 0 1 12 0M9.2 16a4.6 4.6 0 0 1 5.6 0" ${S}/><circle cx="12" cy="19.4" r="1.3" ${F}/>`,
  link: `<path d="M10 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3" ${S}/><path d="M14 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3" ${S}/>`,
  unlink: `<path d="M4 4l16 16" ${S}/><path d="M10 13.8a4 4 0 0 0 4.6.8M14 10.2a4 4 0 0 0-4.7-.7" ${S}/>`,
  power: `<path d="M12 3.5v8" ${S}/><path d="M17.5 6.5a7.5 7.5 0 1 1-11 0" ${S}/>`,

  // --- aparelho ----------------------------------------------------------
  battery: `<rect x="2.5" y="7.5" width="16" height="9" rx="2.2" ${S}/><path d="M21 11v2" ${S}/>`,
  cpu: `<rect x="7" y="7" width="10" height="10" rx="2" ${S}/><path d="M10 3v4m4-4v4m-4 10v4m4-4v4M3 10h4m-4 4h4m10-4h4m-4 4h4" ${S}/>`,
  storage: `<ellipse cx="12" cy="6.5" rx="7.5" ry="3" ${S}/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" ${S}/><path d="M19.5 12c0 1.7-3.4 3-7.5 3s-7.5-1.3-7.5-3" ${S}/>`,
  chart: `<path d="M4 20V10m5 10V4m5 16v-7m5 7V8" ${S}/>`,
  info: `<circle cx="12" cy="12" r="8.5" ${S}/><path d="M12 11v5.5m0-9h.01" ${S}/>`,
  warning: `<path d="M12 9.5v4m0 3.5h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" ${S}/>`,
  shield: `<path d="M12 3.2 5 6v5.4c0 4.2 2.9 8 7 9.4 4.1-1.4 7-5.2 7-9.4V6Z" ${S}/><path d="m9 12 2 2 4-4" ${S}/>`,
  bolt: `<path d="M13.2 2.5 5 13.5h5.4L9.8 21.5 19 10.5h-5.6Z" ${S}/>`,
  broom: `<path d="m14.5 3.5 6 6M17 7 9.5 14.5M9.5 14.5 3 21l3.2-.5.8-2.6 2.6-.8.5-3.2Z" ${S}/><path d="M6.5 14 10 17.5" ${S}/>`,
  package: `<path d="M12 2.8 3.5 7v10L12 21.2 20.5 17V7Z" ${S}/><path d="M3.5 7 12 11.3 20.5 7M12 11.3v9.9" ${S}/>`,
  clone: `<rect x="3" y="3" width="12" height="12" rx="2.6" ${S}/><path d="M9 18.5a2.5 2.5 0 0 0 2.5 2.5H18a3 3 0 0 0 3-3v-6.5A2.5 2.5 0 0 0 18.5 9" ${S}/>`,

  // --- espelho / controle ------------------------------------------------
  home: `<circle cx="12" cy="12" r="8.2" ${S}/>`,
  back: `<path d="M15 5.5 8 12l7 6.5" ${S}/>`,
  square: `<rect x="5.5" y="5.5" width="13" height="13" rx="2.4" ${S}/>`,
  rotate: `<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9.4" ${S}/><path d="M20 4.5v5h-5" ${S}/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 14.6" ${S}/><path d="M4 19.5v-5h5" ${S}/>`,
  fullscreen: `<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9m6 0h3.5A1.5 1.5 0 0 1 20 5.5V9m0 6v3.5a1.5 1.5 0 0 1-1.5 1.5H15m-6 0H5.5A1.5 1.5 0 0 1 4 18.5V15" ${S}/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2.2" ${S}/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h11" ${S}/>`,
  volumeUp: `<path d="M4 9.5h3L11 6v12l-4-3.5H4Z" ${S}/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10" ${S}/>`,
  volumeDown: `<path d="M4 9.5h3L11 6v12l-4-3.5H4Z" ${S}/><path d="M15 9.5a3.5 3.5 0 0 1 0 5" ${S}/>`,
  bell: `<path d="M17.5 10.5a5.5 5.5 0 0 0-11 0c0 5-2 6.5-2 6.5h15s-2-1.5-2-6.5Z" ${S}/><path d="M13.7 20a2 2 0 0 1-3.4 0" ${S}/>`,
  clipboard: `<rect x="6" y="4.5" width="12" height="16" rx="2" ${S}/><path d="M9.5 4.5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2" ${S}/>`,

  // --- tema / diversos ---------------------------------------------------
  sun: `<circle cx="12" cy="12" r="4" ${S}/><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" ${S}/>`,
  moon: `<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" ${S}/>`,
  logs: `<path d="M5 5.5h14M5 10h14M5 14.5h9M5 19h6" ${S}/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" ${S}/><circle cx="12" cy="12" r="3" ${S}/>`,
  pin: `<path d="M15 3.5 20.5 9l-3 1-4.5 4.5-1 4.5-6-6 4.5-1L15 6.5Z" ${S}/><path d="m8 16-4 4" ${S}/>`,
  sparkle: `<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6L4.5 10.8 10.2 9Z" ${S}/><path d="M18.5 4v3M20 5.5h-3" ${S}/>`,
};

/** Devolve um <svg> pronto. Use icon('mirror', 18). */
export function icon(name, size = 18) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', 'none');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || ICONS.info;
  return el;
}

/** Versao em string, para quando o SVG entra dentro de um innerHTML proprio. */
export function iconHtml(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
}
