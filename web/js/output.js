import { $, batchActive, esc, fmtDateTime, fmtDuration, fmtTime, pretty, statusLabel } from './utils.js';
import { App } from './state.js';
import { statusTag, toast } from './feedback.js';
import { ATTEMPT_STATUS } from './constants.js';
import { snapshotHtml } from './snapshot.js';
import { previewCodeHtml } from './json-preview.js';

const previewTabs = [['output', '输出'], ['request', '请求'], ['response', '响应'], ['details', '详情']];
const previewHtml = new WeakMap();
const rowHtml = new WeakMap();
let previewSequence = 0;

function setOutputTab(tab) {
  const isResults = tab === 'results';
  const tabResults = $('out-tab-results');
  const tabSnapshot = $('out-tab-snapshot');
  tabResults.setAttribute('aria-selected', isResults ? 'true' : 'false');
  tabSnapshot.setAttribute('aria-selected', isResults ? 'false' : 'true');
  $('output-results-panel').hidden = !isResults;
  $('output-snapshot-panel').hidden = isResults;
  $('output-toolbar').hidden = !isResults;
}

function syncFilterOptions(detail) {
  const results = detail.results || [];
  const groups = new Map();
  const cases = new Map();
  for (const r of results) {
    if (r.group_id) groups.set(r.group_id, r.group_name || r.group_id);
    if (r.case_id) cases.set(r.case_id, r.case_name || r.case_id);
  }
  const signature = JSON.stringify([[...groups.entries()], [...cases.entries()]]);
  if (signature !== App.lastFilterSignature) {
    App.lastFilterSignature = signature;
    const gSel = $('filter-group');
    const cSel = $('filter-case');
    gSel.innerHTML = '<option value="">全部</option>' + [...groups.entries()]
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    cSel.innerHTML = '<option value="">全部</option>' + [...cases.entries()]
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  }
  const gSel = $('filter-group');
  const cSel = $('filter-case');
  gSel.value = [...gSel.options].some((o) => o.value === App.outputFilter.group) ? App.outputFilter.group : '';
  cSel.value = [...cSel.options].some((o) => o.value === App.outputFilter.case) ? App.outputFilter.case : '';
  App.outputFilter.group = gSel.value;
  App.outputFilter.case = cSel.value;
  $('filter-status').value = App.outputFilter.status || '';
  void detail;
}

function renderOutput() {
  const detail = App.currentDetail;
  const batch = detail?.batch || null;
  const currentBatchId = batch?.id || null;
  const sameRun = currentBatchId !== null && App.outputRenderRunId === currentBatchId;
  if (sameRun) App.outputScrollTop = listScrollTop();
  else {
    App.outputScrollTop = 0;
    App.outputRenderRunId = currentBatchId;
    $('result-list').dataset.selected = '';
  }
  const stopBtn = $('stop-btn');
  const statusLabelEl = $('run-status-label');
  const progressTrack = $('progress-track');
  const progressFill = $('progress-fill');
  const progressText = $('progress-text');
  const empty = $('output-empty');
  const list = $('result-list');

  if (!batch) {
    statusLabelEl.textContent = '尚无运行';
    statusLabelEl.className = 'progress-label';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressTrack.setAttribute('aria-valuemax', '0');
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 0';
    stopBtn.hidden = true;
    $('batch-meta').textContent = '';
    empty.hidden = false;
    empty.textContent = '尚未运行。选择案例和对照配置后点击“运行”。';
    list.innerHTML = '';
    $('result-count').textContent = '';
    App.outputRenderRunId = null;
    App.snapshotRenderedFor = null;
    renderOutputSnapshot();
    return;
  }

  const finished = (batch.completed || 0) + (batch.failed || 0) + (batch.cancelled || 0) + (batch.interrupted || 0);
  const active = batchActive(batch);
  statusLabelEl.textContent = `${statusLabel(batch.status)}${batch.in_flight ? ` · 在途 ${batch.in_flight}` : ''}`;
  statusLabelEl.className = `progress-label${active ? ' running' : ''}${batch.failed ? ' err' : ''}`;
  progressTrack.setAttribute('aria-valuemax', String(batch.total || 0));
  progressTrack.setAttribute('aria-valuenow', String(finished));
  progressTrack.setAttribute('aria-valuetext', `${finished} / ${batch.total || 0}，在途 ${batch.in_flight || 0}`);
  progressFill.style.width = batch.total ? `${Math.min(100, (finished / batch.total) * 100)}%` : '0%';
  progressText.textContent = `${finished} / ${batch.total || 0}`;
  stopBtn.hidden = !active;
  stopBtn.disabled = batch.status === 'stopping';
  stopBtn.innerHTML = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/></svg>${batch.status === 'stopping' ? '停止中…' : '停止运行'}`;
  $('batch-meta').textContent = `#${batch.id} · ${batch.name || ''} · 并发 ${batch.concurrency} · ${fmtDateTime(batch.created_at)}`;

  const results = detail.results || [];
  empty.hidden = results.length > 0;
  empty.textContent = active
    ? '批次已创建，正在等待首次请求派发…'
    : '该批次没有结果记录。';

  syncFilterOptions(detail);
  const filtered = results.filter((r) => {
    if (App.outputFilter.group && r.group_id !== App.outputFilter.group) return false;
    if (App.outputFilter.case && r.case_id !== App.outputFilter.case) return false;
    if (App.outputFilter.status && r.status !== App.outputFilter.status) return false;
    return true;
  });
  $('result-count').textContent = `${filtered.length} / ${results.length} 条`;
  renderResultBrowser(list, filtered, results.length ? '没有匹配当前筛选条件的结果。' : '等待结果…');
  list.querySelector('.result-rows').scrollTop = App.outputScrollTop;
  renderOutputSnapshot();
}

function listScrollTop() {
  return $('result-list').querySelector('.result-rows')?.scrollTop || 0;
}

function resultRowHtml(r, selected) {
  const snippetSource = r.output || r.error || (r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发' : '（无输出）');
  const snippet = String(snippetSource).replace(/\s+/g, ' ').slice(0, 240);
  const started = r.started_at ? fmtTime(r.started_at) : '—';
  return `
      <button type="button" class="result-summary${selected ? ' selected' : ''}" data-rid="${esc(r.id)}" aria-pressed="${selected}">
        <span class="time">${esc(started)}</span>
        <span class="case" title="${esc(`${r.case_name || ''} ${r.case_id || ''}`)}"><span class="rep">#${esc(String(r.iteration ?? ''))}</span> ${esc(r.case_name || r.case_id || '—')}</span>
        <span class="model" title="${esc(r.model || '')}">${esc(r.model || '—')}</span>
        <span>${statusTag(r.status, ATTEMPT_STATUS)}</span>
        <span class="dur">${esc(fmtDuration(r.duration_ms))}</span>
        <span class="snippet" title="${esc(snippetSource)}">${esc(snippet)}</span>
      </button>`;
}

function renderResultRows(rows, results, selectedId, emptyText) {
  const existing = new Map([...rows.querySelectorAll('[data-rid]')].map((node) => [node.dataset.rid, node]));
  const ids = new Set(results.map((r) => r.id));
  for (const node of [...rows.children]) {
    if (!ids.has(node.dataset.rid)) node.remove();
  }
  results.forEach((r, index) => {
    const html = resultRowHtml(r, r.id === selectedId);
    let node = existing.get(r.id);
    if (!node || rowHtml.get(node) !== html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const next = template.content.firstElementChild;
      if (node) {
        node.className = next.className;
        node.setAttribute('aria-pressed', next.getAttribute('aria-pressed'));
        node.replaceChildren(...next.childNodes);
      } else node = next;
      rowHtml.set(node, html);
    }
    if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] || null);
  });
  if (!results.length) rows.innerHTML = `<div class="empty-state">${esc(emptyText)}</div>`;
}

function resultPreviewText(r, tab) {
  if (tab === 'output') return [r.error, r.output].filter((value) => value != null && String(value) !== '').map(String).join('\n\n');
  if (tab === 'request') return r.raw_request || (r.request ? pretty(r.request) : '');
  if (tab === 'response') return r.raw_response || '';
  return '';
}

async function copyResultPreview(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('预览内容已复制', 'ok', 1800);
  } catch {
    toast('复制失败：剪贴板不可用或权限被拒绝，请手动选择文本。', 'error');
  }
}

function resultPreviewHtml(r, tab) {
  if (tab === 'output') {
    return `${r.error ? `<div class="preview-error" role="note">${esc(r.error)}</div>` : ''}`
      + previewCodeHtml(r.output, r.error ? '没有解析输出。' : r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发。' : '没有解析输出。');
  }
  if (tab === 'request') return previewCodeHtml(resultPreviewText(r, tab), '没有请求正文。');
  if (tab === 'response') return previewCodeHtml(r.raw_response, '没有响应正文。');
  return `<dl class="preview-meta">
    <dt>组</dt><dd>${esc(r.group_name || r.group_id || '—')}</dd>
    <dt>轮次</dt><dd>${esc(String(r.iteration ?? '—'))}</dd>
    ${r.method ? `<dt>方法</dt><dd>${esc(r.method)}</dd>` : ''}
    ${r.endpoint ? `<dt>Endpoint</dt><dd>${esc(r.endpoint)}</dd>` : ''}
    <dt>模型</dt><dd>${esc(r.model || '—')}</dd>
    <dt>响应模型</dt><dd>${esc(r.response_model || '—')}</dd>
    <dt>HTTP</dt><dd>${esc(String(r.http_status || '—'))}</dd>
    <dt>耗时</dt><dd>${esc(fmtDuration(r.duration_ms))}</dd>
    <dt>Prompt hash</dt><dd>${esc(r.prompt_hash || '—')}</dd>
  </dl>${r.headers && typeof r.headers === 'object'
    ? `<h4 class="preview-section-title">非认证请求头</h4>${previewCodeHtml(pretty(r.headers), '')}` : ''}`;
}

function renderResultBrowser(el, results, emptyText = '没有结果记录。') {
  const selectedId = el.dataset.selected || '';
  const selected = results.find((r) => r.id === selectedId);
  const scrollTop = el.querySelector('.result-rows')?.scrollTop || 0;
  const bodyBefore = el.querySelector('.result-preview-body');
  const previewScroll = { top: bodyBefore?.scrollTop || 0, left: bodyBefore?.scrollLeft || 0 };
  if (!el.querySelector('.result-rows')) {
    const id = `result-preview-${++previewSequence}`;
    el.innerHTML = `<div class="result-rows"></div><aside class="result-preview" aria-label="结果预览" hidden>
      <div class="result-preview-head"><h3>结果预览</h3><button type="button" class="btn tiny" data-preview-close>关闭</button></div>
      <div class="filetabs result-preview-tabs" role="tablist" aria-label="预览内容">
        ${previewTabs.map(([key, label]) => `<button type="button" class="filetab" role="tab" id="${id}-${key}" data-preview-tab="${key}" aria-controls="${id}-panel">${label}</button>`).join('')}
      </div>
      <div class="result-preview-content">
        <button type="button" class="icon-btn preview-copy" data-preview-copy aria-label="复制当前预览内容" title="复制当前预览内容">
          <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 4V3H3v9h1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <div class="result-preview-body" id="${id}-panel" role="tabpanel" tabindex="0"></div>
      </div></aside>`;
  }
  el.classList.add('result-browser');
  el.classList.toggle('has-preview', !!selected);
  el.dataset.selected = selected?.id || '';
  const rows = el.querySelector('.result-rows');
  renderResultRows(rows, results, selected?.id, emptyText);
  rows.scrollTop = scrollTop;
  const preview = el.querySelector('.result-preview');
  preview.hidden = !selected;
  const tab = el.dataset.activePreviewTab || 'output';
  const copyButton = el.querySelector('[data-preview-copy]');
  copyButton.hidden = tab === 'details';
  const copyText = selected ? resultPreviewText(selected, tab) : '';
  copyButton.disabled = !copyText;
  el.querySelectorAll('[data-preview-tab]').forEach((button) => {
    const active = button.dataset.previewTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const body = el.querySelector('.result-preview-body');
  body.setAttribute('aria-labelledby', el.querySelector(`[data-preview-tab="${tab}"]`).id);
  const content = selected ? resultPreviewHtml(selected, tab) : '';
  if (previewHtml.get(body) !== content) {
    body.innerHTML = content;
    previewHtml.set(body, content);
  }
  body.scrollTop = selectedId === selected?.id ? previewScroll.top : 0;
  body.scrollLeft = selectedId === selected?.id ? previewScroll.left : 0;
  el.onclick = (event) => {
    const row = event.target.closest('[data-rid]');
    const tabButton = event.target.closest('[data-preview-tab]');
    if (event.target.closest('[data-preview-copy]')) {
      void copyResultPreview(copyText);
    } else if (tabButton) {
      el.dataset.activePreviewTab = tabButton.dataset.previewTab;
      body.scrollTop = body.scrollLeft = 0;
      renderResultBrowser(el, results, emptyText);
    } else if (row) {
      if (el.dataset.selected !== row.dataset.rid) body.scrollTop = body.scrollLeft = 0;
      el.dataset.selected = row.dataset.rid;
      renderResultBrowser(el, results, emptyText);
    } else if (event.target.closest('[data-preview-close]')) {
      const id = el.dataset.selected;
      el.dataset.selected = '';
      renderResultBrowser(el, results, emptyText);
      [...rows.querySelectorAll('[data-rid]')].find((r) => r.dataset.rid === id)?.focus({ preventScroll: true });
    }
  };
  el.onkeydown = (event) => {
    const button = event.target.closest('[data-preview-tab]');
    if (button && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...el.querySelectorAll('[data-preview-tab]')];
      const index = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus({ preventScroll: true });
    }
    if (event.key === 'Escape' && el.dataset.selected) {
      event.preventDefault();
      el.querySelector('[data-preview-close]').click();
    }
  };
}

function renderOutputSnapshot() {
  const el = $('output-snapshot');
  const empty = $('output-snapshot-empty');
  const detail = App.currentDetail;
  if (!el) return;
  if (!detail || !detail.snapshot) {
    el.innerHTML = '';
    App.snapshotRenderedFor = null;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const runId = detail.batch?.id || null;
  if (runId && App.snapshotRenderedFor === runId && el.innerHTML) return;
  el.innerHTML = snapshotHtml(detail.snapshot);
  App.snapshotRenderedFor = runId;
}

export function bindOutputEvents() {
  $('filter-group').addEventListener('change', (e) => {
    App.outputFilter.group = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  $('filter-case').addEventListener('change', (e) => {
    App.outputFilter.case = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  $('filter-status').addEventListener('change', (e) => {
    App.outputFilter.status = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  document.querySelectorAll('[data-output-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setOutputTab(btn.dataset.outputTab));
  });
}

export { renderOutput, renderResultBrowser, setOutputTab };
