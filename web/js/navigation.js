import { App } from './state.js';
import { caseEditorDirty, groupEditorDirty } from './model.js';

function setView(view, { force = false } = {}) {
  if (!['workbench', 'cases', 'case-editor', 'case-io', 'group-editor', 'history', 'providers', 'settings'].includes(view)) return;
  if (App.mutating && !force) return;
  if (view === App.activeView) return;
  if (!force && App.activeView === 'case-editor' && view !== 'case-editor' && caseEditorDirty()) {
    if (!window.confirm('Case 编辑器中还有未保存的更改。放弃并离开？')) return;
    App.caseEditor = null;
  }
  if (!force && App.activeView === 'group-editor' && view !== 'group-editor' && groupEditorDirty()) {
    if (!window.confirm('对照配置编辑器中还有未保存的更改。放弃并离开？')) return;
    App.groupEditor = null;
  }
  App.activeView = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${view}`;
  });
  const navView = view === 'case-editor' || view === 'case-io' ? 'cases' : (view === 'group-editor' ? 'workbench' : view);
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === navView;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  afterViewChange(view);
}
let afterViewChange;
export function configureNavigation(renderView) {
  afterViewChange = renderView;
}

export { setView };
