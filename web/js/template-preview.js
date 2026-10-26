import { App } from './state.js';
import { activeGroup, activeTemplate, caseEditorDirty, groupEditorDirty, hasUnsavedWork, selectedCaseIds } from './model.js';
import { ensureSaved, reloadFromServer } from './persistence.js';
import { apiPost } from './api.js';
import { previewCodeHtml } from './json-preview.js';
import { $, clone, esc, stableStringify } from './utils.js';
import { showBanner, toast } from './feedback.js';

// Saving adopts a new state version. Keep the explicit action separate from the
// response token so that adoption can invalidate old responses without cancelling
// the save-and-preview action itself.
let actionGeneration = 0;
let renderedData;

function previewContext() {
  const preview = App.templatePreview;
  const template = activeTemplate();
  const selection = selectedCaseIds();
  const caseId = selection[0] || null;
  const groups = template ? (App.state?.draft.groups || []).filter((group) => group.template_id === template.id) : [];
  const active = activeGroup();
  const group = groups.find((candidate) => candidate.id === preview.groupId)
    || groups.find((candidate) => candidate.id === active?.id)
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
  return { template, selection, caseId, groups, group, caseDirty, groupDirty, unsaved, intent, key };
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
  preview.groupId = context.group?.id || null;
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
  $('template-edit-panel').hidden = showingPreview;
  panel.hidden = !showingPreview;
  const insertMenu = $('insert-var-menu');
  if (insertMenu) {
    insertMenu.hidden = showingPreview || !context.template;
    if (showingPreview) insertMenu.open = false;
  }

  const select = $('template-preview-group');
  const options = context.groups.length
    ? context.groups.map((group) => `<option value="${esc(group.id)}">${esc(group.name || group.id)}${group.enabled ? '' : '（未启用）'}</option>`).join('')
    : '<option value="">（无匹配配置）</option>';
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = preview.groupId || '';
  select.disabled = !context.groups.length;

  const blocked = previewBlocked(context);
  const writing = App.saving || App.mutating || App.loading;
  const status = $('template-preview-status');
  status.textContent = blocked
    || (App.saving ? '正在保存更改…' : App.mutating || App.loading ? '正在同步数据，请稍后…' : '')
    || (preview.busy ? '正在生成请求预览…' : '')
    || (preview.error ? `请求预览失败：${preview.error}` : '')
    || (context.unsaved ? '模板或配置有未保存更改，请保存后预览。' : '')
    || (preview.data ? '' : '预览尚未更新。');
  status.classList.toggle('error-text', !!preview.error && !blocked);

  const run = $('template-preview-run');
  run.textContent = preview.busy ? '正在预览…' : context.unsaved ? '保存并预览' : '更新预览';
  run.disabled = !showingPreview || !!blocked || writing || preview.busy;
  $('template-preview-copy').disabled = !showingPreview || !!blocked || writing || preview.busy || !preview.data?.raw_request;

  if (renderedData !== preview.data) {
    renderedData = preview.data;
    const messages = preview.data?.request?.messages || [];
    $('template-preview-messages').innerHTML = messages.map((message, index) => `
      <section class="template-preview-message">
        <h3 class="small">${esc(`${index + 1} · ${message.role}`)}</h3>
        <pre class="preview-code"><code>${esc(message.content)}</code></pre>
      </section>
    `).join('');
    $('template-preview-raw').innerHTML = preview.data ? previewCodeHtml(preview.data.raw_request, '请求内容为空') : '';
    const details = $('template-preview-raw-details');
    details.hidden = !preview.data;
    if (!preview.data) details.open = false;
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
    if (App.templatePreview.mode === 'preview') return;
    actionGeneration += 1;
    App.templatePreview.mode = 'preview';
    renderTemplatePreview();
    void requestPreview();
  });
  $('template-preview-group').addEventListener('input', (event) => {
    App.templatePreview.groupId = event.target.value || null;
  });
  $('template-preview-group').addEventListener('change', (event) => {
    actionGeneration += 1;
    App.templatePreview.groupId = event.target.value || null;
    renderTemplatePreview();
    void requestPreview();
  });
  $('template-preview-run').addEventListener('click', () => { void requestPreview({ save: true }); });
  $('template-preview-copy').addEventListener('click', async () => {
    renderTemplatePreview();
    const preview = App.templatePreview;
    if (preview.mode !== 'preview' || preview.busy || $('template-preview-copy').disabled || !preview.data?.raw_request) return;
    try {
      await navigator.clipboard.writeText(preview.data.raw_request);
      toast('请求已复制', 'ok');
    } catch {
      toast('复制失败，请从完整请求中手动复制。', 'error');
    }
  });
  // Bubble after editor handlers and the global capture-phase markEdit hook.
  // These listeners only invalidate local display; requests stay event-explicit.
  document.addEventListener('input', renderTemplatePreview);
  document.addEventListener('change', renderTemplatePreview);
}
