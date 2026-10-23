import { caseEditorDirty, ensureSelections, groupEditorDirty, hasUnsavedWork, markEdit, metricEditorDirty } from './model.js';
import { renderShell, updateDirtyUI } from './shell-view.js';
import { bindLibraryEvents, renderCollectionNav, renderLibrary } from './case-library.js';
import { bindTemplateEvents, renderTemplateEditor, renderTemplateOptions } from './templates.js';
import { renderGroupCards, renderModelSuggestions } from './workbench-view.js';
import { bindProviderEvents, loadProtocols, renderProviders } from './providers.js';
import { bindSettingsEvents, renderSettings } from './settings.js';
import { renderHistoryList } from './history-view.js';
import { bindOutputEvents, renderOutput } from './output.js';
import { bindSelectionEvents, renderSelectionPanel, scheduleSelectionPreview, scheduleStagedPreview } from './selection.js';
import { bindCaseEditorEvents, renderCaseEditor } from './case-editor.js';
import { bindIOEvents, renderIO } from './case-io.js';
import { bindGroupEvents, renderGroupEditor } from './groups.js';
import { refreshRunPlan } from './run-plan.js';
import { App } from './state.js';
import { configurePersistence, loadState, saveState } from './persistence.js';
import { hideBanner, setConnection, showBanner, toast } from './feedback.js';
import { bindRunEvents, refreshRuns, resumeActiveRun, startRun } from './runs.js';
import { configureNavigation, setView } from './navigation.js';
import { $ } from './utils.js';
import { bindHistoryEvents } from './history.js';
import { configureMutations } from './mutations.js';
import { bindMetricEvents, renderMetricSelection, renderMetricsView } from './metrics.js';
import { bindContractEvents, contractEditorDirty } from './contracts.js';
import { bindEvaluationEvents, refreshEvaluations } from './evaluations.js';

function renderAll() {
  ensureSelections();
  renderShell();
  renderCollectionNav();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderModelSuggestions();
  renderProviders();
  renderSettings();
  renderHistoryList();
  renderOutput();
  renderSelectionPanel();
  renderMetricSelection();
  renderMetricsView();
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
    await refreshEvaluations({ quiet: true });
    await resumeActiveRun();
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
    refreshEvaluations({ quiet: true });
    if (!App.runsLoaded) refreshRuns();
  } else if (view === 'metrics') {
    renderMetricsView();
  } else if (view === 'providers') {
    renderProviders();
  } else if (view === 'settings') {
    renderSettings();
  }
  renderSelectionPanel();
  if (view === 'cases') scheduleStagedPreview(0);
}

function renderSavedState() {
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderSettings();
  renderMetricSelection();
  renderMetricsView();
}

function renderCredentialState() {
  renderProviders();
  renderSelectionPanel();
  renderMetricSelection();
  renderMetricsView();
}

async function renderReloadedState() {
  renderAll();
  await refreshRuns({ quiet: true });
}

function renderMutatedState() {
  renderCollectionNav();
  renderGroupCards();
  renderLibrary();
  if (App.activeView === 'case-io') renderIO();
  if (App.activeView === 'group-editor') renderGroupEditor();
  renderSelectionPanel();
  renderMetricSelection();
  renderMetricsView();
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
  const sidebarToggle = $('sidebar-toggle');
  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.title = collapsed ? '展开侧栏' : '收起侧栏';
    sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
  }
  try { setSidebarCollapsed(localStorage.getItem('sidebar-collapsed') === 'true'); } catch {}
  sidebarToggle.addEventListener('click', () => {
    document.body.classList.add('sidebar-motion');
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem('sidebar-collapsed', String(collapsed)); } catch {}
  });

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('save-btn').addEventListener('click', () => saveState());
  $('run-btn').addEventListener('click', startRun);
  $('workbench-cases-btn').addEventListener('click', () => {
    setView('cases');
    $('range-panel').scrollIntoView({ block: 'start' });
  });
  $('draft-name').addEventListener('input', (e) => {
    App.state.draft.name = e.target.value;
    renderShell();
    refreshRunPlan();
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
    const editorDirty = caseEditorDirty() || groupEditorDirty() || metricEditorDirty() || contractEditorDirty();
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
  bindRunEvents();
  bindMetricEvents();
  bindContractEvents();
  bindEvaluationEvents();
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
