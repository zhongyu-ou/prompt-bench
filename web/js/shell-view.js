import { App } from './state.js';
import { collectionById, groupById, hasUnsavedWork, selectedCaseIds } from './model.js';
import { $, fmtClock } from './utils.js';

function viewCrumb() {
  const base = App.state ? (App.state.draft.name || 'ASR 多目标翻译') : 'ASR 多目标翻译';
  switch (App.activeView) {
    case 'cases': {
      const col = App.library.collectionId ? collectionById(App.library.collectionId) : null;
      return `${base} / Case 库 · ${col ? col.name : '全部 Case'}`;
    }
    case 'case-editor': return `${base} / Case 库 / 编辑`;
    case 'case-io': return `${base} / Case 导入与导出`;
    case 'group-editor': {
      const id = App.groupEditor ? App.groupEditor.id : App.activeGroupId;
      const g = id ? groupById(id) : null;
      return `${base} / 工作台 / ${g ? (g.name || '配置') : '新配置'}`;
    }
    case 'history': return `${base} / 运行记录`;
    case 'metrics': return `${base} / 指标`;
    case 'providers': return `${base} / Providers`;
    case 'settings': return `${base} / 全局设置`;
    default: return `${base} / 工作台`;
  }
}

function renderShell() {
  if (!App.state) return;
  const draft = App.state.draft;
  $('crumb').textContent = viewCrumb();
  $('state-version').textContent = `v${App.version}`;
  $('state-version').title = `服务端状态版本 ${App.version}`;
  const nameInput = $('draft-name');
  if (nameInput && document.activeElement !== nameInput && nameInput.value !== draft.name) nameInput.value = draft.name;
  const scope = $('workbench-scope-summary');
  if (scope) {
    const names = draft.collection_ids.map((id) => collectionById(id)?.name).filter(Boolean);
    scope.textContent = `${selectedCaseIds().length} 个 Case${names.length ? ` · ${names.join('、')}` : ''}${draft.excluded_case_ids.length ? ` · 已排除 ${draft.excluded_case_ids.length} 项` : ''}`;
  }
  document.title = `${hasUnsavedWork() ? '● ' : ''}Promptbench · ${draft.name || 'Prompt 调试'}`;
}

function updateDirtyUI() {
  renderShell();
  const el = $('save-state');
  if (!el) return;
  const dirty = hasUnsavedWork();
  el.classList.remove('dirty', 'error');
  if (!App.connOnline && App.state === null) {
    el.textContent = '未连接';
    el.classList.add('error');
  } else if (App.saving) {
    el.textContent = '保存中…';
  } else if (App.mutating) {
    el.textContent = '正在写入…';
  } else if (dirty) {
    el.textContent = '有未保存更改';
    el.classList.add('dirty');
  } else {
    el.textContent = App.savedAt ? `已保存 ${fmtClock(App.savedAt)}` : '已保存';
  }
  const saveBtn = $('save-btn');
  if (saveBtn) saveBtn.disabled = !dirty || App.saving || App.mutating || App.loading;
  if (App.state) {
    document.title = `${dirty ? '● ' : ''}Promptbench · ${App.state.draft.name || 'Prompt 调试'}`;
  }
}

export { renderShell, updateDirtyUI };
