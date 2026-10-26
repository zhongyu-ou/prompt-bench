import { App } from './state.js';
import { activeGroup, activeTemplate, caseEditorDirty, groupEditorDirty, hasUnsavedWork, selectedCaseIds } from './model.js';
import { ensureSaved, reloadFromServer } from './persistence.js';
import { apiPost } from './api.js';
import { $, clone, stableStringify } from './utils.js';
import { showBanner } from './feedback.js';

// Saving adopts a new state version. Keep the explicit action separate from the
// response token so that adoption can invalidate old responses without cancelling
// the save-and-preview action itself.
let actionGeneration = 0;
let renderedMessage;

function previewContext() {
  const preview = App.templatePreview;
  const template = activeTemplate();
  const selection = selectedCaseIds();
  const caseId = selection[0] || null;
  const groups = template ? (App.state?.draft.groups || []).filter((group) => group.template_id === template.id) : [];
  const active = activeGroup();
  const group = groups.find((candidate) => candidate.id === active?.id)
    || groups.find((candidate) => candidate.enabled)
    || groups[0]
    || null;
  const caseDirty = !!caseId && App.caseEditor?.sourceId === caseId && caseEditorDirty();
  const groupDirty = !!group && App.groupEditor?.id === group.id && groupEditorDirty();
  const unsaved = hasUnsavedWork();
  const intent = stableStringify({
    view: App.activeView,
    mode: preview.mode,
    editGeneration: App.editGeneration,
    templateId: template?.id || null,
    messages: template?.messages || [],
    selection,
    group,
    caseDirty,
    groupDirty
  });
  const key = stableStringify({ version: App.version, intent, unsaved });
  return { template, caseId, group, caseDirty, groupDirty, unsaved, intent, key };
}

function previewBlocked(context) {
  if (!context.template) return '请先创建并保存模板';
  if (!context.caseId) return '请先在 Case 库选择运行数据';
  if (!context.group) return '请先添加使用此模板的对照配置';
  if (context.caseDirty) return '请先保存 Case';
  if (context.groupDirty) return '请先保存对照配置';
  return '';
}

export function renderTemplatePreview() {
  const preview = App.templatePreview;
  const panel = $('template-preview-panel');
  if (!panel || !preview) return;
  const context = previewContext();
  if (preview.key !== context.key) {
    preview.generation += 1;
    preview.key = context.key;
    preview.data = null;
    preview.error = '';
    preview.busy = false;
  }

  const showingPreview = preview.mode === 'preview';
  $('template-mode-edit').setAttribute('aria-pressed', String(!showingPreview));
  $('template-mode-preview').setAttribute('aria-pressed', String(showingPreview));
  $('template-mode-preview').disabled = preview.busy;
  $('template-message-body').classList.toggle('showing-preview', showingPreview);
  $('template-edit-panel').inert = showingPreview;
  panel.hidden = !showingPreview;

  const blocked = previewBlocked(context);
  const writing = App.saving || App.mutating || App.loading;
  const status = $('template-preview-status');
  status.textContent = blocked
    || (App.saving ? '正在保存更改…' : App.mutating || App.loading ? '正在同步数据，请稍后…' : '')
    || (preview.busy ? '正在生成请求预览…' : '')
    || (preview.error ? `请求预览失败：${preview.error}` : '')
    || (context.unsaved ? '模板或配置有未保存更改，请保存后预览。' : '')
    || (preview.data ? '' : '预览已过期');
  status.classList.toggle('error-text', !!preview.error && !blocked);
  status.hidden = !status.textContent;

  const run = $('template-preview-run');
  run.hidden = !context.unsaved || !!blocked || writing || preview.busy;
  run.disabled = !showingPreview || !!blocked || writing || preview.busy;

  const message = preview.data?.request?.messages?.[App.activeMessageIndex];
  if (renderedMessage !== message) {
    renderedMessage = message;
    $('template-preview-messages').textContent = message?.content || '';
  }
}

async function requestPreview({ save = false } = {}) {
  renderTemplatePreview();
  const preview = App.templatePreview;
  let context = previewContext();
  if (preview.mode !== 'preview' || preview.busy || App.saving || App.mutating || App.loading || previewBlocked(context)) return;
  const action = ++actionGeneration;
  if (context.unsaved) {
    if (!save) return;
    const intent = context.intent;
    preview.busy = true;
    preview.data = null;
    preview.error = '';
    renderTemplatePreview();
    const saved = await ensureSaved();
    if (action !== actionGeneration) return;
    preview.busy = false;
    context = previewContext();
    if (!saved || preview.mode !== 'preview' || context.intent !== intent || context.unsaved || previewBlocked(context)) {
      renderTemplatePreview();
      return;
    }
    renderTemplatePreview();
  }

  context = previewContext();
  const generation = ++preview.generation;
  const key = context.key;
  preview.key = key;
  preview.data = null;
  preview.error = '';
  preview.busy = true;
  renderTemplatePreview();
  const stillCurrent = () => preview.mode === 'preview' && preview.generation === generation && preview.key === key;
  try {
    const data = await apiPost('/api/preview', {
      state_version: App.version,
      case_id: context.caseId,
      group: clone(context.group)
    });
    renderTemplatePreview();
    if (!stillCurrent()) return;
    preview.data = data;
  } catch (err) {
    renderTemplatePreview();
    if (!stillCurrent()) return;
    preview.error = err.message;
    if (err.status === 409) {
      showBanner('请求预览冲突：服务端状态版本已变化（409）。请重新载入后再操作。', 'error', reloadFromServer);
    }
  } finally {
    if (stillCurrent()) preview.busy = false;
    renderTemplatePreview();
  }
}

export function bindTemplatePreviewEvents() {
  $('template-mode-edit').addEventListener('click', () => {
    actionGeneration += 1;
    App.templatePreview.mode = 'edit';
    renderTemplatePreview();
  });
  $('template-mode-preview').addEventListener('click', () => {
    if (App.templatePreview.busy || App.saving || App.mutating || App.loading) return;
    actionGeneration += 1;
    App.templatePreview.mode = 'preview';
    renderTemplatePreview();
    void requestPreview();
  });
  $('template-preview-run').addEventListener('click', () => { void requestPreview({ save: true }); });
  // Bubble after editor handlers and the global capture-phase markEdit hook.
  // These listeners only invalidate local display; requests stay event-explicit.
  document.addEventListener('input', renderTemplatePreview);
  document.addEventListener('change', renderTemplatePreview);
}
