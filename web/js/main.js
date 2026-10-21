import { caseEditorDirty, ensureSelections, groupEditorDirty, hasUnsavedWork, markEdit } from './model.js';
import { renderShell, updateDirtyUI } from './shell-view.js';
import { bindLibraryEvents, renderCollectionNav, renderLibrary } from './case-library.js';
import { bindTemplateEvents, renderTemplateEditor, renderTemplateOptions } from './templates.js';
import { renderGroupCards, renderModelSuggestions, renderWorkbenchCase } from './workbench-view.js';
import { bindProviderEvents, loadProtocols, renderProviders } from './providers.js';
import { bindSettingsEvents, renderSettings } from './settings.js';
import { renderHistoryList } from './history-view.js';
import { bindOutputEvents, renderOutput } from './output.js';
import { markPreviewStale, renderPreviewState } from './preview-state.js';
import { bindSelectionEvents, refreshSelectionPreview, renderSelectionPanel, scheduleSelectionPreview, scheduleStagedPreview } from './selection.js';
import { bindCaseEditorEvents, renderCaseEditor } from './case-editor.js';
import { bindIOEvents, renderIO } from './case-io.js';
import { bindGroupEvents, renderGroupEditor } from './groups.js';
import { refreshRunPlan } from './run-plan.js';
import { App } from './state.js';
import { configurePersistence, loadState, saveState } from './persistence.js';
import { hideBanner, setConnection, showBanner, toast } from './feedback.js';
import { bindRunEvents, refreshRuns, resumeActiveRun, startRun } from './runs.js';
import { bindPreviewEvents, refreshPreview } from './preview.js';
import { configureNavigation, setView } from './navigation.js';
import { $ } from './utils.js';
import { bindHistoryEvents } from './history.js';
import { configureMutations } from './mutations.js';

function renderAll() {
  ensureSelections();
  renderShell();
  renderCollectionNav();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderWorkbenchCase();
  renderModelSuggestions();
  renderProviders();
  renderSettings();
  renderHistoryList();
  renderOutput();
  renderPreviewState();
  renderSelectionPanel();
  renderLibrary();
  renderCaseEditor();
  renderIO();
  renderGroupEditor();
  updateDirtyUI();
  refreshRunPlan();
  scheduleSelectionPreview(0);
}

async function bootstrap() {
  App.loading = true;
  updateDirtyUI();
  try {
    await loadProtocols();
    await loadState();
    setConnection(true);
    renderAll();
    await refreshRuns({ quiet: true });
    await resumeActiveRun();
    refreshPreview({ silent: true });
    refreshSelectionPreview({ silent: true });
    hideBanner();
  } catch (err) {
    setConnection(false);
    showBanner(`初始化失败：${err.message}`, 'error', bootstrap, '重试连接');
    toast(`初始化失败：${err.message}`, 'error', 6000);
  } finally {
    App.loading = false;
    updateDirtyUI();
    refreshRunPlan();
  }
}

async function init() {
  bindStaticEvents();
  setView('workbench', { force: true });
  await bootstrap();
}

function renderView(view) {
  renderCollectionNav();
  renderShell();
  if (view === 'workbench') {
    renderTemplateOptions();
    renderTemplateEditor();
    renderGroupCards();
    renderWorkbenchCase();
    refreshRunPlan();
  } else if (view === 'cases') {
    renderLibrary();
  } else if (view === 'case-editor') {
    renderCaseEditor();
  } else if (view === 'case-io') {
    renderIO();
  } else if (view === 'group-editor') {
    renderGroupEditor();
  } else if (view === 'history') {
    renderHistoryList();
    if (!App.runsLoaded) refreshRuns();
  } else if (view === 'providers') {
    renderProviders();
  } else if (view === 'settings') {
    renderSettings();
  }
  renderSelectionPanel();
  if (view === 'workbench' && App.rangeDraft) scheduleStagedPreview(0);
}

function renderSavedState() {
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderSettings();
  renderWorkbenchCase();
}

function renderCredentialState() {
  renderProviders();
  renderSelectionPanel();
}

async function renderReloadedState() {
  renderAll();
  renderPreviewState();
  await refreshRuns({ quiet: true });
  refreshPreview({ silent: true });
}

function renderMutatedState() {
  renderCollectionNav();
  renderGroupCards();
  renderWorkbenchCase();
  renderLibrary();
  if (App.activeView === 'case-io') renderIO();
  if (App.activeView === 'group-editor') renderGroupEditor();
  renderSelectionPanel();
  updateDirtyUI();
  refreshRunPlan();
  scheduleSelectionPreview(0);
  renderProviders();
  renderSettings();
}

function renderMutationEditors() {
  if (App.caseEditor) renderCaseEditor();
  if (App.activeView === 'case-io') renderIO();
}

function bindStaticEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('save-btn').addEventListener('click', () => saveState());
  $('run-btn').addEventListener('click', startRun);
  $('draft-name').addEventListener('input', (e) => {
    App.state.draft.name = e.target.value;
    renderShell();
    updateDirtyUI();
    markPreviewStale('草稿名称已修改');
  });
  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dlg = $(btn.dataset.closeDialog);
      if (dlg) dlg.close();
    });
  });
  document.querySelectorAll('dialog.modal').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  });
  $('banner-close-btn').addEventListener('click', hideBanner);
  $('banner-reload-btn').addEventListener('click', () => {
    if (typeof App.bannerAction === 'function') App.bannerAction();
  });

  document.addEventListener('click', (e) => {
    const details = $('insert-var-menu');
    if (details && details.open && !details.contains(e.target)) details.open = false;
  });

  document.addEventListener('input', () => markEdit(), true);
  document.addEventListener('change', () => markEdit(), true);

  window.addEventListener('beforeunload', (e) => {
    const editorDirty = caseEditorDirty() || groupEditorDirty();
    if (hasUnsavedWork() || editorDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const menu = $('insert-var-menu');
      if (menu && menu.open) menu.open = false;
    }
  });
  bindTemplateEvents();
  bindGroupEvents();
  bindOutputEvents();
  bindHistoryEvents();
  bindProviderEvents();
  bindSettingsEvents();
  bindSelectionEvents();
  bindLibraryEvents();
  bindCaseEditorEvents();
  bindIOEvents();
  bindPreviewEvents();
  bindRunEvents();
}

configureNavigation(renderView);
configurePersistence({
  renderSavedState, renderCredentialState,
  refreshSelectionAfterSave: () => scheduleSelectionPreview(0), renderReloadedState
});
configureMutations({ renderMutatedState, renderMutationEditors });

if (document.readyState === 'complete') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
