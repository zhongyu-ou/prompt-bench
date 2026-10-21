import { App } from './state.js';
import { $, esc } from './utils.js';
import { BATCH_STATUS } from './constants.js';

function setConnection(ok, text) {
  App.connOnline = ok;
  const el = $('conn-status');
  const label = $('conn-text');
  if (!el || !label) return;
  el.classList.toggle('online', ok);
  el.classList.toggle('offline', !ok);
  label.textContent = text || (ok ? '本地服务在线' : '连接中断');
}

function showBanner(message, type = 'error', action = null, actionLabel = '重新载入最新状态') {
  const banner = $('global-banner');
  const text = $('global-banner-text');
  const reload = $('banner-reload-btn');
  if (!banner || !text) return;
  text.textContent = message;
  banner.hidden = false;
  banner.classList.toggle('warn', type === 'warn');
  App.bannerAction = action;
  reload.hidden = !action;
  reload.textContent = actionLabel;
}

function hideBanner() {
  const banner = $('global-banner');
  if (banner) banner.hidden = true;
  App.bannerAction = null;
  const reload = $('banner-reload-btn');
  if (reload) reload.hidden = true;
}

function toast(message, type = 'info', ms = 3600) {
  const region = $('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = String(message);
  region.appendChild(node);
  window.setTimeout(() => node.remove(), ms);
}

function statusTag(status, labels = BATCH_STATUS) {
  return `<span class="status-tag ${esc(status)}">${esc(labels[status] || status || '未知')}</span>`;
}

function showEditorRenderError(message) {
  const el = $('editor-render-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearEditorRenderError() {
  const el = $('editor-render-error');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

export { clearEditorRenderError, hideBanner, setConnection, showBanner, showEditorRenderError, statusTag, toast };
