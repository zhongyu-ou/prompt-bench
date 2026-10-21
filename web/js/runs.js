import { App } from './state.js';
import { computeRunPlan, hasKnownActiveBatch, refreshRunPlan } from './run-plan.js';
import { showBanner, toast } from './feedback.js';
import { ensureSaved } from './persistence.js';
import { $, batchActive, clampInt, clone, statusLabel } from './utils.js';
import { apiGet, apiPost } from './api.js';
import { setView } from './navigation.js';
import { renderOutput, setOutputTab } from './output.js';
import { updateDirtyUI } from './shell-view.js';
import { renderHistoryList } from './history-view.js';

async function startRun() {
  if (!App.state || App.saving || App.loading || App.mutating) return;
  let plan = computeRunPlan();
  if (plan.errors.length) {
    showBanner(`无法启动：${plan.errors[0]}`, 'error');
    refreshRunPlan();
    return;
  }
  if (hasKnownActiveBatch()) {
    showBanner('已有批次正在运行或停止中。同一时间只允许一个批次；请等待其完成或先停止。', 'warn');
    return;
  }
  const ok = await ensureSaved();
  if (!ok) return;
  plan = computeRunPlan();
  if (plan.errors.length) {
    showBanner(`无法启动：${plan.errors[0]}`, 'error');
    refreshRunPlan();
    return;
  }
  if (hasKnownActiveBatch()) {
    showBanner('已有批次正在运行或停止中。同一时间只允许一个批次。', 'warn');
    return;
  }
  App.loading = true;
  refreshRunPlan();
  App.outputFilter = { group: '', case: '', status: '' };
  App.lastFilterSignature = '';
  App.outputScrollTop = 0;
  try {
    const body = {
      name: (App.state.draft.name || '').trim() || '未命名批次',
      case_ids: [...App.state.draft.case_ids],
      collection_ids: [...App.state.draft.collection_ids],
      excluded_case_ids: [...App.state.draft.excluded_case_ids],
      groups: App.state.draft.groups.filter((g) => g.enabled).map(clone),
      concurrency: clampInt(App.state.settings.concurrency, 1, 20, 20),
      state_version: App.version
    };
    const batch = await apiPost('/api/runs', body);
    App.currentRunId = batch.id;
    App.currentDetail = null;
    setView('workbench', { force: true });
    setOutputTab('results');
    await loadRunIntoOutput(batch.id);
    startPolling();
    await refreshRuns({ quiet: true });
    toast(`批次 #${batch.id} 已启动`, 'ok');
  } catch (err) {
    if (err.status === 409) {
      showBanner('无法启动（服务端 409）：可能已有批次运行/停止中，或另一标签页修改了服务端草稿版本。未启动新批次。', 'warn');
      await refreshRuns({ quiet: true });
    } else {
      showBanner(`启动批次失败：${err.message}`, 'error');
    }
    toast(`启动失败：${err.message}`, 'error');
  } finally {
    App.loading = false;
    updateDirtyUI();
    refreshRunPlan();
  }
}

async function loadRunIntoOutput(id) {
  if (!id) return;
  const requested = id;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(requested)}`);
    if (App.currentRunId !== requested) return;
    App.currentDetail = detail;
    renderOutput();
    refreshRunPlan();
    if (batchActive(detail.batch)) {
      App.batchSeenActive = true;
      startPolling();
    } else {
      stopPolling();
    }
  } catch (err) {
    showBanner(`载入运行 #${requested} 失败：${err.message}`, 'error');
  }
}

function startPolling() {
  if (App.pollTimer) return;
  App.pollTimer = window.setInterval(pollCurrentRun, 1600);
  pollCurrentRun();
}

function stopPolling() {
  if (App.pollTimer) {
    window.clearInterval(App.pollTimer);
    App.pollTimer = null;
  }
}

async function pollCurrentRun() {
  if (!App.currentRunId || App.pollBusy) return;
  App.pollBusy = true;
  const requested = App.currentRunId;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(requested)}`);
    App.pollFailures = 0;
    if (App.currentRunId !== requested) return;
    const wasActive = App.currentDetail ? batchActive(App.currentDetail.batch) : false;
    const nowActive = batchActive(detail.batch);
    App.currentDetail = detail;
    renderOutput();
    refreshRunPlan();
    App.pollTicks += 1;
    if (App.pollTicks % 4 === 0) refreshRuns({ quiet: true });
    if (!nowActive) {
      stopPolling();
      await refreshRuns({ quiet: true });
      if (wasActive || App.batchSeenActive) {
        const summary = detail.batch;
        toast(`批次 #${summary.id} ${statusLabel(summary.status)}：完成 ${summary.completed || 0}/${summary.total || 0}，失败 ${summary.failed || 0}`, summary.failed ? 'error' : 'ok', 5000);
        App.batchSeenActive = false;
      }
    }
  } catch (err) {
    App.pollFailures += 1;
    if (App.pollFailures === 3) {
      showBanner(`轮询运行状态失败：${err.message}。将持续重试；编辑器内容不会被改动。`, 'warn');
    }
  } finally {
    App.pollBusy = false;
  }
}

async function stopRun() {
  const detail = App.currentDetail;
  if (!detail || !batchActive(detail.batch)) return;
  const btn = $('stop-btn');
  btn.disabled = true;
  try {
    const summary = await apiPost(`/api/runs/${encodeURIComponent(detail.batch.id)}/stop`, {});
    if (App.currentDetail && App.currentDetail.batch.id === summary.id) App.currentDetail.batch = summary;
    renderOutput();
    refreshRunPlan();
    toast('已请求停止：不再派发新请求，在途请求会完成。', 'ok');
    startPolling();
  } catch (err) {
    showBanner(`停止失败：${err.message}`, 'error');
    toast(`停止失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refreshRuns({ quiet = false } = {}) {
  try {
    const payload = await apiGet('/api/runs');
    App.runs = Array.isArray(payload) ? payload : [];
    App.runsLoaded = true;
    renderHistoryList();
    refreshRunPlan();
  } catch (err) {
    if (!quiet) {
      showBanner(`载入运行列表失败：${err.message}`, 'error');
      toast(`载入运行列表失败：${err.message}`, 'error');
    }
  }
}

async function resumeActiveRun() {
  const active = App.runs.find(batchActive);
  if (!active) return;
  App.currentRunId = active.id;
  await loadRunIntoOutput(active.id);
  if (App.currentDetail && batchActive(App.currentDetail.batch)) {
    startPolling();
    setOutputTab('results');
  }
}

export function bindRunEvents() {
  $('reload-run-btn').addEventListener('click', () => {
    if (App.currentRunId) loadRunIntoOutput(App.currentRunId);
  });
  $('stop-btn').addEventListener('click', stopRun);
}

export { loadRunIntoOutput, refreshRuns, resumeActiveRun, startPolling, startRun };
