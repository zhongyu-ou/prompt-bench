import { App } from './state.js';
import { $, clone, esc, fmtDateTime, statusLabel } from './utils.js';
import { apiGet, apiPost } from './api.js';
import { ensureSaved } from './persistence.js';
import { validateMetricSelection, refreshRunPlan, hasKnownActiveBatch } from './run-plan.js';
import { renderOutput } from './output.js';
import { toast } from './feedback.js';

const LEGACY = 'legacy-inline';
const active = (execution) => ['pending', 'queued', 'running', 'stopping'].includes(execution?.status);
let sourceRunId = null;
let selectionInitialized = false;
let selectionRevision = 0;
let detailSequence = 0;
let listSequence = 0;
let fetchingDetail = null;
let listLoaded = false;
let busy = false;
let actionErrorMessage = '';
let detailErrorMessage = '';
let listErrorMessage = '';
let selectedRound = 1;

function currentSource() {
  const detail = App.currentDetail;
  return detail && detail.batch.id === App.currentRunId ? detail : null;
}

function versions() {
  return App.evaluations.filter((execution) => execution.generation_run_id === sourceRunId);
}

function hasLegacy(detail = currentSource()) {
  return (detail?.results || []).some((result) => result.evaluations?.length)
    || (!!detail?.snapshot?.metrics?.length && !detail.batch.evaluation_execution_id);
}

function selectVersion(id) {
  selectionInitialized = true;
  selectionRevision += 1;
  detailSequence += 1;
  fetchingDetail = null;
  selectedRound = 1;
  actionErrorMessage = '';
  detailErrorMessage = '';
  App.evaluationSelectedId = id;
  App.evaluationDetail = null;
  if (id && id !== LEGACY) void loadSelectedEvaluation();
}

function syncSource() {
  const id = currentSource()?.batch.id || null;
  if (sourceRunId !== id) {
    sourceRunId = id;
    selectionInitialized = false;
    selectionRevision += 1;
    detailSequence += 1;
    fetchingDetail = null;
    selectedRound = 1;
    actionErrorMessage = '';
    detailErrorMessage = '';
    App.evaluationSelectedId = null;
    App.evaluationDetail = null;
  }
  if (id && listLoaded && !selectionInitialized) {
    const latest = versions()[0];
    if (latest || hasLegacy()) selectVersion(latest?.id || LEGACY);
  }
}

function selectedDetail() {
  const detail = App.evaluationDetail;
  return detail?.evaluation.id === App.evaluationSelectedId
    && detail.evaluation.generation_run_id === sourceRunId ? detail : null;
}

function rounds(detail) {
  return [...new Set((detail?.outcomes || []).map((row) => row.round || 1))].sort((a, b) => a - b);
}

// Rendering owns this projection only. Never replace or amend generation evidence.
export function getOutputDetail() {
  syncSource();
  const generation = currentSource();
  if (!generation || App.evaluationSelectedId === LEGACY) return generation;
  const detail = selectedDetail();
  const byResult = new Map();
  for (const row of detail?.outcomes || []) {
    if ((row.round || 1) !== selectedRound) continue;
    if (!byResult.has(row.result_id)) byResult.set(row.result_id, []);
    byResult.get(row.result_id).push({ ...row.outcome, metric_id: row.metric_id });
  }
  return {
    ...generation,
    evaluationLoading: !!App.evaluationSelectedId && !detail,
    snapshot: { ...generation.snapshot, metrics: detail?.snapshot?.metrics || [] },
    results: (generation.results || []).map((result) => ({ ...result, evaluations: byResult.get(result.id) || [] }))
  };
}

export function renderEvaluationControls() {
  const select = $('evaluation-version');
  if (!select) return;
  syncSource();
  const source = currentSource();
  const entries = versions();
  const options = entries.map((execution) => `<option value="${esc(execution.id)}">${esc(execution.name || '评估')} · #${esc(execution.id.slice(0, 8))} · ${esc(fmtDateTime(execution.created_at))} · ${esc(statusLabel(execution.status))}${execution.repeats > 1 ? ` · ${esc(execution.repeats)} 轮` : ''}</option>`);
  if (hasLegacy(source)) options.push(`<option value="${LEGACY}">初始评估 · ${esc(fmtDateTime(source.batch.created_at))}</option>`);
  const html = options.join('') || '<option value="">暂无评估版本</option>';
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = App.evaluationSelectedId || '';
  select.disabled = !options.length;
  const detail = selectedDetail();
  const execution = detail?.evaluation || entries.find((entry) => entry.id === App.evaluationSelectedId);
  const availableRounds = rounds(detail);
  if (availableRounds.length && !availableRounds.includes(selectedRound)) selectedRound = availableRounds[0];
  $('evaluation-round-field').hidden = availableRounds.length < 2;
  const roundSelect = $('evaluation-round');
  const roundHtml = availableRounds.map((round) => `<option value="${round}">第 ${round} 轮</option>`).join('');
  if (roundSelect.innerHTML !== roundHtml) roundSelect.innerHTML = roundHtml;
  roundSelect.value = String(selectedRound);
  const plan = App.state ? validateMetricSelection() : { selected: [], errors: [] };
  const successes = (source?.results || []).filter((result) => result.status === 'completed').length;
  const blocked = busy || App.saving || App.mutating || !source || active(source.batch) || hasKnownActiveBatch();
  $('evaluation-recalculate').disabled = blocked || !successes || !plan.selected.length || !!plan.errors.length;
  $('evaluation-recalculate').textContent = busy ? '处理中…' : '重算';
  $('evaluation-recalculate').title = `使用当前所选 ${plan.selected.length} 项指标评估此批次全部 ${successes} 份成功输出；不重新生成，不受表格筛选或历史版本子集影响。${plan.errors[0] || ''}`;
  const stop = $('evaluation-stop');
  stop.hidden = !active(execution);
  stop.disabled = busy || !detail || execution?.status === 'stopping';
  stop.textContent = execution?.status === 'stopping' ? '停止中…' : '停止评估';
  const status = $('evaluation-status');
  const progress = $('evaluation-progress');
  progress.hidden = !execution;
  if (execution) {
    const done = (execution.completed || 0) + (execution.failed || 0) + (execution.cancelled || 0) + (execution.interrupted || 0);
    progress.max = execution.total || 1;
    progress.value = done;
    const counts = [['错误', execution.failed], ['取消', execution.cancelled], ['中断', execution.interrupted], ['在途', execution.in_flight]]
      .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`);
    status.textContent = [`判断 ${done}/${execution.total || 0}`, ...counts, ...(!detail ? ['正在载入版本…'] : [])].join(' · ');
  } else status.textContent = '';
  $('evaluation-error').textContent = actionErrorMessage || detailErrorMessage || listErrorMessage || execution?.error || '';
}

async function loadSelectedEvaluation({ force = false } = {}) {
  const id = App.evaluationSelectedId;
  const runId = sourceRunId;
  if (!id || id === LEGACY || !runId) return;
  const key = `${runId}/${id}`;
  if (fetchingDetail === key && !force) return;
  fetchingDetail = key;
  const request = ++detailSequence;
  try {
    const detail = await apiGet(`/api/evaluations/${encodeURIComponent(id)}`);
    if (request !== detailSequence || currentSource()?.batch.id !== runId || App.evaluationSelectedId !== id) return;
    if (detail.evaluation.generation_run_id !== runId || detail.evaluation.id !== id) throw new Error('评估版本与当前生成批次不匹配。');
    App.evaluationDetail = detail;
    detailErrorMessage = '';
    const availableRounds = rounds(detail);
    if (availableRounds.length && !availableRounds.includes(selectedRound)) selectedRound = availableRounds[0];
    renderOutput();
    if (active(detail.evaluation)) startPoll();
  } catch (error) {
    if (request === detailSequence && currentSource()?.batch.id === runId && App.evaluationSelectedId === id) {
      detailErrorMessage = `载入评估版本失败：${error.message}`;
      renderOutput();
    }
  } finally {
    if (request === detailSequence) fetchingDetail = null;
  }
}

export async function refreshEvaluations({ quiet = false } = {}) {
  const request = ++listSequence;
  try {
    const list = await apiGet('/api/evaluations');
    if (request !== listSequence) return;
    App.evaluations = Array.isArray(list) ? list : [];
    listLoaded = true;
    listErrorMessage = '';
    syncSource();
    refreshRunPlan();
    renderOutput();
    if (App.evaluations.some(active) || active(selectedDetail()?.evaluation)) startPoll();
    else if (App.evaluationPollTimer) { clearInterval(App.evaluationPollTimer); App.evaluationPollTimer = null; }
    const selected = selectedDetail();
    if (!selected || active(selected.evaluation)) await loadSelectedEvaluation();
  } catch (error) {
    if (request !== listSequence) return;
    if (!quiet) { listErrorMessage = error.message; renderEvaluationControls(); }
    else if (App.evaluationPollTimer) { listErrorMessage = `评估轮询失败：${error.message}`; renderEvaluationControls(); }
  }
}

function startPoll() {
  if (App.evaluationPollTimer) return;
  App.evaluationPollTimer = setInterval(async () => {
    if (App.evaluationPollBusy) return;
    App.evaluationPollBusy = true;
    try { await refreshEvaluations({ quiet: true }); }
    finally { App.evaluationPollBusy = false; }
  }, 1400);
}

async function recalculate() {
  if (busy || !App.state || App.saving || App.mutating) return;
  syncSource();
  const generationRunId = sourceRunId;
  const revision = selectionRevision;
  if (!generationRunId || active(currentSource()?.batch) || hasKnownActiveBatch()) return;
  busy = true;
  actionErrorMessage = '';
  renderEvaluationControls();
  try {
    if (!await ensureSaved()) return;
    if (currentSource()?.batch.id !== generationRunId) throw new Error('保存期间已切换生成批次，本次未创建评估。');
    if (hasKnownActiveBatch()) throw new Error('已有生成或评估执行中，本次未创建评估。');
    const plan = validateMetricSelection();
    if (!plan.selected.length || plan.errors.length) throw new Error(plan.errors[0] || '请先选择至少一个指标。');
    const ids = currentSource().results.filter((result) => result.status === 'completed').map((result) => result.id);
    // An empty array means all successes to the API. Never submit an implicit scope.
    if (!ids.length) throw new Error('当前生成批次没有成功输出，无法重新计算评估。');
    const execution = await apiPost('/api/evaluations', {
      state_version: App.version,
      name: `${currentSource().batch.name || '生成批次'} · 评估`,
      generation_run_id: generationRunId,
      result_ids: ids,
      metrics: App.state.draft.metrics.map(clone),
      concurrency: App.state.settings.concurrency
    });
    App.evaluations = [execution, ...App.evaluations.filter((entry) => entry.id !== execution.id)];
    if (currentSource()?.batch.id === generationRunId && selectionRevision === revision) selectVersion(execution.id);
    refreshRunPlan();
    renderOutput();
    startPoll();
    await refreshEvaluations({ quiet: true });
    toast('已创建新评估版本；没有新生成请求，历史版本保持不变。', 'ok');
  } catch (error) {
    if (currentSource()?.batch.id === generationRunId) actionErrorMessage = error.message;
    else toast(error.message, 'error');
  } finally {
    busy = false;
    renderOutput();
  }
}

export function bindEvaluationEvents() {
  $('evaluation-version').addEventListener('change', (event) => {
    selectVersion(event.target.value);
    renderOutput();
  });
  $('evaluation-round').addEventListener('change', (event) => {
    selectedRound = Number(event.target.value);
    renderOutput();
  });
  $('evaluation-recalculate').addEventListener('click', recalculate);
  $('evaluation-stop').addEventListener('click', async () => {
    const detail = selectedDetail();
    if (busy || !active(detail?.evaluation) || !window.confirm('停止此评估？尚未开始的判断取消，在途判断收尾。')) return;
    const runId = sourceRunId;
    const id = detail.evaluation.id;
    const revision = selectionRevision;
    busy = true;
    actionErrorMessage = '';
    renderEvaluationControls();
    try {
      await apiPost(`/api/evaluations/${encodeURIComponent(id)}/stop`, {});
      if (currentSource()?.batch.id === runId && App.evaluationSelectedId === id && selectionRevision === revision) {
        await loadSelectedEvaluation({ force: true });
      }
      await refreshEvaluations({ quiet: true });
    } catch (error) {
      if (currentSource()?.batch.id === runId && App.evaluationSelectedId === id && selectionRevision === revision) actionErrorMessage = error.message;
    } finally {
      busy = false;
      renderOutput();
    }
  });
}
