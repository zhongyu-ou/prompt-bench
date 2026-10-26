import { ICON_TRASH, PROHIBITED_VARIABLES } from './constants.js';
import { $, clone, esc, hasOwn, pretty, shortId } from './utils.js';
import { App } from './state.js';
import { caseById, caseEditorDirty, collectionsForCase, markEdit } from './model.js';
import { setView } from './navigation.js';
import { apiPost } from './api.js';
import { stateMutation } from './mutations.js';
import { toast } from './feedback.js';

function safeParseObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '变量必须是 JSON 对象（{ ... }）。' };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }
}

function prohibitedKeys(variables) {
  return PROHIBITED_VARIABLES.filter((k) => hasOwn(variables, k));
}

function caseEditorBaselineFromCase(c) {
  const raw = typeof c.variables_json === 'string' ? c.variables_json : pretty(c.variables);
  const parsed = safeParseObject(raw);
  return {
    raw,
    variables: parsed.ok ? parsed.value : clone(c.variables),
    parsedOk: parsed.ok
  };
}

function openCaseEditor(mode, id = null) {
  if (!App.state) return;
  const source = id ? caseById(id) : null;
  if (mode === 'edit' && !source) return;
  const baseline = source ? caseEditorBaselineFromCase(source) : { raw: '{}', variables: {}, parsedOk: true };
  const variables = baseline.variables;
  const collectionIds = source ? collectionsForCase(source.id).map((c) => c.id) : [];
  App.caseEditor = {
    mode,
    sourceId: source ? source.id : null,
    baseline,
    variables,
    fieldValues: new Map(Object.entries(variables)),
    editedFields: new Set(),
    removedFields: new Set(),
    baselineCollections: new Set(collectionIds),
    collectionIds: new Set(collectionIds),
    tab: baseline.parsedOk ? 'form' : 'json',
    jsonText: baseline.raw,
    jsonValid: baseline.parsedOk,
    jsonError: baseline.parsedOk ? '' : '服务端 variables_json 无法解析；请用高级 JSON 修正。',
    formError: '',
    busy: false
  };
  if (source) App.activeCaseId = source.id;
  setView('case-editor');
  renderCaseEditor();
  window.setTimeout(() => {
    if (App.caseEditor?.tab === 'form') {
      $('case-field-list').querySelector('textarea')?.focus();
    }
  }, 0);
}

function renderCaseEditor() {
  const ed = App.caseEditor;
  if (!ed) return;
  $('case-editor-title').textContent = ed.mode === 'edit' ? '编辑 Case' : '新建 Case';
  $('case-mode-form').setAttribute('aria-selected', ed.tab === 'form' ? 'true' : 'false');
  $('case-mode-json').setAttribute('aria-selected', ed.tab === 'json' ? 'true' : 'false');
  $('case-mode-form').classList.toggle('primary', ed.tab === 'form');
  $('case-mode-json').classList.toggle('primary', ed.tab === 'json');
  $('case-mode-form').disabled = ed.busy;
  $('case-mode-json').disabled = ed.busy;
  $('case-form-panel').hidden = ed.tab !== 'form';
  $('case-json-panel').hidden = ed.tab !== 'json';
  $('case-id-readonly').value = ed.mode === 'edit' ? shortId(ed.sourceId || '') : '保存后生成随机 ID';
  $('case-id-readonly').title = ed.mode === 'edit' ? (ed.sourceId || '') : '';
  $('case-copy-id').disabled = ed.mode !== 'edit';
  $('case-delete-btn').hidden = ed.mode !== 'edit';
  $('case-copy-btn').hidden = ed.mode !== 'edit';
  const fieldList = $('case-field-list');
  $('case-field-count').textContent = String(ed.fieldValues.size);
  // Keep the focused textarea intact when a save or collection change re-renders.
  if (!fieldList.contains(document.activeElement)) {
    fieldList.innerHTML = [...ed.fieldValues.keys()].sort().map((key) => {
      const value = ed.fieldValues.get(key);
      const type = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
      return `<div class="field" data-field-row="${esc(key)}">
        <div class="field-label-row">
          <span class="mono">${esc(key)} <span class="type-tag">${esc(type)}</span></span>
          <button type="button" class="mini-btn danger" data-field-remove="${esc(key)}" title="移除字段">${ICON_TRASH}</button>
        </div>
        ${typeof value === 'string'
          ? `<textarea class="code-editor case-textarea" data-field-string="${esc(key)}" spellcheck="false" aria-label="${esc(`${key} 的值`)}"></textarea>`
          : `<button type="button" class="link-btn" data-field-json="${esc(key)}">在 JSON 中编辑</button>`}
      </div>`;
    }).join('') || '<div class="muted small">没有输入字段。可添加字符串字段，或在高级 JSON 中填写其他值。</div>';
    for (const input of fieldList.querySelectorAll('[data-field-string]')) {
      input.value = ed.fieldValues.get(input.dataset.fieldString);
    }
  }

  const collections = $('case-collections');
  collections.innerHTML = App.state.collections.length
    ? App.state.collections.map((c) => `
      <label class="collection-check">
        <input type="checkbox" data-case-collection="${esc(c.id)}" ${ed.collectionIds.has(c.id) ? 'checked' : ''}>
        <span>${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))}</span>
      </label>`).join('')
    : '<div class="muted small">尚无共享集合。可在 Case 库侧栏新建。</div>';

  const jsonTa = $('case-vars-json');
  if (document.activeElement !== jsonTa) jsonTa.value = ed.jsonText;
  const prohibited = ed.tab === 'form'
    ? PROHIBITED_VARIABLES.filter((key) => ed.fieldValues.has(key))
    : prohibitedKeys(ed.variables);
  const messages = [];
  if (ed.formError) messages.push(ed.formError);
  if (prohibited.length) messages.push(`变量包含禁用字段 ${prohibited.join(' / ')}：TargetLanguageNameMap 属于执行配置，不是 Case 输入。请显式删除后再保存。`);
  $('case-editor-error').textContent = messages.join(' ');
  $('case-json-error').textContent = ed.jsonError || '';
  jsonTa.setAttribute('aria-invalid', ed.jsonValid ? 'false' : 'true');
  const impact = $('case-save-impact');
  const count = ed.collectionIds.size;
  impact.textContent = count > 0 ? `保存将影响 ${count} 个集合` : '';
  impact.hidden = count === 0;
  for (const id of ['case-save-btn', 'case-cancel-btn', 'case-copy-btn', 'case-delete-btn']) {
    $(id).disabled = ed.busy || App.mutating;
  }
}

function captureCaseEditor(ed) {
  return {
    tab: ed.tab,
    jsonText: ed.jsonText,
    fieldValues: new Map(ed.fieldValues),
    editedFields: new Set(ed.editedFields),
    removedFields: new Set(ed.removedFields),
    collectionIds: new Set(ed.collectionIds)
  };
}

function buildCaseVariablePatch(ed = App.caseEditor) {
  const entries = [];
  for (const key of ed.editedFields) {
    if (ed.removedFields.has(key) || !ed.fieldValues.has(key)) continue;
    const value = ed.fieldValues.get(key);
    if (typeof value === 'string') entries.push([key, value]);
  }
  return { patch: Object.fromEntries(entries), remove: [...ed.removedFields] };
}

async function previewVariablesJson(ed, submitted) {
  const { patch, remove } = buildCaseVariablePatch(submitted);
  try {
    const payload = await apiPost('/api/cases/variables/preview', {
      variables_json: submitted.jsonText,
      variable_patch: patch,
      remove_variables: remove
    });
    if (typeof payload.variables_json !== 'string') throw new Error('服务端未返回 variables_json。');
    return payload.variables_json;
  } catch (err) {
    if (App.caseEditor === ed) {
      ed.formError = `无法保留原始变量值：${err.message}`;
    }
    return null;
  }
}

async function switchCaseEditorTab(tab) {
  const ed = App.caseEditor;
  if (!ed || ed.tab === tab || ed.busy) return;
  if (tab === 'json') {
    const submitted = captureCaseEditor(ed);
    let exact = ed.jsonText;
    if (ed.editedFields.size || ed.removedFields.size) {
      ed.busy = true;
      renderCaseEditor();
      exact = await previewVariablesJson(ed, submitted);
      ed.busy = false;
      if (App.caseEditor !== ed) return;
      if (!exact) {
        renderCaseEditor();
        return;
      }
    }
    // A field edited while the lossless merge was pending must not be discarded.
    const unchanged = ed.jsonText === submitted.jsonText
      && fieldValuesEqual(ed.fieldValues, submitted.fieldValues);
    if (!unchanged) {
      ed.formError = '字段在切换期间发生变化，请再次切换以保留最新内容。';
      renderCaseEditor();
      return;
    }
    ed.jsonText = exact;
    ed.variables = safeParseObject(exact).value;
    ed.fieldValues = new Map(Object.entries(ed.variables));
    ed.editedFields.clear();
    ed.removedFields.clear();
    ed.jsonValid = true;
    ed.jsonError = '';
    ed.tab = 'json';
  } else {
    const parsed = safeParseObject(ed.jsonText);
    if (!parsed.ok) {
      ed.jsonError = parsed.error;
      renderCaseEditor();
      return;
    }
    ed.variables = parsed.value;
    ed.fieldValues = new Map(Object.entries(parsed.value));
    ed.editedFields.clear();
    ed.removedFields.clear();
    ed.jsonError = '';
    ed.jsonValid = true;
    ed.tab = 'form';
  }
  ed.formError = '';
  renderCaseEditor();
}

function fieldValuesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) return false;
  }
  return true;
}

function rebaseCaseEditor(ed, submitted, savedCase, collectionIds) {
  const currentFields = ed.fieldValues;
  const currentJson = ed.jsonText;
  ed.sourceId = savedCase.id;
  ed.mode = 'edit';
  ed.baseline = caseEditorBaselineFromCase(savedCase);
  ed.baselineCollections = new Set(collectionIds);
  ed.editedFields = new Set();
  ed.removedFields = new Set();
  if (submitted.tab === 'json' && currentJson !== submitted.jsonText) {
    const parsed = safeParseObject(currentJson);
    ed.jsonValid = parsed.ok;
    ed.jsonError = parsed.ok ? '' : parsed.error;
    if (parsed.ok) ed.variables = parsed.value;
    ed.fieldValues = new Map(Object.entries(ed.variables));
    return;
  }
  ed.jsonText = ed.baseline.raw;
  ed.variables = ed.baseline.variables;
  ed.fieldValues = new Map(Object.entries(ed.variables));
  ed.jsonValid = ed.baseline.parsedOk;
  ed.jsonError = '';
  if (submitted.tab !== 'form') return;
  const keys = new Set([...submitted.fieldValues.keys(), ...currentFields.keys()]);
  for (const key of keys) {
    if (currentFields.has(key) === submitted.fieldValues.has(key)
      && currentFields.get(key) === submitted.fieldValues.get(key)) continue;
    if (!currentFields.has(key)) {
      if (ed.fieldValues.has(key)) {
        ed.fieldValues.delete(key);
        ed.removedFields.add(key);
      }
    } else {
      const value = currentFields.get(key);
      if (!ed.fieldValues.has(key) || ed.fieldValues.get(key) !== value) {
        ed.fieldValues.set(key, value);
        ed.editedFields.add(key);
      }
    }
  }
}

async function submitCaseEditor(copyAsNew) {
  const ed = App.caseEditor;
  if (!ed || ed.busy || App.mutating) return;
  ed.formError = '';
  if (ed.tab === 'json') {
    const parsed = safeParseObject(ed.jsonText);
    if (!parsed.ok) {
      ed.jsonError = parsed.error;
      renderCaseEditor();
      return;
    }
    if (prohibitedKeys(parsed.value).length) {
      ed.jsonError = '变量包含禁用字段 TargetLanguageNameMap；请显式删除后再保存。';
      renderCaseEditor();
      return;
    }
  } else if (PROHIBITED_VARIABLES.some((key) => ed.fieldValues.has(key))) {
    ed.formError = '变量包含禁用字段 TargetLanguageNameMap；请显式删除后再保存。';
    renderCaseEditor();
    return;
  }
  if (!copyAsNew && ed.mode === 'edit' && !caseEditorDirty()) {
    ed.formError = '没有需要保存的更改。';
    renderCaseEditor();
    return;
  }
  if (copyAsNew && !window.confirm('以当前输入创建一个新的随机 ID Case？原 Case 不会被修改。')) return;
  const submitted = captureCaseEditor(ed);
  const creating = copyAsNew || ed.mode === 'create';
  const beforeIds = new Set(App.state.cases.map((c) => c.id));
  ed.busy = true;
  renderCaseEditor();
  try {
    const variablesJson = submitted.tab === 'form'
      ? await previewVariablesJson(ed, submitted)
      : submitted.jsonText;
    if (!variablesJson || App.caseEditor !== ed) return;
    const path = creating ? '/api/cases' : `/api/cases/${encodeURIComponent(ed.sourceId)}`;
    await stateMutation(path, creating ? 'POST' : 'PUT', {
      variables_json: variablesJson,
      collection_ids: [...submitted.collectionIds]
    }, {
      errorLabel: copyAsNew ? '复制 Case 失败' : '保存 Case 失败',
      onSuccess: (serverState) => {
        if (App.caseEditor !== ed) return;
        const savedCase = creating
          ? serverState.cases.find((c) => !beforeIds.has(c.id))
          : serverState.cases.find((c) => c.id === ed.sourceId);
        const collectionIds = serverState.collections.filter((c) => c.case_ids.includes(savedCase.id)).map((c) => c.id);
        rebaseCaseEditor(ed, submitted, savedCase, collectionIds);
        if (caseEditorDirty()) {
          toast('已保存提交时的内容；请求期间的新编辑仍保留在本页，可再次保存。', 'warn', 5000);
        } else {
          App.caseEditor = null;
          setView('cases', { force: true });
          toast(copyAsNew ? `已复制为新 Case ${shortId(savedCase.id)}` : (creating ? 'Case 已创建' : 'Case 已保存'), 'ok');
        }
      }
    });
  } finally {
    ed.busy = false;
    if (App.caseEditor === ed) renderCaseEditor();
  }
}

function caseEditorSave() {
  return submitCaseEditor(false);
}

function caseEditorCopyAsNew() {
  return submitCaseEditor(true);
}

function caseEditorDelete() {
  const ed = App.caseEditor;
  if (!ed || ed.busy || ed.mode !== 'edit' || App.mutating) return;
  const c = caseById(ed.sourceId);
  if (!c) return;
  const membership = collectionsForCase(c.id);
  const extra = membership.length ? `\n\n会同时从 ${membership.length} 个集合及本次运行范围中移除；历史批次不受影响。` : '\n\n历史批次不受影响。';
  if (!window.confirm(`删除 Case ${c.id}？${extra}`)) return;
  ed.busy = true;
  renderCaseEditor();
  stateMutation(`/api/cases/${encodeURIComponent(c.id)}`, 'DELETE', {}, {
    errorLabel: '删除 Case 失败',
    onSuccess: () => {
      App.caseEditor = null;
      setView('cases', { force: true });
      toast('Case 已删除', 'ok');
    }
  }).then((payload) => {
    if (!payload) {
      ed.busy = false;
      renderCaseEditor();
    }
  });
}

function caseEditorCancel() {
  if (caseEditorDirty() && !window.confirm('放弃 Case 编辑器中未保存的更改？')) return;
  App.caseEditor = null;
  setView('cases', { force: true });
}

export function bindCaseEditorEvents() {
  $('case-mode-form').addEventListener('click', () => switchCaseEditorTab('form'));
  $('case-mode-json').addEventListener('click', () => switchCaseEditorTab('json'));
  $('case-copy-id').addEventListener('click', async () => {
    const id = App.caseEditor?.sourceId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      toast('完整 Case ID 已复制', 'ok', 1600);
    } catch {
      toast('复制失败，请手动选择 ID', 'error');
    }
  });
  $('case-collections').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-case-collection]');
    const ed = App.caseEditor;
    if (!cb || !ed) return;
    if (cb.checked) ed.collectionIds.add(cb.dataset.caseCollection);
    else ed.collectionIds.delete(cb.dataset.caseCollection);
    markEdit();
    renderCaseEditor();
  });
  $('case-field-list').addEventListener('click', (e) => {
    const ed = App.caseEditor;
    if (!ed) return;
    const remove = e.target.closest('[data-field-remove]');
    if (remove) {
      const key = remove.dataset.fieldRemove;
      ed.fieldValues.delete(key);
      ed.editedFields.delete(key);
      if (hasOwn(ed.variables, key)) ed.removedFields.add(key);
      else ed.removedFields.delete(key);
      ed.formError = '';
      markEdit();
      remove.blur();
      renderCaseEditor();
      return;
    }
    if (e.target.closest('[data-field-json]')) switchCaseEditorTab('json');
  });
  $('case-field-list').addEventListener('input', (e) => {
    const ed = App.caseEditor;
    const input = e.target.closest('[data-field-string]');
    if (!ed || !input) return;
    const key = input.dataset.fieldString;
    if (!ed.fieldValues.has(key) || typeof ed.fieldValues.get(key) !== 'string') return;
    ed.fieldValues.set(key, input.value);
    ed.removedFields.delete(key);
    if (hasOwn(ed.variables, key) && ed.variables[key] === input.value) ed.editedFields.delete(key);
    else ed.editedFields.add(key);
    ed.formError = '';
    markEdit();
  });
  $('case-field-add-btn').addEventListener('click', () => {
    const ed = App.caseEditor;
    if (!ed) return;
    const key = $('case-field-key').value;
    const value = $('case-field-value').value;
    if (!key.length) {
      ed.formError = '字段名不能为空。';
      renderCaseEditor();
      return;
    }
    if (PROHIBITED_VARIABLES.includes(key)) {
      ed.formError = `字段 ${key} 属于禁用字段。`;
      renderCaseEditor();
      return;
    }
    if (ed.fieldValues.has(key)) {
      ed.formError = `字段 ${key} 已存在。`;
      renderCaseEditor();
      return;
    }
    ed.fieldValues.set(key, value);
    ed.removedFields.delete(key);
    ed.editedFields.add(key);
    ed.formError = '';
    $('case-field-key').value = '';
    $('case-field-value').value = '';
    markEdit();
    renderCaseEditor();
  });
  $('case-vars-json').addEventListener('input', () => {
    const ed = App.caseEditor;
    if (!ed) return;
    ed.jsonText = $('case-vars-json').value;
    const parsed = safeParseObject(ed.jsonText);
    ed.jsonValid = parsed.ok;
    if (parsed.ok) {
      ed.variables = parsed.value;
      ed.fieldValues = new Map(Object.entries(parsed.value));
      ed.jsonError = prohibitedKeys(parsed.value).length
        ? `变量包含禁用字段 ${prohibitedKeys(parsed.value).join(' / ')}；请显式删除后再保存。`
        : '';
    } else {
      ed.jsonError = parsed.error;
    }
    $('case-json-error').textContent = ed.jsonError;
    $('case-vars-json').setAttribute('aria-invalid', parsed.ok ? 'false' : 'true');
    markEdit();
  });
  $('case-save-btn').addEventListener('click', caseEditorSave);
  $('case-cancel-btn').addEventListener('click', caseEditorCancel);
  $('case-copy-btn').addEventListener('click', caseEditorCopyAsNew);
  $('case-delete-btn').addEventListener('click', caseEditorDelete);
}

export { buildCaseVariablePatch, openCaseEditor, rebaseCaseEditor, renderCaseEditor };
