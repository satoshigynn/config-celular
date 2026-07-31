/* ==========================================================================
   api.js - unico ponto de contato com o servidor
   --------------------------------------------------------------------------
   Cobre os tres transportes usados pelo painel:
     REST  -> respostas curtas em JSON
     SSE   -> tarefas longas que transmitem log linha a linha
     WS    -> tempo real (eventos, video do espelho, shell)
   O token da sessao vai automaticamente em todas as chamadas: por header no
   fetch e por query no EventSource/WebSocket (que nao aceitam header).
   ========================================================================== */

const TOKEN = document.querySelector('meta[name="panel-token"]')?.content || '';
const WS_BASE = location.origin.replace(/^http/, 'ws');

function withToken(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  q.set('_t', TOKEN);
  return q;
}

function url(path, params) {
  return path + (path.includes('?') ? '&' : '?') + withToken(params).toString();
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError((data && data.err) || `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

export const api = {
  TOKEN,

  async get(path, params) {
    return parse(await fetch(url(path, params), { headers: { 'X-Panel-Token': TOKEN } }));
  },

  async post(path, body, params) {
    return parse(await fetch(url(path, params), {
      method: 'POST',
      headers: { 'X-Panel-Token': TOKEN, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body || {}),
    }));
  },

  /** GET que devolve um Blob (prints do modo simples). */
  async blob(path, params) {
    const res = await fetch(url(path, params), { headers: { 'X-Panel-Token': TOKEN } });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('json')) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(j.err || `HTTP ${res.status}`, res.status, j);
    }
    return res.blob();
  },

  /**
   * Abre um fluxo SSE. Devolve {close, done} - 'done' e uma Promise que resolve
   * com o codigo de saida da tarefa.
   */
  stream(path, params, handlers = {}) {
    const es = new EventSource(url(path, params));
    let settled = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      es.close();
      handlers.onDone?.(code);
      resolveDone(code);
    };

    es.onmessage = (e) => {
      const data = e.data;
      if (data.startsWith('__DONE__')) return finish(Number(data.split(' ')[1] || 0));
      handlers.onLine?.(data);
    };
    es.onerror = () => {
      if (settled) return;
      handlers.onError?.(new Error('conexao com o servidor perdida'));
      finish(-1);
    };

    return {
      done,
      close() { if (!settled) { settled = true; es.close(); resolveDone(-2); } },
    };
  },

  /** Abre um WebSocket ja autenticado. */
  socket(path, params) {
    return new WebSocket(WS_BASE + url(path, params));
  },

  /** Envia um arquivo em streaming, com progresso. */
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url('/api/files/upload'));
      xhr.setRequestHeader('X-Panel-Token', TOKEN);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total, e.loaded, e.total);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) { }
        if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) resolve(data);
        else reject(new ApiError(data.err || `HTTP ${xhr.status}`, xhr.status, data));
      };
      xhr.onerror = () => reject(new ApiError('falha no envio', 0));
      xhr.send(file);
    });
  },
};

export { ApiError, url as apiUrl };
