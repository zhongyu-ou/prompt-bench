import { $, batchActive, esc, fmtDuration, fmtTime, pretty, statusLabel } from './utils.js';
import { App } from './state.js';
import { statusTag, toast } from './feedback.js';
import { ATTEMPT_STATUS } from './constants.js';
import { snapshotHtml } from './snapshot.js';
import { previewCodeHtml } from './json-preview.js';
import { evaluationBadge, evaluationStatusTag, formatValue, metricMap, metricTypeLabel, outcomeHtml, progressInfo, summaryExtra, summaryResult } from './evaluation.js';
import { summarizeEvaluations } from './evaluation-summary.js';
import { openMetricEditorById } from './metrics.js';
import { metricTargetLabel } from './model.js';

const previewTabs = [['output', '输出'], ['request', '请求'], ['response', '响应'], ['details', '详情'], ['eval', '评估']];
const previewHtml = new WeakMap();
const rowHtml = new WeakMap();
const browserDetail = new WeakMap();
let previewSequence = 0;

function setOutputTab(tab) {
  const allowed = ['results', 'summary', 'snapshot'];
  const next = allowed.includes(tab) ? tab : 'results';
  App.outputTab = next;
  for (const key of allowed) {
    const button = $(`out-tab-${key}`);
    if (button) button.setAttribute('aria-selected', key === next ? 'true' : 'false');
  }
  $('output-results-panel').hidden = next !== 'results';
  $('output-summary-panel').hidden = next !== 'summary';
  $('output-snapshot-panel').hidden = next !== 'snapshot';
  $('output-toolbar').hidden = next === 'snapshot';
  $('filter-status-field').hidden = next === 'summary';
  renderOutput();
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
  syncMetricFilterOptions(detail);
}

function syncMetricFilterOptions(detail) {
  const host = $('output-metric-filters');
  const runId = detail?.batch?.id || null;
  if (App.outputMetricFilterRunId !== runId) {
    App.outputMetricFilters.clear();
    App.outputMetricFilterRunId = runId;
  }
  const metrics = [...metricMap(detail).values()].map((entry) => entry.metric)
    .filter((metric) => metric.return_type === 'boolean' || metric.return_type === 'classification');
  const fields = metrics.map((metric) => {
    const name = metric.name || metric.id;
    const duplicateName = metrics.some((other) => other.id !== metric.id && (other.name || other.id) === name);
    return {
      id: metric.id,
      name: duplicateName ? `${name}（${metricTypeLabel(metric)}）` : name,
      values: metric.return_type === 'boolean' ? [true, false] : (metric.labels || []).map((label) => label.label)
    };
  });
  for (const [id, value] of App.outputMetricFilters) {
    if (!fields.some((field) => field.id === id && field.values.includes(value))) App.outputMetricFilters.delete(id);
  }
  const signature = JSON.stringify([runId, fields]);
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    host.innerHTML = fields.map((field) => `<label class="inline-field"><span>${esc(field.name)}</span><select class="input select compact" data-output-metric-filter="${esc(field.id)}" aria-label="${esc(field.name)}"><option value="">全部</option>${field.values.map((value) => `<option value="${esc(JSON.stringify(value))}">${esc(String(value))}</option>`).join('')}</select></label>`).join('');
  }
  host.hidden = fields.length === 0;
  host.querySelectorAll('[data-output-metric-filter]').forEach((select) => {
    select.value = App.outputMetricFilters.has(select.dataset.outputMetricFilter)
      ? JSON.stringify(App.outputMetricFilters.get(select.dataset.outputMetricFilter)) : '';
  });
}

function matchesOutputFilters(result, includeGenerationStatus = true) {
  if (App.outputFilter.group && result.group_id !== App.outputFilter.group) return false;
  if (App.outputFilter.case && result.case_id !== App.outputFilter.case) return false;
  if (includeGenerationStatus && App.outputFilter.status && result.status !== App.outputFilter.status) return false;
  for (const [id, value] of App.outputMetricFilters) {
    const outcome = (result.evaluations || []).find((item) => item.metric_id === id);
    if (outcome?.status !== 'completed' || outcome.value !== value) return false;
  }
  return true;
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
    syncMetricFilterOptions(null);
    empty.hidden = false;
    empty.textContent = '尚未运行。选择案例和对照配置后点击“运行”。';
    list.innerHTML = '';
    $('output-pager').hidden = true;
    $('stop-confirm').hidden = true;
    renderOutputSummary();
    App.outputRenderRunId = null;
    App.snapshotRenderedFor = null;
    renderOutputSnapshot();
    return;
  }

  const progress = progressInfo(batch);
  const generationDone = progress.generationTotal > 0 && progress.generationDone >= progress.generationTotal;
  const evaluationActive = progress.evalTotal > 0 && progress.evalBusy > 0;
  const active = batchActive(batch);
  const phase = !active
    ? statusLabel(batch.status)
    : batch.status === 'stopping'
      ? '停止中…'
      : (generationDone && evaluationActive ? '评估中' : '运行中');
  statusLabelEl.textContent = `${phase}${batch.in_flight ? ` · 在途 ${batch.in_flight}` : ''}`;
  statusLabelEl.className = `progress-label${active ? ' running' : ''}${batch.failed ? ' err' : ''}`;
  const barTotal = generationDone && progress.evalTotal ? progress.evalTotal : progress.generationTotal;
  const barDone = generationDone && progress.evalTotal ? progress.evalDone : progress.generationDone;
  progressTrack.setAttribute('aria-valuemax', String(barTotal || 0));
  progressTrack.setAttribute('aria-valuenow', String(barDone || 0));
  progressTrack.setAttribute('aria-valuetext', progress.evalTotal
    ? `生成 ${progress.generationDone} / ${progress.generationTotal}，评估 ${progress.evalDone} / ${progress.evalTotal}，在途 ${batch.in_flight || 0}`
    : `生成 ${progress.generationDone} / ${progress.generationTotal}，在途 ${batch.in_flight || 0}`);
  progressFill.style.width = barTotal ? `${Math.min(100, (barDone / barTotal) * 100)}%` : '0%';
  progressText.textContent = progress.evalTotal
    ? `生成 ${progress.generationDone}/${progress.generationTotal} · 评估 ${progress.evalDone}/${progress.evalTotal}`
    : `${progress.generationDone} / ${progress.generationTotal}`;
  stopBtn.hidden = !active;
  stopBtn.disabled = batch.status === 'stopping';
  stopBtn.innerHTML = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/></svg>${batch.status === 'stopping' ? '停止中…' : '停止运行'}`;
  $('stop-confirm').hidden = !(active && App.stopConfirm && batch.status !== 'stopping');

  const results = detail.results || [];
  empty.hidden = results.length > 0;
  empty.textContent = active
    ? '批次已创建，正在等待首次请求派发…'
    : '该批次没有结果记录。';

  syncFilterOptions(detail);
  const filtered = results.filter((result) => matchesOutputFilters(result, App.outputTab !== 'summary'));
  const paging = App.outputPaging;
  const signature = JSON.stringify([batch.id, App.outputFilter.group, App.outputFilter.case, App.outputFilter.status, [...App.outputMetricFilters]]);
  if (paging.signature !== signature) {
    paging.signature = signature;
    paging.page = 1;
    App.outputScrollTop = 0;
    list.dataset.selected = '';
  }
  const pages = Math.max(1, Math.ceil(filtered.length / paging.pageSize));
  paging.page = Math.min(Math.max(1, paging.page), pages);
  const start = (paging.page - 1) * paging.pageSize;
  const pageResults = filtered.slice(start, start + paging.pageSize);
  $('output-pager').hidden = false;
  $('output-page-range').textContent = `显示 ${filtered.length ? start + 1 : 0}–${start + pageResults.length} / ${filtered.length} 条`;
  if (document.activeElement !== $('output-page-number')) $('output-page-number').value = paging.page;
  $('output-page-number').max = pages;
  $('output-page-total').textContent = `/ ${pages} 页`;
  $('output-page-size').value = paging.pageSize;
  $('output-page-prev').disabled = paging.page <= 1;
  $('output-page-next').disabled = paging.page >= pages;
  renderResultBrowser(list, pageResults, results.length ? '没有匹配当前筛选条件的结果。' : '等待结果…');
  list.querySelector('.result-rows').scrollTop = App.outputScrollTop;
  renderOutputSummary();
  renderOutputSnapshot();
}

function listScrollTop() {
  return $('result-list').querySelector('.result-rows')?.scrollTop || 0;
}

function metricCellHtml(result, entry) {
  const outcome = (result.evaluations || []).find((item) => item.metric_id === entry.metric.id);
  if (!outcome) return '<span class="muted">—</span>';
  if (outcome.status !== 'completed') {
    return `<span title="${esc(outcome.error || '')}">${evaluationStatusTag(outcome.status)}</span>`;
  }
  const tone = entry.metric.return_type === 'boolean' ? (outcome.value ? 'true' : 'false') : entry.metric.return_type;
  return `<span class="result-metric-value ${esc(tone)}" title="${esc(outcome.reason || '')}">${esc(formatValue(outcome.value, entry.metric))}</span>`;
}

function resultRowHtml(r, selected, entries) {
  const snippetSource = r.error || r.output || (r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发' : '（无输出）');
  const snippet = String(snippetSource).replace(/\s+/g, ' ').slice(0, 240);
  const started = r.started_at ? fmtTime(r.started_at) : '—';
  return `
      <tr class="result-summary${selected ? ' selected' : ''}" data-rid="${esc(r.id)}" tabindex="0" aria-selected="${selected}">
        <td class="time">${esc(started)}</td>
        <td class="rep">#${esc(String(r.iteration ?? ''))}</td>
        <td class="case" title="${esc(`${r.case_name || ''} ${r.case_id || ''}`)}">${esc(r.case_name || r.case_id || '—')}</td>
        <td class="group" title="${esc(r.group_name || r.group_id || '')}">${esc(r.group_name || r.group_id || '—')}</td>
        <td>${statusTag(r.status, ATTEMPT_STATUS)}</td>
        ${entries.length ? `<td class="eval-indicator">${evaluationBadge(r)}</td>` : ''}
        <td class="dur">${esc(fmtDuration(r.duration_ms))}</td>
        ${entries.map((entry) => `<td class="metric-cell">${metricCellHtml(r, entry)}</td>`).join('')}
        <td class="snippet${r.status === 'failed' ? ' output-error' : ''}" title="${esc(snippetSource)}">${esc(snippet)}</td>
      </tr>`;
}

function renderResultRows(rows, results, selectedId, emptyText, entries) {
  const existing = new Map([...rows.querySelectorAll('[data-rid]')].map((node) => [node.dataset.rid, node]));
  const ids = new Set(results.map((r) => r.id));
  for (const node of [...rows.children]) {
    if (!ids.has(node.dataset.rid)) node.remove();
  }
  results.forEach((r, index) => {
    const html = resultRowHtml(r, r.id === selectedId, entries);
    let node = existing.get(r.id);
    if (!node || rowHtml.get(node) !== html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const next = template.content.firstElementChild;
      if (node) {
        node.className = next.className;
        node.setAttribute('aria-selected', next.getAttribute('aria-selected'));
        node.replaceChildren(...next.childNodes);
      } else node = next;
      rowHtml.set(node, html);
    }
    if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] || null);
  });
  if (!results.length) rows.innerHTML = `<tr><td colspan="${7 + entries.length + (entries.length ? 1 : 0)}"><div class="empty-state">${esc(emptyText)}</div></td></tr>`;
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

function evaluationPreviewHtml(result, detail) {
  const outcomes = Array.isArray(result.evaluations) ? result.evaluations : [];
  if (!outcomes.length) {
    return '<div class="empty-state">该结果没有评估记录。若批次未选择指标，只保留生成输出。</div>';
  }
  const entries = metricMap(detail);
  return outcomes.map((outcome) => {
    const entry = entries.get(outcome.metric_id);
    const metric = entry?.metric || null;
    const target = entry?.target || null;
    return `<section class="eval-block">
      <div class="eval-block-head">
        <span class="eval-block-name">${esc(metric?.name || outcome.metric_id)}</span>
        <span class="metric-type-inline">${esc(metricTypeLabel(metric))}</span>
      </div>
      <div class="eval-target"><span>评估对象</span><span class="mono">${esc(metricTargetLabel(target))}</span></div>
      ${outcomeHtml(outcome, metric, { includeRaw: true })}
      ${metric ? `<button type="button" class="link-btn eval-config-link" data-eval-config="${esc(metric.id)}">指标配置与调用详情</button>` : '<span class="muted small">指标配置已不存在，仅保留历史判断。</span>'}
    </section>`;
  }).join('');
}

function resultPreviewHtml(r, tab, detail = App.currentDetail) {
  if (tab === 'output') {
    return `${r.error ? `<div class="preview-error" role="note">${esc(r.error)}</div>` : ''}`
      + previewCodeHtml(r.output, r.error ? '没有解析输出。' : r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发。' : '没有解析输出。');
  }
  if (tab === 'request') return previewCodeHtml(resultPreviewText(r, tab), '没有请求正文。');
  if (tab === 'response') return previewCodeHtml(r.raw_response, '没有响应正文。');
  if (tab === 'eval') return evaluationPreviewHtml(r, detail);
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

function renderResultBrowser(el, results, emptyText = '没有结果记录。', detail = null) {
  if (detail) browserDetail.set(el, detail);
  const ctxDetail = detail || browserDetail.get(el) || App.currentDetail;
  const selectedId = el.dataset.selected || '';
  const selected = results.find((r) => r.id === selectedId);
  const scrollTop = el.querySelector('.result-rows')?.scrollTop || 0;
  const scrollLeft = el.querySelector('.result-rows')?.scrollLeft || 0;
  const entries = [...metricMap(ctxDetail).values()];
  const bodyBefore = el.querySelector('.result-preview-body');
  const previewScroll = { top: bodyBefore?.scrollTop || 0, left: bodyBefore?.scrollLeft || 0 };
  if (!el.querySelector('.result-rows')) {
    const id = `result-preview-${++previewSequence}`;
    el.innerHTML = `<div class="result-rows" tabindex="0" role="region" aria-label="运行结果表，可左右滚动"><table class="result-table"><thead></thead><tbody></tbody></table></div><aside class="result-preview" aria-label="结果预览" hidden>
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
  const columns = [
    ['时间', 76], ['轮次', 56], ['Case', 230], ['配置', 150], ['模型状态', 90],
    ...(entries.length ? [['评估状态', 90]] : []), ['耗时', 70],
    ...entries.map((entry) => [entry.metric.name || entry.metric.id, 160, `${metricTypeLabel(entry.metric)} · ${metricTargetLabel(entry.target)}`]),
    ['输出', 380]
  ];
  const table = rows.querySelector('.result-table');
  const headings = `<tr>${columns.map(([label, width, hint]) => `<th scope="col" style="width:${width}px" title="${esc(hint || label)}">${esc(label)}</th>`).join('')}</tr>`;
  if (table.tHead.innerHTML !== headings) table.tHead.innerHTML = headings;
  table.style.width = `${columns.reduce((sum, [, width]) => sum + width, 0)}px`;
  renderResultRows(table.tBodies[0], results, selected?.id, emptyText, entries);
  rows.scrollTop = scrollTop;
  rows.scrollLeft = scrollLeft;
  const preview = el.querySelector('.result-preview');
  preview.hidden = !selected;
  const tab = el.dataset.activePreviewTab || 'output';
  const copyButton = el.querySelector('[data-preview-copy]');
  copyButton.hidden = tab === 'details' || tab === 'eval';
  const copyText = selected ? resultPreviewText(selected, tab) : '';
  copyButton.disabled = !copyText;
  el.querySelectorAll('[data-preview-tab]').forEach((button) => {
    const active = button.dataset.previewTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const body = el.querySelector('.result-preview-body');
  body.setAttribute('aria-labelledby', el.querySelector(`[data-preview-tab="${tab}"]`).id);
  const content = selected ? resultPreviewHtml(selected, tab, ctxDetail) : '';
  if (previewHtml.get(body) !== content) {
    body.innerHTML = content;
    previewHtml.set(body, content);
  }
  body.scrollTop = selectedId === selected?.id ? previewScroll.top : 0;
  body.scrollLeft = selectedId === selected?.id ? previewScroll.left : 0;
  el.onclick = (event) => {
    const evalConfig = event.target.closest('[data-eval-config]');
    if (evalConfig) {
      if (!openMetricEditorById(evalConfig.dataset.evalConfig)) toast('指标配置已不存在，仅保留历史判断。', 'info');
      return;
    }
    const row = event.target.closest('[data-rid]');
    const tabButton = event.target.closest('[data-preview-tab]');
    if (event.target.closest('[data-preview-copy]')) {
      void copyResultPreview(copyText);
    } else if (tabButton) {
      el.dataset.activePreviewTab = tabButton.dataset.previewTab;
      body.scrollTop = body.scrollLeft = 0;
      renderResultBrowser(el, results, emptyText);
    } else if (row) {
      if (event.target.closest('.metric-cell, .eval-indicator')) el.dataset.activePreviewTab = 'eval';
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
    const selectedRow = event.target.closest('tr[data-rid]');
    if (selectedRow && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectedRow.click();
      return;
    }
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

function renderOutputSummary() {
  const host = $('output-summary');
  const empty = $('output-summary-empty');
  if (!host || !empty) return;
  const detail = App.currentDetail;
  const results = Array.isArray(detail?.results) ? detail.results : [];
  const frozenMetrics = Array.isArray(detail?.snapshot?.metrics) ? detail.snapshot.metrics : [];
  const filteredResults = results.filter((result) => matchesOutputFilters(result, false));
  const hasEvaluations = filteredResults.some((result) => Array.isArray(result.evaluations) && result.evaluations.length);
  if (!frozenMetrics.length || !filteredResults.length || !hasEvaluations) {
    host.innerHTML = '';
    empty.hidden = false;
    empty.textContent = !detail?.batch
      ? '选择指标并运行后可在这里查看评估汇总。'
      : !frozenMetrics.length
        ? '该批次没有选择评估指标。历史批次不会重新评估。'
        : !filteredResults.length
          ? '没有匹配当前筛选条件的结果。'
          : '所选结果没有评估记录。';
    return;
  }
  empty.hidden = true;
  const rows = summarizeEvaluations(filteredResults, frozenMetrics);
  const entries = metricMap(detail);
  const globalRows = rows.filter((row) => row.group_id === '');
  const body = globalRows.map((row) => {
    const metric = entries.get(row.metric_id)?.metric || null;
    return `<tr>
      <td>
        <div class="summary-metric-name">${esc(metric?.name || row.metric_id)}</div>
        <div class="summary-metric-type">${esc(metricTypeLabel(metric))}</div>
      </td>
      <td class="summary-number">${esc(String(row.valid ?? 0))}</td>
      <td class="summary-number${row.error ? ' error' : ''}">${esc(String(row.error ?? 0))}</td>
      <td>
        <div class="summary-result">${esc(summaryResult(row, metric))}</div>
        ${summaryExtra(row)}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4"><div class="empty-state">没有可汇总的指标行。</div></td></tr>';
  const groupIds = [...new Set(rows.map((row) => row.group_id).filter(Boolean))];
  const groupLines = App.outputFilter.group ? '' : groupIds.map((id) => {
    const groupRows = rows.filter((row) => row.group_id === id);
    const bits = groupRows.map((row) => {
      const metric = entries.get(row.metric_id)?.metric || null;
      return `${metric?.name || row.metric_id} ${summaryResult(row, metric)}`;
    });
    const errors = groupRows.reduce((sum, row) => sum + (Number(row.error) || 0), 0);
    return `<div class="summary-group-line"><strong>${esc(summaryGroupName(detail, id))}</strong><span>${esc(bits.join(' · '))}</span>${errors ? `<span class="summary-group-error">错误 ${errors}</span>` : ''}</div>`;
  }).join('');
  host.innerHTML = `<div class="summary-wrap">
    <div class="summary-head"><h3>指标汇总</h3><span class="muted small">按当前筛选条件统计；仅完成的判断计入有效分母。</span></div>
    <div class="table-wrap summary-table-wrap">
      <table class="data-table summary-table">
        <thead><tr><th scope="col">指标</th><th scope="col">有效</th><th scope="col">错误</th><th scope="col">结果</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted small summary-note">错误与未执行项不计入有效判断分母。</p>
    ${groupLines ? `<div class="summary-groups">${groupLines}</div>` : ''}
  </div>`;
}

function summaryGroupName(detail, id) {
  const group = (detail?.snapshot?.groups || []).find((g) => g.id === id);
  return group ? (group.name || group.id) : (id || '全部');
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
  $('output-metric-filters').addEventListener('change', (event) => {
    const select = event.target.closest('[data-output-metric-filter]');
    if (!select) return;
    if (select.value === '') App.outputMetricFilters.delete(select.dataset.outputMetricFilter);
    else App.outputMetricFilters.set(select.dataset.outputMetricFilter, JSON.parse(select.value));
    renderOutput();
  });
  function changePage(page) {
    App.outputPaging.page = page;
    const list = $('result-list');
    list.dataset.selected = '';
    const rows = list.querySelector('.result-rows');
    if (rows) rows.scrollTop = 0;
    renderOutput();
    $('output-page-number').value = App.outputPaging.page;
  }
  $('output-page-prev').addEventListener('click', () => changePage(App.outputPaging.page - 1));
  $('output-page-next').addEventListener('click', () => changePage(App.outputPaging.page + 1));
  $('output-page-number').addEventListener('change', (event) => changePage(Math.trunc(Number(event.target.value)) || 1));
  $('output-page-size').addEventListener('change', (event) => {
    const size = Number(event.target.value);
    if (![20, 50, 100].includes(size)) return;
    App.outputPaging.pageSize = size;
    changePage(1);
  });
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
