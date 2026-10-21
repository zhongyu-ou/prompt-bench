import { $, batchActive, clipText, esc, fmtDateTime, fmtDuration, fmtTime, pretty, statusLabel } from './utils.js';
import { App } from './state.js';
import { statusTag } from './feedback.js';
import { ATTEMPT_STATUS } from './constants.js';
import { snapshotHtml } from './snapshot.js';

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

function captureResultState() {
  const panel = $('output-results-panel');
  if (panel) App.outputScrollTop = panel.scrollTop;
  document.querySelectorAll('#result-list details[data-rid]').forEach((d) => {
    if (d.open) App.expandedResults.add(d.dataset.rid);
    else App.expandedResults.delete(d.dataset.rid);
  });
}

function renderOutput() {
  const detail = App.currentDetail;
  const batch = detail?.batch || null;
  const currentBatchId = batch?.id || null;
  const sameRun = currentBatchId !== null && App.outputRenderRunId === currentBatchId;
  if (sameRun) captureResultState();
  else {
    App.outputScrollTop = 0;
    App.outputRenderRunId = currentBatchId;
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
  list.innerHTML = filtered.length
    ? filtered.map((r) => resultRowHtml(r)).join('')
    : `<div class="empty-state">${results.length ? '没有匹配当前筛选条件的结果。' : '等待结果…'}</div>`;
  const panel = $('output-results-panel');
  if (panel) panel.scrollTop = App.outputScrollTop;
  renderOutputSnapshot();
}

function resultRowHtml(r) {
  const open = App.expandedResults.has(r.id) ? 'open' : '';
  const rawRequest = r.raw_request || (r.request ? pretty(r.request) : '');
  const rawResponse = r.raw_response || '';
  const output = r.output || '';
  const error = r.error || '';
  const snippetSource = output || error || (r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发' : '（无输出）');
  const snippet = String(snippetSource).replace(/\s+/g, ' ').slice(0, 240);
  const started = r.started_at ? fmtTime(r.started_at) : '—';
  return `
    <details class="result-details" data-rid="${esc(r.id)}" ${open}>
      <summary class="result-summary">
        <span class="time">${esc(started)}</span>
        <span class="case" title="${esc(`${r.case_name || ''} ${r.case_id || ''}`)}"><span class="rep">#${esc(String(r.iteration ?? ''))}</span> ${esc(r.case_name || r.case_id || '—')}</span>
        <span class="model" title="${esc(r.model || '')}">${esc(r.model || '—')}</span>
        <span>${statusTag(r.status, ATTEMPT_STATUS)}</span>
        <span class="dur">${esc(fmtDuration(r.duration_ms))}</span>
        <span class="snippet" title="${esc(snippetSource)}">${esc(snippet)}</span>
      </summary>
      <div class="result-raw">
        <div class="raw-meta">
          <span>组 <span class="mono">${esc(r.group_name || r.group_id || '—')}</span></span>
          <span>轮次 <span class="mono">${esc(String(r.iteration ?? '—'))}</span></span>
          ${r.method ? `<span>方法 <span class="mono">${esc(r.method)}</span></span>` : ''}
          ${r.endpoint ? `<span>Endpoint <span class="mono">${esc(r.endpoint)}</span></span>` : ''}
          <span>模型 <span class="mono">${esc(r.model || '—')}</span></span>
          <span>响应模型 <span class="mono">${esc(r.response_model || '—')}</span></span>
          <span>HTTP <span class="mono">${esc(String(r.http_status || '—'))}</span></span>
          <span>耗时 <span class="mono">${esc(fmtDuration(r.duration_ms))}</span></span>
          <span>hash <span class="mono">${esc(r.prompt_hash || '—')}</span></span>
        </div>
        ${r.headers && typeof r.headers === 'object' ? `<div class="raw-block"><h4>非认证请求头</h4><pre>${esc(pretty(r.headers))}</pre></div>` : ''}
        <div class="raw-block">
          <h4>原始请求 raw_request</h4>
          <pre>${esc(clipText(rawRequest) || '（尚未派发）')}</pre>
        </div>
        <div class="raw-block">
          <h4>原始响应 raw_response</h4>
          <pre>${esc(clipText(rawResponse) || '（无响应正文）')}</pre>
        </div>
        ${output ? `<div class="raw-block"><h4>解析输出 output</h4><pre>${esc(clipText(output))}</pre></div>` : ''}
        ${error ? `<div class="raw-block"><h4>错误 error</h4><pre>${esc(clipText(error))}</pre></div>` : ''}
      </div>
    </details>`;
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

export { renderOutput, resultRowHtml, setOutputTab };
