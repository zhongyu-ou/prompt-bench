import { App } from './state.js';
import { updateDirtyUI } from './shell-view.js';
import { apiRaw } from './api.js';
import { caseById, ensureSelections, groupById, hasPendingCredentials, hasUnsavedWork, isDirty, normalizeCredentials, normalizeState, selectedCaseIds } from './model.js';
import { clone, sameValue, stableStringify } from './utils.js';
import { clearEditorRenderError, hideBanner, showBanner, showEditorRenderError, toast } from './feedback.js';
import { refreshRunPlan } from './run-plan.js';

async function loadState() {
  App.loading = true;
  updateDirtyUI();
  try {
    const { payload } = await apiRaw('/api/state');
    const credentials = payload && typeof payload === 'object' ? payload.credentials : null;
    App.credentials = normalizeCredentials(credentials);
    if (payload && typeof payload === 'object') delete payload.credentials;
    App.state = normalizeState(payload);
    App.version = App.state.version;
    App.savedJson = stableStringify(App.state);
    App.savedAt = new Date();
    App.selectionPreview = null;
    App.selectionPreviewStale = true;
    ensureSelections();
    const resolved = selectedCaseIds();
    if (resolved.length && !resolved.includes(App.activeCaseId)) App.activeCaseId = resolved[0];
  } finally {
    App.loading = false;
    updateDirtyUI();
  }
}

function editableStateSnapshot() {
  return {
    templates: clone(App.state.templates),
    providers: clone(App.state.providers),
    metrics: clone(App.state.metrics),
    settings: clone(App.state.settings),
    draft: clone(App.state.draft)
  };
}

async function saveState({ silent = false } = {}) {
  if (!App.state) return false;
  if (App.saving || App.mutating) return false;
  if (App.settingsError.length) {
    showBanner(`设置存在错误，未保存：${App.settingsError[0]}`, 'error');
    return false;
  }
  if (!isDirty() && !hasPendingCredentials()) {
    if (!silent) toast('没有需要保存的更改', 'info', 1800);
    return true;
  }
  App.saving = true;
  const gen = App.editGeneration;
  updateDirtyUI();
  refreshRunPlan();
  const editable = editableStateSnapshot();
  const submittedMutations = new Map();
  for (const [id, mutation] of App.credentialMutations) submittedMutations.set(id, { ...mutation });
  const credentialUpdates = {};
  for (const [id, mutation] of submittedMutations) {
    if (mutation.kind === 'set') {
      if (editable.providers.some((p) => p.id === id)) credentialUpdates[id] = { action: 'set', key: mutation.value };
    } else if (mutation.kind === 'clear') {
      credentialUpdates[id] = { action: 'clear' };
    }
  }
  // Generic PUT is narrow on purpose: cases/collections are authoritative through dedicated
  // endpoints, so browser number normalization can never rewrite imported Case input.
  const body = {
    version: App.version,
    templates: editable.templates,
    providers: editable.providers,
    metrics: editable.metrics,
    settings: editable.settings,
    draft: editable.draft
  };
  if (Object.keys(credentialUpdates).length) body.credential_updates = credentialUpdates;
  try {
    const { payload } = await apiRaw('/api/state', { method: 'PUT', body });
    const serverState = normalizeState(clone(payload));
    const serverJson = stableStringify(serverState);
    App.version = serverState.version;
    App.credentials = normalizeCredentials(payload.credentials);
    App.savedAt = new Date();
    App.savedJson = serverJson;
    if (gen === App.editGeneration) {
      const keepActiveCase = App.activeCaseId;
      const keepActiveGroup = App.activeGroupId;
      App.state = serverState;
      ensureSelections();
      if (caseById(keepActiveCase)) App.activeCaseId = keepActiveCase;
      if (groupById(keepActiveGroup)) App.activeGroupId = keepActiveGroup;
      renderSavedState();
    } else {
      App.state.version = App.version;
      showBanner('保存期间有新编辑：服务端已保存提交时的版本，当前页面内容未被覆盖。确认后可再次保存。', 'warn');
    }
    for (const [id, mutation] of submittedMutations) {
      const current = App.credentialMutations.get(id);
      if (current && sameValue(current, mutation)) App.credentialMutations.delete(id);
    }
    hideBanner();
    clearEditorRenderError();
    if (!silent) {
      toast(submittedMutations.size
        ? '更改与手动凭据已保存。'
        : '更改已保存。', 'ok');
    }
    refreshSelectionAfterSave();
    return true;
  } catch (err) {
    if (err.status === 409) {
      showBanner('保存冲突：服务端状态已被其他窗口或会话修改。当前草稿未覆盖服务端；请重新载入后合并更改。', 'error', reloadFromServer);
      toast('保存失败：版本冲突（409）', 'error');
    } else {
      showBanner(`保存失败：${err.message}`, 'error');
      if (/template|render|parse|模板|消息|message/i.test(err.message)) {
        showEditorRenderError(`保存失败（模板校验）：${err.message}`);
      }
      toast(`保存失败：${err.message}`, 'error');
    }
    return false;
  } finally {
    App.saving = false;
    renderCredentialState();
    updateDirtyUI();
    refreshRunPlan();
  }
}

async function ensureSaved() {
  if (!App.state) return false;
  if (!isDirty() && !hasPendingCredentials()) return true;
  const ok = await saveState({ silent: true });
  if (!ok) return false;
  if (isDirty() || hasPendingCredentials()) {
    showBanner('保存期间草稿又被编辑，本次操作未执行。请确认当前内容后再次点击。', 'warn');
    toast('保存期间有新的编辑，已取消本次操作', 'error', 5000);
    refreshRunPlan();
    return false;
  }
  return true;
}

async function reloadFromServer() {
  if (hasUnsavedWork() && !window.confirm('重新载入会丢弃本地未保存更改（包括编辑器内容、待保存的手动密钥）。继续？')) return false;
  App.credentialMutations.clear();
  try {
    await loadState();
    App.caseEditor = null;
    App.groupEditor = null;
    App.metricEditor = null;
    App.metricTrial = { targetMode: 'output', pointer: '', input: '', result: null, error: '' };
    App.io.preview = null;
    hideBanner();
    await renderReloadedState();
    toast('已重新载入服务端状态', 'ok');
    return true;
  } catch (err) {
    showBanner(`重新载入失败：${err.message}`, 'error', reloadFromServer);
    return false;
  }
}
let renderSavedState, renderCredentialState, refreshSelectionAfterSave, renderReloadedState;
export function configurePersistence(hooks) {
  ({ renderSavedState, renderCredentialState, refreshSelectionAfterSave, renderReloadedState } = hooks);
}

export { ensureSaved, loadState, reloadFromServer, saveState };
