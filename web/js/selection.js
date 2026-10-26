import { App } from './state.js';
import { apiPost } from './api.js';
import { $, caseTextOf, clone, esc, excerptText, shortId, sourceLanguageOf, stableStringify } from './utils.js';
import { showBanner, toast } from './feedback.js';
import { reloadFromServer } from './persistence.js';
import { caseById, collectionById, markEdit, resolveSelection } from './model.js';
import { updateDirtyUI } from './shell-view.js';
import { refreshRunPlan } from './run-plan.js';
import { setView } from './navigation.js';

function selectionKey(selection) {
  return JSON.stringify({
    v: App.version,
    cases: [...(selection.case_ids || [])],
    collections: [...(selection.collection_ids || [])],
    excluded: [...(selection.excluded_case_ids || [])],
    groups: App.state.draft.groups.map((g) => [g.id, g.enabled, g.runs, g.language_routes]),
    runs: App.state.settings.default_runs
  });
}

function currentAppliedSelection() {
  const draft = App.state.draft;
  return {
    case_ids: [...draft.case_ids],
    collection_ids: [...draft.collection_ids],
    excluded_case_ids: [...draft.excluded_case_ids]
  };
}

function scheduleSelectionPreview(delay = 220) {
  if (App.activeView !== 'cases') return;
  if (App.selectionTimer) window.clearTimeout(App.selectionTimer);
  App.selectionTimer = window.setTimeout(() => {
    App.selectionTimer = null;
    refreshSelectionPreview({ silent: true });
  }, delay);
}

async function refreshSelectionPreview({ selection = null, silent = false } = {}) {
  if (!App.state) return null;
  const sel = selection || currentAppliedSelection();
  const key = selectionKey(sel);
  App.selectionPreviewKey = key;
  App.selectionPreviewStale = true;
  if (!silent) renderSelectionPanel();
  try {
    const data = await apiPost('/api/selection/preview', {
      state_version: App.version,
      case_ids: sel.case_ids,
      collection_ids: sel.collection_ids,
      excluded_case_ids: sel.excluded_case_ids,
      groups: App.state.draft.groups.map(clone)
    });
    if (App.selectionPreviewKey !== key) return null;
    App.selectionPreview = { key, data, forStaging: !!selection };
    App.selectionPreviewStale = false;
    renderSelectionPanel();
    return data;
  } catch (err) {
    if (App.selectionPreviewKey !== key) return null;
    App.selectionPreviewStale = true;
    App.selectionPreview = { key, error: err.message, forStaging: !!selection };
    renderSelectionPanel();
    if (!silent && err.status === 409) {
      showBanner('运行范围预览冲突：服务端状态版本已变化（409）。请重新载入后再操作。', 'error', reloadFromServer);
    }
    return null;
  }
}

function pruneRangeDraft() {
  const st = App.rangeDraft;
  if (!st || !App.state) return false;
  const caseIds = new Set(App.state.cases.map((c) => c.id));
  const collectionIds = new Set(App.state.collections.map((c) => c.id));
  const before = JSON.stringify([st.case_ids, st.collection_ids, st.excluded_case_ids]);
  st.case_ids = st.case_ids.filter((id) => caseIds.has(id));
  st.collection_ids = st.collection_ids.filter((id) => collectionIds.has(id));
  st.excluded_case_ids = st.excluded_case_ids.filter((id) => caseIds.has(id));
  const changed = JSON.stringify([st.case_ids, st.collection_ids, st.excluded_case_ids]) !== before;
  if (changed) {
    st.base = stableStringify({
      case_ids: App.state.draft.case_ids,
      collection_ids: App.state.draft.collection_ids,
      excluded_case_ids: App.state.draft.excluded_case_ids
    });
  }
  return changed;
}

function rangeStaging() {
  if (!App.state) return null;
  const draftSel = {
    case_ids: App.state.draft.case_ids,
    collection_ids: App.state.draft.collection_ids,
    excluded_case_ids: App.state.draft.excluded_case_ids
  };
  const base = stableStringify(draftSel);
  if (!App.rangeDraft || App.rangeDraft.base !== base) {
    App.rangeDraft = {
      base,
      case_ids: [...draftSel.case_ids],
      collection_ids: [...draftSel.collection_ids],
      excluded_case_ids: [...draftSel.excluded_case_ids]
    };
  }
  pruneRangeDraft();
  return App.rangeDraft;
}

function scheduleStagedPreview(delay = 200) {
  if (App.selectionTimer) window.clearTimeout(App.selectionTimer);
  if (App.activeView !== 'cases') return;
  App.selectionTimer = window.setTimeout(() => {
    App.selectionTimer = null;
    if (!App.rangeDraft) return;
    refreshSelectionPreview({ selection: rangeSelection(), silent: true });
  }, delay);
}

function rangeSelection() {
  const st = rangeStaging();
  return st ? {
    case_ids: [...st.case_ids],
    collection_ids: [...st.collection_ids],
    excluded_case_ids: [...st.excluded_case_ids]
  } : {
    case_ids: [],
    collection_ids: [],
    excluded_case_ids: []
  };
}

function rangeDedupInfo(selection) {
  let memberCount = 0;
  const union = new Set();
  for (const cid of selection.collection_ids) {
    const col = collectionById(cid);
    if (!col) continue;
    memberCount += col.case_ids.length;
    for (const id of col.case_ids) union.add(id);
  }
  if (!selection.collection_ids.length) return null;
  return { overlap: Math.max(0, memberCount - union.size), union: union.size };
}

function renderSelectionPanel() {
  const panel = $('range-panel');
  if (!panel) return;
  const pruned = pruneRangeDraft();
  if (pruned) {
    App.selectionPreview = null;
    App.selectionPreviewStale = true;
    App.selectionPreviewKey = '';
  }
  const visible = App.activeView === 'cases';
  panel.hidden = !visible;
  if (!visible || !App.state) return;
  if (pruned) scheduleStagedPreview(0);
  const staging = rangeStaging();
  const selection = rangeSelection();
  const colHost = $('range-collections');
  const selectedCols = staging.collection_ids.map((id) => collectionById(id)).filter(Boolean);
  colHost.innerHTML = selectedCols.length
    ? selectedCols.map((c) => `
      <label class="range-collection-row">
        <input type="checkbox" checked data-range-collection="${esc(c.id)}">
        <span class="collection-name">${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
      </label>`).join('')
    : '<div class="muted small">未选择共享集合。可用“调整集合”选择。</div>';
  const dedup = rangeDedupInfo(selection);
  $('range-dedup').textContent = dedup
    ? `重叠 ${dedup.overlap} 项 · 去重后 ${dedup.union} 项`
    : '未选择集合';

  const explicitHost = $('range-explicit');
  if (explicitHost) {
    explicitHost.innerHTML = staging.case_ids.length
      ? `<div class="range-subhead">单独选择 <span class="muted small">${staging.case_ids.length} 项</span><button type="button" class="link-btn" id="range-explicit-clear">清空</button></div>
         <div class="exclusion-chips">${staging.case_ids.map((id) => `<span class="exclude-chip mono" title="${esc(id)}">${esc(shortId(id))}<button type="button" data-range-explicit-remove="${esc(id)}" aria-label="移除单独选择">×</button></span>`).join('')}</div>`
      : '<div class="muted small">无单独选择的 Case。</div>';
  }

  $('range-exclusion-count').textContent = `${staging.excluded_case_ids.length} 项`;
  const exHost = $('range-exclusions');
  exHost.innerHTML = staging.excluded_case_ids.length
    ? `<div class="exclusion-chips">${staging.excluded_case_ids.map((id) => `<span class="exclude-chip mono" title="${esc(id)}">${esc(shortId(id))}<button type="button" data-range-exclusion-remove="${esc(id)}" aria-label="取消排除">×</button></span>`).join('')}</div>`
    : '<div class="muted small">无临时排除。</div>';

  const preview = App.selectionPreview && App.selectionPreview.key === selectionKey(selection) && !App.selectionPreview.error
    ? App.selectionPreview.data
    : null;
  const resolved = preview ? preview.case_ids : resolveSelection(selection);
  $('range-count').textContent = String(resolved.length);
  const rows = resolved.slice(0, App.rangeShowAll ? resolved.length : 3).map((id) => {
    const c = caseById(id);
    if (!c) return '';
    const excluded = staging.excluded_case_ids.includes(id);
    return `<div class="range-preview-row">
      <span class="mono range-case-id">${esc(shortId(id))}</span>
      <span class="mono range-source">${esc(sourceLanguageOf(c) || '—')}</span>
      <span class="range-text" title="${esc(caseTextOf(c))}">${esc(excerptText(caseTextOf(c), 30) || '（无文本字段）')}</span>
      <button type="button" class="icon-btn tiny-icon" data-range-exclude="${esc(id)}" title="${excluded ? '取消排除' : '本次临时排除'}" ${excluded ? 'disabled' : ''}>
        <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.6 10S5.5 4.9 10 4.9 17.4 10 17.4 10 14.5 15.1 10 15.1 2.6 10 2.6 10z"/><circle cx="10" cy="10" r="2.1"/><path d="M4 16 16 4"/></svg>
      </button>
    </div>`;
  }).join('');
  $('range-preview').innerHTML = rows || '<div class="muted small">本次范围没有 Case。</div>';
  $('range-viewall').textContent = App.rangeShowAll ? '收起' : '查看全部';
  $('range-viewall').disabled = resolved.length <= 3;

  const enabledGroups = App.state.draft.groups.filter((g) => g.enabled);
  const runs = enabledGroups.map((g) => Number(g.runs) || 0);
  const requestCount = preview ? preview.request_count : resolved.length * runs.reduce((a, b) => a + b, 0);
  $('range-formula').textContent = runs.length ? `共 ${requestCount} 次请求` : '没有启用配置';
  $('range-error').textContent = App.selectionPreview && App.selectionPreview.key === selectionKey(selection) && App.selectionPreview.error
    ? `范围预览失败：${App.selectionPreview.error}`
    : '';
  $('range-apply').disabled = App.mutating;
  const stale = App.selectionPreviewStale || !preview;
  $('range-dedup').classList.toggle('stale', stale);
}

function rangeApply() {
  const staging = rangeStaging();
  if (!staging || App.mutating) return;
  App.state.draft.case_ids = [...staging.case_ids];
  App.state.draft.collection_ids = [...staging.collection_ids];
  App.state.draft.excluded_case_ids = [...staging.excluded_case_ids];
  App.rangeDraft = null;
  markEdit();
  updateDirtyUI();
  refreshRunPlan();
  scheduleSelectionPreview(0);
  setView('workbench');
  toast('运行数据已更新，尚未启动运行', 'ok', 2500);
}

function openRangeCollectionsDialog() {
  const staging = rangeStaging();
  if (!staging) return;
  $('range-collections-list').innerHTML = App.state.collections.length
    ? App.state.collections.map((c) => `
      <label class="join-row">
        <input type="checkbox" data-range-collection-pick="${esc(c.id)}" ${staging.collection_ids.includes(c.id) ? 'checked' : ''}>
        <span>${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
      </label>`).join('')
    : '<div class="empty-state">尚无共享集合。可在 Case 库新建。</div>';
  $('range-collections-summary').textContent = '应用集合范围会清除“单独选择”的 Case；临时排除保留。';
  $('range-collections-dialog').showModal();
}

function applyRangeCollections() {
  const staging = rangeStaging();
  if (!staging) return;
  const ids = [...document.querySelectorAll('[data-range-collection-pick]:checked')].map((el) => el.dataset.rangeCollectionPick);
  staging.collection_ids = ids;
  staging.case_ids = [];
  const caseSet = new Set(resolveSelection({ case_ids: [], collection_ids: ids, excluded_case_ids: [] }));
  staging.excluded_case_ids = staging.excluded_case_ids.filter((id) => caseSet.has(id));
  App.rangeDraft = { ...staging };
  $('range-collections-dialog').close();
  renderSelectionPanel();
  scheduleStagedPreview(0);
}

export function bindSelectionEvents() {
  $('range-collections-btn').addEventListener('click', openRangeCollectionsDialog);
  $('range-collections-apply').addEventListener('click', applyRangeCollections);
  $('range-collections').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-range-collection]');
    const staging = rangeStaging();
    if (!cb || !staging) return;
    if (!cb.checked) {
      staging.collection_ids = staging.collection_ids.filter((id) => id !== cb.dataset.rangeCollection);
      renderSelectionPanel();
      scheduleStagedPreview(0);
    }
  });
  $('range-exclusions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range-exclusion-remove]');
    const staging = rangeStaging();
    if (!btn || !staging) return;
    staging.excluded_case_ids = staging.excluded_case_ids.filter((id) => id !== btn.dataset.rangeExclusionRemove);
    renderSelectionPanel();
    scheduleStagedPreview(0);
  });
  $('range-explicit').addEventListener('click', (e) => {
    const staging = rangeStaging();
    if (!staging) return;
    const remove = e.target.closest('[data-range-explicit-remove]');
    if (remove) {
      staging.case_ids = staging.case_ids.filter((id) => id !== remove.dataset.rangeExplicitRemove);
      renderSelectionPanel();
      scheduleStagedPreview(0);
      return;
    }
    if (e.target.closest('#range-explicit-clear')) {
      staging.case_ids = [];
      renderSelectionPanel();
      scheduleStagedPreview(0);
    }
  });
  $('range-preview').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range-exclude]');
    const staging = rangeStaging();
    if (!btn || !staging) return;
    const id = btn.dataset.rangeExclude;
    if (!staging.excluded_case_ids.includes(id)) {
      staging.excluded_case_ids.push(id);
      renderSelectionPanel();
      markEdit();
      scheduleStagedPreview(0);
    }
  });
  $('range-viewall').addEventListener('click', () => {
    App.rangeShowAll = !App.rangeShowAll;
    renderSelectionPanel();
  });
  $('range-apply').addEventListener('click', rangeApply);
}

export { refreshSelectionPreview, renderSelectionPanel, scheduleSelectionPreview, scheduleStagedPreview };
