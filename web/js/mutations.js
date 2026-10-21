import { caseById, ensureSelections, groupById, hasPendingCredentials, hasUnsavedWork, isDirty, normalizeCredentials, normalizeState } from './model.js';
import { clone, stableStringify } from './utils.js';
import { App } from './state.js';
import { showBanner, toast } from './feedback.js';
import { ensureSaved, reloadFromServer } from './persistence.js';
import { updateDirtyUI } from './shell-view.js';
import { refreshRunPlan } from './run-plan.js';
import { apiRaw } from './api.js';

function applyMutationResult(view, payload, gen, onSuccess) {
  if (!view) return;
  const serverState = normalizeState(clone(view));
  // Decide against the pre-response baseline; updating savedJson first would make
  // every clean mutation look like a concurrent edit.
  const canAdopt = gen === App.editGeneration && !App.saving && !hasPendingCredentials() && !isDirty();
  App.version = serverState.version;
  if (payload && payload.credentials) App.credentials = normalizeCredentials(payload.credentials);
  App.savedAt = new Date();
  App.savedJson = stableStringify(serverState);
  if (canAdopt) {
    const keepActiveCase = App.activeCaseId;
    const keepActiveGroup = App.activeGroupId;
    App.state = serverState;
    ensureSelections();
    if (caseById(keepActiveCase)) App.activeCaseId = keepActiveCase;
    if (groupById(keepActiveGroup)) App.activeGroupId = keepActiveGroup;
  } else {
    // Preserve unrelated unsaved template/provider/group edits while adopting
    // the authoritative Case/collection resources returned by the server.
    App.state.cases = clone(serverState.cases);
    App.state.collections = clone(serverState.collections);
    App.state.version = App.version;
    const caseIds = new Set(App.state.cases.map((c) => c.id));
    const collectionIds = new Set(App.state.collections.map((c) => c.id));
    App.state.draft.case_ids = App.state.draft.case_ids.filter((id) => caseIds.has(id));
    App.state.draft.excluded_case_ids = App.state.draft.excluded_case_ids.filter((id) => caseIds.has(id));
    App.state.draft.collection_ids = App.state.draft.collection_ids.filter((id) => collectionIds.has(id));
    if (!caseById(App.activeCaseId)) App.activeCaseId = App.state.cases[0]?.id || null;
    if (!groupById(App.activeGroupId)) App.activeGroupId = App.state.draft.groups[0]?.id || null;
    showBanner('Case 数据已按服务端结果更新；保存期间的其他未保存编辑已保留，确认后可再次保存。', 'warn');
  }
  onSuccess(serverState, payload);
  renderMutatedState();
}

async function stateMutation(path, method, body, { onSuccess, errorLabel = '写入失败' } = {}) {
  if (App.mutating) {
    toast('另一个写入正在进行，请稍候。', 'info', 1800);
    return null;
  }
  if (hasUnsavedWork()) {
    const ok = await ensureSaved();
    if (!ok) return null;
  }
  const gen = App.editGeneration;
  App.mutating = true;
  document.body.classList.add('mutating');
  updateDirtyUI();
  refreshRunPlan();
  try {
    const { payload } = await apiRaw(path, { method, body: { ...body, state_version: App.version } });
    const view = payload && payload.state ? payload.state : payload;
    applyMutationResult(view, payload, gen, (serverState) => {
      onSuccess(serverState, payload);
    });
    return payload;
  } catch (err) {
    if (err.status === 409) {
      showBanner(`${errorLabel}：服务端状态版本已变化（409）。请重新载入后重试；未覆盖服务端。`, 'error', reloadFromServer);
      toast(`${errorLabel}：版本冲突`, 'error');
    } else {
      showBanner(`${errorLabel}：${err.message}`, 'error');
      toast(`${errorLabel}：${err.message}`, 'error');
    }
    return null;
  } finally {
    App.mutating = false;
    document.body.classList.remove('mutating');
    renderMutationEditors();
    updateDirtyUI();
    refreshRunPlan();
  }
}
let renderMutatedState, renderMutationEditors;
export function configureMutations(hooks) {
  ({ renderMutatedState, renderMutationEditors } = hooks);
}

export { applyMutationResult, stateMutation };
