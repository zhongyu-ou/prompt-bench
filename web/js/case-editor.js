import { ICON_TRASH, KNOWN_VARIABLES, PROHIBITED_VARIABLES } from './constants.js';
import { $, clone, esc, excerptText, hasOwn, pretty, shortId } from './utils.js';
import { App } from './state.js';
import { caseById, caseEditorDirty, collectionsForCase, markEdit, setEqual } from './model.js';
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
  const variables = clone(baseline.variables);
  const extraKeys = Object.keys(variables).filter((k) => !KNOWN_VARIABLES.includes(k) && !PROHIBITED_VARIABLES.includes(k));
  const extraValues = {};
  for (const k of extraKeys) extraValues[k] = variables[k];
  App.caseEditor = {
    mode,
    sourceId: source ? source.id : null,
    baseline,
    variables,
    extraValues,
    removedExtras: new Set(),
    editedFields: new Set(),
    editedExtras: new Set(),
    baselineCollections: new Set(source ? collectionsForCase(source.id).map((c) => c.id) : []),
    collectionIds: new Set(source ? collectionsForCase(source.id).map((c) => c.id) : []),
    tab: 'form',
    jsonText: baseline.raw,
    jsonValid: baseline.parsedOk,
    jsonError: baseline.parsedOk ? '' : '服务端 variables_json 无法解析；请用高级 JSON 修正。',
    currentText: typeof variables.CurrentText === 'string' ? variables.CurrentText : '',
    priorText: typeof variables.PriorText === 'string' ? variables.PriorText : '',
    sourceLanguage: typeof variables.SourceLanguage === 'string' ? variables.SourceLanguage : '',
    replacementType: hasOwn(variables, 'ReplacementMap') ? typeof variables.ReplacementMap : 'undefined',
    replacementText: renderReplacementForForm(variables),
    formError: '',
    busy: false
  };
  if (!baseline.parsedOk) App.caseEditor.tab = 'json';
  const ed = App.caseEditor;
  if (source) App.activeCaseId = source.id;
  setView('case-editor');
  renderCaseEditor();
  window.setTimeout(() => {
    if (App.caseEditor && App.caseEditor.tab === 'form') $('case-current')?.focus();
  }, 0);
}

function renderReplacementForForm(variables) {
  if (!hasOwn(variables, 'ReplacementMap')) return '';
  const value = variables.ReplacementMap;
  if (typeof value === 'string') return value;
  return pretty(value);
}

function renderCaseEditor() {
  const ed = App.caseEditor;
  if (!ed) return;
  $('case-editor-title').textContent = ed.mode === 'edit' ? '编辑 Case' : '新建 Case';
  $('case-mode-form').setAttribute('aria-selected', ed.tab === 'form' ? 'true' : 'false');
  $('case-mode-json').setAttribute('aria-selected', ed.tab === 'json' ? 'true' : 'false');
  $('case-mode-form').classList.toggle('primary', ed.tab === 'form');
  $('case-mode-json').classList.toggle('primary', ed.tab === 'json');
  $('case-form-panel').hidden = ed.tab !== 'form';
  $('case-json-panel').hidden = ed.tab !== 'json';
  $('case-id-readonly').value = ed.mode === 'edit' ? shortId(ed.sourceId || '') : '保存后生成随机 ID';
  $('case-id-readonly').title = ed.mode === 'edit' ? (ed.sourceId || '') : '';
  $('case-copy-id').disabled = ed.mode !== 'edit';
  $('case-delete-btn').hidden = ed.mode !== 'edit';
  $('case-copy-btn').hidden = ed.mode !== 'edit';
  const current = $('case-current');
  if (document.activeElement !== current) current.value = ed.currentText;
  const prior = $('case-prior');
  if (document.activeElement !== prior) prior.value = ed.priorText;
  const source = $('case-source-language');
  if (document.activeElement !== source) source.value = ed.sourceLanguage;
  const repl = $('case-replacement');
  if (document.activeElement !== repl) repl.value = ed.replacementText;
  const replNonString = ed.replacementType !== 'undefined' && ed.replacementType !== 'string';
  repl.readOnly = replNonString;
  repl.placeholder = replNonString ? '非字符串值请在高级 JSON 中编辑' : '添加替换规则…';
  const typeTag = $('case-replacement-type');
  typeTag.textContent = ed.replacementType === 'undefined' ? '未设置' : ed.replacementType;
  typeTag.classList.toggle('warn', replNonString);

  const extraList = $('case-extra-list');
  const keys = Object.keys(ed.extraValues).sort();
  $('case-extra-count').textContent = String(keys.length);
  extraList.innerHTML = keys.map((key) => {
    const value = ed.extraValues[key];
    if (typeof value === 'string') {
      return `<div class="extra-row" data-extra-row="${esc(key)}">
        <span class="extra-key mono">${esc(key)}</span>
        <span class="type-tag">string</span>
        <input class="input" data-extra-string="${esc(key)}" value="${esc(value)}" aria-label="${esc(`${key} 的值`)}">
        <button type="button" class="mini-btn danger" data-extra-remove="${esc(key)}" title="移除变量">${ICON_TRASH}</button>
      </div>`;
    }
    return `<div class="extra-row" data-extra-row="${esc(key)}">
      <span class="extra-key mono">${esc(key)}</span>
      <span class="type-tag">${esc(Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value))}</span>
      <code class="extra-json" title="${esc(pretty(value))}">${esc(excerptText(pretty(value), 120))}</code>
      <button type="button" class="link-btn" data-extra-json="${esc(key)}">在高级 JSON 中编辑</button>
      <button type="button" class="mini-btn danger" data-extra-remove="${esc(key)}" title="移除变量">${ICON_TRASH}</button>
    </div>`;
  }).join('') || '<div class="muted small">没有其他变量。</div>';

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

  const prohibited = prohibitedKeys(ed.variables);
  const messages = [];
  if (ed.formError) messages.push(ed.formError);
  if (prohibited.length) messages.push(`变量包含禁用字段 ${prohibited.join(' / ')}：TargetLanguageNameMap 属于执行配置，不是 Case 输入。请在高级 JSON 中显式删除后再保存。`);
  $('case-editor-error').textContent = messages.join(' ');
  $('case-remove-prohibited').hidden = true;

  const jsonError = $('case-json-error');
  jsonError.textContent = ed.jsonError || '';
  jsonTa.setAttribute('aria-invalid', ed.jsonValid ? 'false' : 'true');

  const impact = $('case-save-impact');
  const count = ed.collectionIds.size;
  impact.textContent = count > 0 ? `保存将影响 ${count} 个集合` : '';
  impact.hidden = count === 0;
  $('case-save-btn').disabled = ed.busy || App.mutating;
  $('case-cancel-btn').disabled = ed.busy || App.mutating;
}

async function previewVariablesJson() {
  const ed = App.caseEditor;
  if (!ed) return null;
  const { patch, remove } = buildCaseVariablePatch();
  if (ed.formError) {
    renderCaseEditor();
    return null;
  }
  try {
    const payload = await apiPost('/api/cases/variables/preview', {
      variables_json: ed.jsonText,
      variable_patch: patch,
      remove_variables: remove
    });
    return typeof payload.variables_json === 'string' ? payload.variables_json : null;
  } catch (err) {
    ed.formError = `无法保留原始变量值：${err.message}`;
    renderCaseEditor();
    return null;
  }
}

async function switchCaseEditorTab(tab) {
  const ed = App.caseEditor;
  if (!ed || ed.tab === tab) return;
  if (tab === 'json') {
    const variableDirty = ed.editedFields.size > 0 || ed.editedExtras.size > 0 || ed.removedExtras.size > 0;
    if (variableDirty) {
      const exact = await previewVariablesJson();
      if (!exact) return;
      ed.jsonText = exact;
      ed.variables = safeParseObject(exact).value || ed.variables;
      ed.jsonValid = true;
      ed.jsonError = '';
      ed.editedFields.clear();
      ed.editedExtras.clear();
      ed.removedExtras.clear();
    }
    ed.tab = 'json';
  } else {
    const parsed = safeParseObject(ed.jsonText);
    if (!parsed.ok) {
      ed.jsonError = parsed.error;
      ed.tab = 'json';
      renderCaseEditor();
      return;
    }
    ed.variables = parsed.value;
    ed.currentText = typeof parsed.value.CurrentText === 'string' ? parsed.value.CurrentText : '';
    ed.priorText = typeof parsed.value.PriorText === 'string' ? parsed.value.PriorText : '';
    ed.sourceLanguage = typeof parsed.value.SourceLanguage === 'string' ? parsed.value.SourceLanguage : '';
    ed.replacementType = hasOwn(parsed.value, 'ReplacementMap') ? typeof parsed.value.ReplacementMap : 'undefined';
    ed.replacementText = renderReplacementForForm(parsed.value);
    ed.extraValues = {};
    for (const [k, v] of Object.entries(parsed.value)) {
      if (!KNOWN_VARIABLES.includes(k) && !PROHIBITED_VARIABLES.includes(k)) ed.extraValues[k] = v;
    }
    ed.editedFields.clear();
    ed.editedExtras.clear();
    ed.removedExtras.clear();
    ed.jsonError = '';
    ed.jsonValid = true;
    ed.tab = 'form';
  }
  renderCaseEditor();
}

function buildCaseVariablePatch() {
  const ed = App.caseEditor;
  const base = ed.variables || {};
  const patch = {};
  const remove = new Set(ed.removedExtras);
  const setString = (key, value) => {
    if (!ed.editedFields.has(key)) return;
    if (!hasOwn(base, key)) {
      if (value !== '') patch[key] = value;
      return;
    }
    if (typeof base[key] === 'string') patch[key] = value;
    else ed.formError = `${key} 当前不是字符串；请在高级 JSON 中修正。`;
  };
  setString('CurrentText', $('case-current').value);
  setString('PriorText', $('case-prior').value);
  setString('SourceLanguage', $('case-source-language').value);
  if (ed.replacementType === 'string' || ed.replacementType === 'undefined') {
    setString('ReplacementMap', $('case-replacement').value);
  }
  for (const key of ed.editedExtras) {
    if (remove.has(key)) continue;
    const value = ed.extraValues[key];
    if (typeof value !== 'string') continue;
    const baseValue = base[key];
    if (!hasOwn(base, key)) {
      if (value !== '') patch[key] = value;
    } else if (typeof baseValue === 'string') {
      patch[key] = value;
    } else {
      ed.formError = `变量 ${key} 当前不是字符串；请在高级 JSON 中修正。`;
    }
  }
  return { patch, remove: [...remove] };
}

async function caseEditorSave() {
  const ed = App.caseEditor;
  if (!ed || ed.busy || App.mutating) return;
  ed.formError = '';
  if (ed.tab === 'json') {
    const parsed = safeParseObject($('case-vars-json').value);
    if (!parsed.ok) {
      ed.jsonError = parsed.error;
      renderCaseEditor();
      return;
    }
    const prohibited = prohibitedKeys(parsed.value);
    if (prohibited.length) {
      ed.jsonError = `变量包含禁用字段 ${prohibited.join(' / ')}；请显式删除后再保存。`;
      renderCaseEditor();
      return;
    }
  } else {
    const prohibited = prohibitedKeys(ed.variables);
    if (prohibited.length) {
      ed.formError = `变量包含禁用字段 ${prohibited.join(' / ')}；请切换到高级 JSON 显式删除。`;
      renderCaseEditor();
      return;
    }
  }
  const collectionIds = [...ed.collectionIds];
  const submitGen = App.editGeneration;
  const submittedSnapshot = {
    current: $('case-current') ? $('case-current').value : ed.currentText,
    prior: $('case-prior') ? $('case-prior').value : ed.priorText,
    source: $('case-source-language') ? $('case-source-language').value : ed.sourceLanguage,
    replacement: $('case-replacement') ? $('case-replacement').value : ed.replacementText,
    extras: { ...ed.extraValues },
    removed: new Set(ed.removedExtras),
    collections: new Set(ed.collectionIds),
    jsonText: $('case-vars-json') ? $('case-vars-json').value : ed.jsonText
  };
  const formDirty = ed.editedFields.size > 0 || ed.editedExtras.size > 0 || ed.removedExtras.size > 0;
  let variablesJson = null;
  if (ed.tab === 'json') {
    variablesJson = $('case-vars-json').value;
  } else if (formDirty || ed.mode === 'create') {
    variablesJson = await previewVariablesJson();
    if (!variablesJson) return;
  } else if (ed.jsonText !== ed.baseline.raw) {
    variablesJson = ed.jsonText;
  }
  submittedSnapshot.variablesJson = variablesJson;
  if (ed.mode === 'edit' && variablesJson === null && setEqual(ed.collectionIds, ed.baselineCollections)) {
    ed.formError = '没有需要保存的更改。';
    renderCaseEditor();
    return;
  }
  ed.busy = true;
  renderCaseEditor();
  const path = ed.mode === 'edit' ? `/api/cases/${encodeURIComponent(ed.sourceId)}` : '/api/cases';
  const method = ed.mode === 'edit' ? 'PUT' : 'POST';
  const body = { collection_ids: collectionIds };
  if (variablesJson !== null) body.variables_json = variablesJson;
  const beforeIds = new Set(App.state.cases.map((c) => c.id));
  stateMutation(path, method, body, {
    errorLabel: '保存 Case 失败',
    onSuccess: () => {
      ed.busy = false;
      if (App.editGeneration === submitGen) {
        App.caseEditor = null;
        setView('cases', { force: true });
        toast(ed.mode === 'edit' ? 'Case 已保存' : 'Case 已创建', 'ok');
      } else {
        if (ed.mode === 'create') {
          const added = App.state.cases.find((c) => !beforeIds.has(c.id));
          if (added) ed.sourceId = added.id;
          ed.mode = 'edit';
        }
        const savedCase = caseById(ed.sourceId);
        ed.baseline = caseEditorBaselineFromCase(savedCase || { variables_json: '{}', variables: {} });
        ed.baselineCollections = new Set(savedCase ? collectionsForCase(savedCase.id).map((c) => c.id) : []);
        const currentJson = $('case-vars-json') ? $('case-vars-json').value : ed.jsonText;
        ed.jsonText = currentJson !== submittedSnapshot.variablesJson ? currentJson : ed.baseline.raw;
        const keepEdited = new Set();
        if ($('case-current') && $('case-current').value !== submittedSnapshot.current) keepEdited.add('CurrentText');
        if ($('case-prior') && $('case-prior').value !== submittedSnapshot.prior) keepEdited.add('PriorText');
        if ($('case-source-language') && $('case-source-language').value !== submittedSnapshot.source) keepEdited.add('SourceLanguage');
        if ($('case-replacement') && $('case-replacement').value !== submittedSnapshot.replacement) keepEdited.add('ReplacementMap');
        ed.editedFields = keepEdited;
        ed.editedExtras = new Set([...ed.editedExtras].filter((k) => ed.extraValues[k] !== submittedSnapshot.extras[k]));
        ed.removedExtras = new Set([...ed.removedExtras].filter((k) => !submittedSnapshot.removed.has(k)));
        renderCaseEditor();
        toast('已保存提交时的内容；请求期间的新编辑仍保留在本页，可再次保存。', 'warn', 5000);
      }
    }
  }).then((payload) => {
    if (!payload) {
      ed.busy = false;
      renderCaseEditor();
    }
  });
}

async function caseEditorCopyAsNew() {
  const ed = App.caseEditor;
  if (!ed || App.mutating) return;
  let variablesJson;
  if (ed.tab === 'json') {
    const parsed = safeParseObject($('case-vars-json').value);
    if (!parsed.ok) {
      ed.jsonError = parsed.error;
      renderCaseEditor();
      return;
    }
    variablesJson = $('case-vars-json').value;
  } else {
    const variableDirty = ed.editedFields.size > 0 || ed.editedExtras.size > 0 || ed.removedExtras.size > 0;
    variablesJson = variableDirty ? await previewVariablesJson() : ed.baseline.raw;
    if (!variablesJson) return;
  }
  const parsed = safeParseObject(variablesJson);
  if (!parsed.ok) {
    ed.formError = parsed.error;
    renderCaseEditor();
    return;
  }
  const prohibited = prohibitedKeys(parsed.value);
  if (prohibited.length) {
    ed.formError = `变量包含禁用字段 ${prohibited.join(' / ')}；请显式删除后再复制。`;
    renderCaseEditor();
    return;
  }
  if (!window.confirm('以当前输入创建一个新的随机 ID Case？原 Case 不会被修改。')) return;
  ed.busy = true;
  renderCaseEditor();
  const beforeIds = new Set(App.state.cases.map((c) => c.id));
  stateMutation('/api/cases', 'POST', {
    variables_json: variablesJson,
    collection_ids: [...ed.collectionIds]
  }, {
    errorLabel: '复制 Case 失败',
    onSuccess: () => {
      ed.busy = false;
      const added = App.state.cases.find((c) => !beforeIds.has(c.id));
      App.caseEditor = null;
      setView('cases', { force: true });
      toast(added ? `已复制为新 Case ${shortId(added.id)}` : '已复制为新 Case', 'ok');
    }
  }).then((payload) => {
    if (!payload) {
      ed.busy = false;
      renderCaseEditor();
    }
  });
}

function caseEditorDelete() {
  const ed = App.caseEditor;
  if (!ed || ed.mode !== 'edit' || App.mutating) return;
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

async function pasteInto(id) {
  const el = $(id);
  if (!el) return;
  try {
    const text = await navigator.clipboard.readText();
    el.value = text;
    markEdit();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    toast('无法读取剪贴板，请手动粘贴。', 'error');
  }
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
  $('case-paste-current').addEventListener('click', () => pasteInto('case-current'));
  $('case-paste-prior').addEventListener('click', () => pasteInto('case-prior'));
  ['case-current', 'case-prior', 'case-source-language'].forEach((id) => {
    $(id).addEventListener('input', () => {
      const ed = App.caseEditor;
      if (!ed) return;
      if (id === 'case-current') { ed.currentText = $(id).value; ed.editedFields.add('CurrentText'); }
      if (id === 'case-prior') { ed.priorText = $(id).value; ed.editedFields.add('PriorText'); }
      if (id === 'case-source-language') { ed.sourceLanguage = $(id).value; ed.editedFields.add('SourceLanguage'); }
      markEdit();
    });
  });
  $('case-replacement').addEventListener('input', () => {
    const ed = App.caseEditor;
    if (!ed) return;
    ed.replacementText = $('case-replacement').value;
    ed.editedFields.add('ReplacementMap');
    markEdit();
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
  $('case-extra-list').addEventListener('click', (e) => {
    const ed = App.caseEditor;
    if (!ed) return;
    const remove = e.target.closest('[data-extra-remove]');
    if (remove) {
      const key = remove.dataset.extraRemove;
      delete ed.extraValues[key];
      ed.removedExtras.add(key);
      markEdit();
      renderCaseEditor();
      return;
    }
    const json = e.target.closest('[data-extra-json]');
    if (json) {
      if (ed.tab !== 'json') switchCaseEditorTab('json');
      return;
    }
  });
  $('case-extra-list').addEventListener('input', (e) => {
    const ed = App.caseEditor;
    const input = e.target.closest('[data-extra-string]');
    if (!ed || !input) return;
    ed.extraValues[input.dataset.extraString] = input.value;
    ed.removedExtras.delete(input.dataset.extraString);
    ed.editedExtras.add(input.dataset.extraString);
    markEdit();
  });
  $('case-extra-add-btn').addEventListener('click', () => {
    const ed = App.caseEditor;
    if (!ed) return;
    const key = $('case-extra-key').value;
    const value = $('case-extra-value').value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      ed.formError = '变量名只能包含字母、数字和下划线，且不能以数字开头。';
      renderCaseEditor();
      return;
    }
    if (KNOWN_VARIABLES.includes(key)) {
      ed.formError = `变量 ${key} 已在表单上方编辑。`;
      renderCaseEditor();
      return;
    }
    if (PROHIBITED_VARIABLES.includes(key)) {
      ed.formError = `字段 ${key} 属于禁用字段。`;
      renderCaseEditor();
      return;
    }
    if (hasOwn(ed.extraValues, key)) {
      ed.formError = `变量 ${key} 已存在。`;
      renderCaseEditor();
      return;
    }
    ed.extraValues[key] = value;
    ed.removedExtras.delete(key);
    ed.editedExtras.add(key);
    ed.formError = '';
    $('case-extra-key').value = '';
    $('case-extra-value').value = '';
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
      ed.jsonError = prohibitedKeys(parsed.value).length
        ? `变量包含禁用字段 ${prohibitedKeys(parsed.value).join(' / ')}；请显式删除后再保存。`
        : '';
    } else {
      ed.jsonError = parsed.error;
    }
    $('case-json-error').textContent = ed.jsonError;
    markEdit();
  });
  $('case-save-btn').addEventListener('click', caseEditorSave);
  $('case-cancel-btn').addEventListener('click', caseEditorCancel);
  $('case-copy-btn').addEventListener('click', caseEditorCopyAsNew);
  $('case-delete-btn').addEventListener('click', caseEditorDelete);
}

export { openCaseEditor, renderCaseEditor };
