import { App } from './state.js';
import { $ } from './utils.js';

function markPreviewStale(reason) {
  App.previewToken += 1;
  App.previewStale = true;
  const state = $('preview-state');
  if (state) {
    state.textContent = '需刷新';
    state.className = 'pill subtle';
    if (reason) state.title = reason;
  }
}

function renderPreviewState() {
  const state = $('preview-state');
  if (!state) return;
  if (!App.preview) {
    state.textContent = '未预览';
    state.className = 'pill subtle';
    $('preview-endpoint').textContent = '—';
    $('preview-hash').textContent = '—';
    $('preview-protocol').textContent = '—';
    if ($('preview-language')) $('preview-language').textContent = '—';
    $('preview-endpoint').title = '';
    $('preview-hash').title = '';
    $('preview-protocol').title = '';
    $('preview-body').textContent = '选择案例与对照配置后点击“刷新预览”。';
    const extra = $('preview-extra');
    if (extra) extra.hidden = true;
    $('preview-headers').textContent = '';
    $('preview-raw-request').textContent = '';
  } else {
    state.textContent = App.previewStale ? '需刷新' : '实时';
    state.className = App.previewStale ? 'pill subtle' : 'pill ok';
  }
}

export { markPreviewStale, renderPreviewState };
