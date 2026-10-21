import { setConnection } from './feedback.js';

async function apiRaw(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  if (options.signal) opts.signal = options.signal;
  let res;
  try {
    res = await fetch(path, opts);
    setConnection(true);
  } catch (err) {
    setConnection(false);
    const error = new Error('无法连接本地服务。请确认 Promptbench 服务正在运行。');
    error.cause = err;
    throw error;
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && payload.error
      ? payload.error
      : `请求失败（HTTP ${res.status}）`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return { payload, text, res };
}

async function api(path, options = {}) {
  return (await apiRaw(path, options)).payload;
}

const apiGet = (path) => api(path);

const apiPost = (path, body = {}) => api(path, { method: 'POST', body });

export { apiGet, apiPost, apiRaw };
