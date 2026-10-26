import { $, clone, esc, uniqueId } from './utils.js';
import { activeGroup, activeMessage, activeTemplate, ensureSelections, groupById, markEdit, templateById } from './model.js';
import { toast } from './feedback.js';
import { App } from './state.js';
import { renderGroupCards, renderModelSuggestions } from './workbench-view.js';
import { renderShell, updateDirtyUI } from './shell-view.js';
import { refreshRunPlan } from './run-plan.js';
import { renderTemplatePreview } from './template-preview.js';

let renamingTemplateId = null;
function renderTemplateMismatch() {
  const btn = $('template-mismatch');
  if (!btn) return;
  const g = activeGroup();
  const editing = activeTemplate();
  if (!g || !editing) {
    btn.hidden = true;
    return;
  }
  const bound = templateById(g.template_id);
  if (bound && bound.id === editing.id) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = bound
    ? `编辑器「${editing.name || editing.id}」≠ 配置绑定「${bound.name || bound.id}」 · 切到绑定模板`
    : '配置绑定的模板缺失 · 请编辑配置';
  btn.title = '运行使用对照配置绑定的模板，与编辑器当前浏览的模板无关。';
}

function focusBoundTemplate() {
  const g = activeGroup();
  const bound = g ? templateById(g.template_id) : null;
  if (!g || !bound) {
    toast('当前配置没有可用的绑定模板。', 'error');
    return;
  }
  App.activeTemplateId = bound.id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  toast(`已切到配置「${g.name || g.id}」绑定的模板`, 'ok', 2000);
}

function renderTemplateOptions() {
  const sel = $('template-select');
  if (!sel || !App.state) return;
  const templates = App.state.templates;
  sel.innerHTML = templates.length
    ? templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name || t.id)}</option>`).join('')
    : '<option value="">（无模板）</option>';
  sel.value = App.activeTemplateId || '';
  $('rename-template-btn').disabled = !templates.length;
  $('dup-template-btn').disabled = !templates.length;
  $('del-template-btn').disabled = !templates.length;
}

function renderTemplateEditor() {
  if (!App.state) return;
  const tpl = activeTemplate();
  const msg = activeMessage();
  const ta = $('message-content');
  const role = $('message-role');
  const tabs = $('message-tabs');
  const roles = [...new Set(App.providerProtocols.flatMap((protocol) => protocol.roles || []))];
  role.replaceChildren(...roles.map((value) => new Option(value, value)));
  if (msg && !roles.includes(msg.role)) {
    const unknown = new Option(`${msg.role}（不支持）`, msg.role);
    unknown.disabled = true;
    role.add(unknown);
  }

  if (!tpl) {
    tabs.innerHTML = '<span class="message-tabs-empty">尚无模板。点击“新建模板”开始。</span>';
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = '请先新建模板。';
    role.disabled = true;
    $('add-message-btn').disabled = true;
    $('del-message-btn').disabled = true;
    updateLineInfo(ta, $('message-lineinfo'));
    renderTemplateMismatch();
    renderTemplatePreview();
    return;
  }

  $('add-message-btn').disabled = false;
  if (!tpl.messages.length) {
    tabs.innerHTML = '<span class="message-tabs-empty">该模板没有消息。点击“＋ 消息”添加。</span>';
  } else {
    tabs.innerHTML = tpl.messages.map((m, index) => `
      <button type="button" class="message-tab role-${esc(m.role)}" role="tab"
        aria-selected="${index === App.activeMessageIndex ? 'true' : 'false'}"
        data-message-index="${index}">
        <span class="role-dot" aria-hidden="true"></span>${esc(`${index + 1} · ${m.role}`)}
      </button>
    `).join('');
  }
  ta.disabled = !msg;
  $('del-message-btn').disabled = !msg;
  role.disabled = !msg;
  if (msg) {
    ta.placeholder = '编写 Go text/template 消息内容，例如 {{ .CurrentText }}';
    if (ta.value !== msg.content) ta.value = msg.content;
    role.value = msg.role;
  } else {
    ta.value = '';
    ta.placeholder = '添加一条消息后开始编辑。';
    role.value = 'user';
  }
  updateLineInfo(ta, $('message-lineinfo'));
  renderTemplateMismatch();
  renderTemplatePreview();
}


function handleMessageInput() {
  const msg = activeMessage();
  const ta = $('message-content');
  if (!msg || !ta) return;
  msg.content = ta.value;
  updateLineInfo(ta, $('message-lineinfo'));
  refreshRunPlan();
  renderTemplatePreview();
}

function updateLineInfo(textarea, label) {
  if (!textarea || !label) return;
  const pos = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, pos);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  const col = pos - lastBreak;
  const total = textarea.value.split('\n').length;
  label.textContent = `行 ${line}，列 ${col} · ${total} 行`;
}

function openTemplateDialog(rename = false) {
  const tpl = rename ? activeTemplate() : null;
  if (rename && !tpl) return;
  renamingTemplateId = tpl?.id || null;
  const input = $('template-new-name');
  input.value = tpl ? tpl.name || tpl.id : `模板 ${App.state.templates.length + 1}`;
  $('template-dialog-title').textContent = tpl ? '重命名模板' : '新建模板';
  $('template-confirm').textContent = tpl ? '重命名' : '新建';
  $('template-error').textContent = '';
  $('template-dialog').showModal();
  window.setTimeout(() => { input.focus(); input.select(); }, 0);
}

function createTemplate(name) {
  const ids = new Set(App.state.templates.map((t) => t.id));
  const id = uniqueId('template_', ids);
  const tpl = { id, name: name.trim(), messages: [{ role: 'user', content: '' }] };
  App.state.templates.push(tpl);
  markEdit();
  App.activeTemplateId = id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
}

function duplicateTemplate() {
  const src = activeTemplate();
  if (!src) return;
  const ids = new Set(App.state.templates.map((t) => t.id));
  const id = uniqueId('template_', ids);
  const copy = clone(src);
  copy.id = id;
  copy.name = `${src.name || src.id} 副本`;
  App.state.templates.push(copy);
  markEdit();
  App.activeTemplateId = id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
  toast('已复制模板到草稿，保存后生效', 'ok');
}

function deleteTemplate() {
  const tpl = activeTemplate();
  if (!tpl) return;
  const groups = App.state.draft.groups.filter((g) => g.template_id === tpl.id);
  const extra = groups.length ? `\n\n草稿中引用它的 ${groups.length} 个对照配置也会被移除。` : '';
  if (!window.confirm(`删除模板「${tpl.name || tpl.id}」？${extra}\n\n已保存的历史批次不受影响。`)) return;
  App.state.templates = App.state.templates.filter((t) => t.id !== tpl.id);
  markEdit();
  if (groups.length) {
    App.state.draft.groups = App.state.draft.groups.filter((g) => g.template_id !== tpl.id);
    if (!groupById(App.activeGroupId)) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  }
  App.activeTemplateId = App.state.templates[0]?.id || null;
  App.activeMessageIndex = 0;
  ensureSelections();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
}

function addMessage() {
  const tpl = activeTemplate();
  if (!tpl) return;
  tpl.messages.push({ role: 'user', content: '' });
  markEdit();
  App.activeMessageIndex = tpl.messages.length - 1;
  renderTemplateEditor();
  refreshRunPlan();
  $('message-content').focus();
}

function deleteMessage() {
  const tpl = activeTemplate();
  const msg = activeMessage();
  if (!tpl || !msg) return;
  if (tpl.messages.length <= 1) {
    toast('模板至少需要一条消息；如需清空请删除整个模板。', 'error');
    return;
  }
  tpl.messages.splice(App.activeMessageIndex, 1);
  markEdit();
  App.activeMessageIndex = Math.min(App.activeMessageIndex, Math.max(0, tpl.messages.length - 1));
  renderTemplateEditor();
  updateDirtyUI();
  refreshRunPlan();
}

export function bindTemplateEvents() {
  $('template-select').addEventListener('change', (e) => {
    App.activeTemplateId = e.target.value || null;
    App.activeMessageIndex = 0;
    renderTemplateOptions();
    renderTemplateEditor();
    renderTemplateMismatch();
    renderShell();
  });
  $('new-template-btn').addEventListener('click', () => openTemplateDialog());
  $('rename-template-btn').addEventListener('click', () => openTemplateDialog(true));
  $('template-mismatch').addEventListener('click', focusBoundTemplate);
  $('dup-template-btn').addEventListener('click', duplicateTemplate);
  $('del-template-btn').addEventListener('click', deleteTemplate);

  $('message-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-message-index]');
    if (!tab) return;
    App.activeMessageIndex = Number(tab.dataset.messageIndex);
    renderTemplateEditor();
  });
  $('message-content').addEventListener('input', handleMessageInput);
  ['input', 'click', 'keyup', 'select'].forEach((evt) => {
    $('message-content').addEventListener(evt, () => updateLineInfo($('message-content'), $('message-lineinfo')));
  });
  $('message-content').addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = `${ta.value.slice(0, start)}  ${ta.value.slice(end)}`;
      if (next !== ta.value) markEdit();
      ta.value = next;
      ta.setSelectionRange(start + 2, start + 2);
      handleMessageInput();
    }
  });
  $('message-role').addEventListener('change', (e) => {
    const msg = activeMessage();
    if (!msg || msg.role === e.target.value) return;
    msg.role = e.target.value;
    markEdit();
    renderTemplateEditor();
    refreshRunPlan();
  });
  $('add-message-btn').addEventListener('click', addMessage);
  $('del-message-btn').addEventListener('click', deleteMessage);

  $('template-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('template-new-name').value.trim();
    if (!name) {
      $('template-error').textContent = '模板名称不能为空。';
      $('template-new-name').focus();
      return;
    }
    if (renamingTemplateId) {
      const tpl = templateById(renamingTemplateId);
      if (!tpl) {
        $('template-error').textContent = '模板已不存在。';
        return;
      }
      if (tpl.name !== name) {
        tpl.name = name;
        markEdit();
        renderTemplateOptions();
        renderTemplateMismatch();
        renderGroupCards();
        updateDirtyUI();
        refreshRunPlan();
      }
    } else {
      createTemplate(name);
      toast('已新建模板，保存更改后生效', 'ok');
    }
    $('template-dialog').close();
  });
}

export { focusBoundTemplate, renderTemplateEditor, renderTemplateMismatch, renderTemplateOptions };
