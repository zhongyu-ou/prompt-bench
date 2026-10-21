import { App } from './state.js';
import { $, clone, pretty } from './utils.js';
import { activeCase, activeGroup, protocolLabel } from './model.js';
import { renderPreviewState } from './preview-state.js';
import { ensureSaved, reloadFromServer } from './persistence.js';
import { apiPost } from './api.js';
import { clearEditorRenderError, showBanner, showEditorRenderError, toast } from './feedback.js';
import { focusBoundTemplate } from './templates.js';

async function refreshPreview({ silent = false } = {}) {
  if (!App.state) return;
  const token = ++App.previewToken;
  const btn = $('refresh-preview-btn');
  const initialCase = activeCase();
  const initialGroup = activeGroup();
  if (!initialCase || !initialGroup) {
    App.preview = null;
    App.previewStale = true;
    $('preview-error').textContent = '需要选择一个 case 和一个对照配置。';
    renderPreviewState();
    return;
  }
  btn.disabled = true;
  $('preview-error').textContent = '';
  $('preview-state').textContent = '加载中…';
  $('preview-state').className = 'pill subtle';
  try {
    const ok = await ensureSaved();
    if (token !== App.previewToken) return;
    if (!ok) {
      App.previewStale = true;
      renderPreviewState();
      return;
    }
    const c = activeCase();
    const g = activeGroup();
    if (!c || !g) {
      App.preview = null;
      App.previewStale = true;
      $('preview-error').textContent = '选择已改变，请重新预览。';
      renderPreviewState();
      return;
    }
    const caseId = c.id;
    const groupSnapshot = clone(g);
    const stateVersion = App.version;
    const res = await apiPost('/api/preview', { case_id: caseId, group: groupSnapshot, state_version: stateVersion });
    if (token !== App.previewToken) return;
    App.preview = res;
    App.previewStale = false;
    const req = res.request;
    $('preview-body').textContent = JSON.stringify(req, null, 2);
    $('preview-protocol').textContent = res.protocol ? protocolLabel(res.protocol) : '—';
    $('preview-protocol').title = res.protocol || '';
    const method = res.method ? String(res.method) : '';
    const endpoint = res.endpoint || '';
    const requestLine = method && endpoint ? `${method} ${endpoint}` : (endpoint || '—');
    $('preview-endpoint').textContent = requestLine;
    $('preview-endpoint').title = requestLine;
    $('preview-hash').textContent = res.prompt_hash || '—';
    $('preview-hash').title = res.prompt_hash || '';
    if ($('preview-language')) {
      const lr = res.language_resolution;
      $('preview-language').textContent = lr
        ? `${lr.source_language || '（未设置）'} → ${(lr.targets || []).map((t) => t.key).join(', ') || '—'}${lr.used_default ? ' · 默认' : ''}`
        : '—';
      $('preview-language').title = $('preview-language').textContent;
    }
    const headers = res.headers && typeof res.headers === 'object' && !Array.isArray(res.headers) ? res.headers : null;
    const hasHeaders = !!headers && Object.keys(headers).length > 0;
    $('preview-headers').textContent = hasHeaders ? pretty(headers) : '（无额外非认证请求头）';
    $('preview-raw-request').textContent = res.raw_request || '（服务端未提供原始正文字段）';
    const extra = $('preview-extra');
    if (extra) extra.hidden = !(hasHeaders || res.raw_request);
    renderPreviewState();
    clearEditorRenderError();
    if (!silent) toast('预览已按服务端当前保存状态生成', 'ok', 1800);
  } catch (err) {
    if (token !== App.previewToken) return;
    App.previewStale = true;
    if (err.status === 409) {
      $('preview-error').textContent = `预览冲突：${err.message}`;
      $('preview-state').textContent = '冲突';
      $('preview-state').className = 'pill err';
      showEditorRenderError('预览未执行：服务端状态版本已变化（409）。请重新载入后再预览，避免展示过期请求。');
      showBanner('预览冲突：服务端状态版本已变化（可能另一标签页保存了草稿）。未使用过期状态生成预览。', 'error', reloadFromServer);
      return;
    }
    $('preview-error').textContent = `预览失败：${err.message}`;
    $('preview-state').textContent = '错误';
    $('preview-state').className = 'pill err';
    showEditorRenderError(`模板渲染 / 请求预览失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function copyPreview() {
  const text = $('preview-body').textContent;
  if (!App.preview || !text) {
    toast('暂无请求预览可复制', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('请求 JSON 已复制', 'ok', 1800);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('请求 JSON 已复制', 'ok', 1800); }
    catch { toast('复制失败，请手动选择文本', 'error'); }
    ta.remove();
  }
}

export function bindPreviewEvents() {
  $('refresh-preview-btn').addEventListener('click', () => refreshPreview());
  $('copy-preview-btn').addEventListener('click', copyPreview);
  $('template-mismatch').addEventListener('click', focusBoundTemplate);
}

export { refreshPreview };
