import { App } from './state.js';
import { renderHistoryDetail, renderHistoryList, updateCompareButton } from './history-view.js';
import { $, batchActive } from './utils.js';
import { apiGet, apiPost } from './api.js';
import { showBanner, toast } from './feedback.js';
import { hasKnownActiveBatch } from './run-plan.js';
import { setView } from './navigation.js';
import { setOutputTab } from './output.js';
import { loadRunIntoOutput, refreshRuns, startPolling } from './runs.js';
import { showCompare } from './compare.js';

async function loadHistoryDetail(id) {
  App.historySelectedId = id;
  renderHistoryList();
  const empty = $('history-detail-empty');
  const detailEl = $('history-detail');
  empty.hidden = false;
  empty.textContent = `载入批次 #${id}…`;
  detailEl.hidden = true;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(id)}`);
    if (App.historySelectedId !== id) return;
    empty.hidden = true;
    detailEl.hidden = false;
    renderHistoryDetail(detail);
  } catch (err) {
    empty.hidden = false;
    empty.textContent = `载入失败：${err.message}`;
    toast(`载入批次失败：${err.message}`, 'error');
  }
}

function exportRun(id) {
  const a = document.createElement('a');
  a.href = `/api/runs/${encodeURIComponent(id)}/export`;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function replayRun(id) {
  if (hasKnownActiveBatch()) {
    showBanner('无法复跑：已有批次正在运行或停止中（同一时间只允许一个批次）。', 'warn');
    return;
  }
  try {
    const batch = await apiPost(`/api/runs/${encodeURIComponent(id)}/replay`, {});
    App.currentRunId = batch.id;
    App.currentDetail = null;
    setView('workbench', { force: true });
    setOutputTab('results');
    await loadRunIntoOutput(batch.id);
    startPolling();
    await refreshRuns({ quiet: true });
    toast(`已按冻结快照创建新批次 #${batch.id}`, 'ok');
  } catch (err) {
    if (err.status === 409) {
      showBanner('无法复跑：已有批次正在运行或停止中（服务端 409）。', 'warn');
      await refreshRuns({ quiet: true });
    } else {
      showBanner(`复跑失败：${err.message}`, 'error');
    }
    toast(`复跑失败：${err.message}`, 'error');
  }
}

async function openRunInOutput(id) {
  App.currentRunId = id;
  App.outputFilter = { group: '', case: '', status: '' };
  App.lastFilterSignature = '';
  setView('workbench', { force: true });
  setOutputTab('results');
  await loadRunIntoOutput(id);
  if (App.currentDetail && batchActive(App.currentDetail.batch)) startPolling();
}

export function bindHistoryEvents() {
  $('history-refresh-btn').addEventListener('click', async () => {
    await refreshRuns();
    if (App.historySelectedId) loadHistoryDetail(App.historySelectedId);
    toast('历史已刷新', 'ok', 1600);
  });
  $('history-run-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-history-open]');
    if (open) loadHistoryDetail(open.dataset.historyOpen);
  });
  $('history-run-list').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-compare-id]');
    if (!cb) return;
    const id = cb.dataset.compareId;
    if (cb.checked) {
      if (App.compareIds.size >= 6) {
        cb.checked = false;
        toast('最多同时对比 6 个批次', 'info');
        return;
      }
      App.compareIds.add(id);
    } else {
      App.compareIds.delete(id);
    }
    updateCompareButton();
  });
  $('compare-btn').addEventListener('click', showCompare);
  $('compare-back-btn').addEventListener('click', () => {
    $('compare-view').hidden = true;
    $('history-list-view').hidden = false;
    renderHistoryList();
  });
  $('history-detail').addEventListener('click', (e) => {
    const exportBtn = e.target.closest('[data-run-export]');
    if (exportBtn) { exportRun(exportBtn.dataset.runExport); return; }
    const replayBtn = e.target.closest('[data-run-replay]');
    if (replayBtn) { replayRun(replayBtn.dataset.runReplay); return; }
    const outputBtn = e.target.closest('[data-run-output]');
    if (outputBtn) { openRunInOutput(outputBtn.dataset.runOutput); return; }
    const refreshBtn = e.target.closest('[data-run-refresh]');
    if (refreshBtn) { loadHistoryDetail(refreshBtn.dataset.runRefresh); }
  });
}
