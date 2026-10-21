/* Promptbench · Case library, Case editor, standard package import/export,
 * per-group language routes and the run-range selector.
 * Loaded after app.js; shares the global App object and DOM helpers.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Shared mutation helper                                              */
/* ------------------------------------------------------------------ */

function maybeRenderCaseSurfaces({ includeEditor = false } = {}) {
  renderCollectionNav();
  if (typeof renderGroupCards === 'function') renderGroupCards();
  if (typeof renderWorkbenchCase === 'function') renderWorkbenchCase();
  if (typeof renderLibrary === 'function') renderLibrary();
  if (includeEditor && typeof renderCaseEditor === 'function') renderCaseEditor();
  if (typeof renderIO === 'function' && App.activeView === 'case-io') renderIO();
  if (typeof renderGroupEditor === 'function' && App.activeView === 'group-editor') renderGroupEditor();
  if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  updateDirtyUI();
  refreshRunPlan();
  if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview(0);
}

function applyMutationResult(view, payload, gen, onSuccess) {
  if (!view) return;
  const serverState = normalizeState(clone(view));
  // Decide against the pre-response baseline; updating savedJson first would make
  // every clean mutation look like a concurrent edit.
  const canAdopt = gen === App.editGeneration && !App.saving && !hasPendingCredentials() && !isDirty();
  App.version = serverState.version;
  if (payload && payload.credentials) App.credentials = normalizeCredentials(payload.credentials);
  App.savedAt = new Date();
  App.savedJson = stableStringify(serverState);
  if (canAdopt) {
    const keepActiveCase = App.activeCaseId;
    const keepActiveGroup = App.activeGroupId;
    App.state = serverState;
    ensureSelections();
    if (caseById(keepActiveCase)) App.activeCaseId = keepActiveCase;
    if (groupById(keepActiveGroup)) App.activeGroupId = keepActiveGroup;
  } else {
    // Preserve unrelated unsaved template/provider/group edits while adopting
    // the authoritative Case/collection resources returned by the server.
    App.state.cases = clone(serverState.cases);
    App.state.collections = clone(serverState.collections);
    App.state.version = App.version;
    const caseIds = new Set(App.state.cases.map((c) => c.id));
    const collectionIds = new Set(App.state.collections.map((c) => c.id));
    App.state.draft.case_ids = App.state.draft.case_ids.filter((id) => caseIds.has(id));
    App.state.draft.excluded_case_ids = App.state.draft.excluded_case_ids.filter((id) => caseIds.has(id));
    App.state.draft.collection_ids = App.state.draft.collection_ids.filter((id) => collectionIds.has(id));
    if (!caseById(App.activeCaseId)) App.activeCaseId = App.state.cases[0]?.id || null;
    if (!groupById(App.activeGroupId)) App.activeGroupId = App.state.draft.groups[0]?.id || null;
    showBanner('Case 数据已按服务端结果更新；保存期间的其他未保存编辑已保留，确认后可再次保存。', 'warn');
  }
  if (typeof onSuccess === 'function') onSuccess(serverState, payload);
  maybeRenderCaseSurfaces();
  renderProviders();
  renderSettings();
  markPreviewStale('Case 数据已更新');
}

async function stateMutation(path, method, body, { onSuccess, errorLabel = '写入失败' } = {}) {
  if (App.mutating) {
    toast('另一个写入正在进行，请稍候。', 'info', 1800);
    return null;
  }
  if (hasUnsavedWork()) {
    const ok = await ensureSaved();
    if (!ok) return null;
  }
  const gen = App.editGeneration;
  App.mutating = true;
  document.body.classList.add('mutating');
  updateDirtyUI();
  refreshRunPlan();
  try {
    const { payload } = await apiRaw(path, { method, body: { ...body, state_version: App.version } });
    const view = payload && payload.state ? payload.state : payload;
    applyMutationResult(view, payload, gen, (serverState) => {
      if (typeof onSuccess === 'function') onSuccess(serverState, payload);
    });
    return payload;
  } catch (err) {
    if (err.status === 409) {
      showBanner(`${errorLabel}：服务端状态版本已变化（409）。请重新载入后重试；未覆盖服务端。`, 'error', reloadFromServer);
      toast(`${errorLabel}：版本冲突`, 'error');
    } else {
      showBanner(`${errorLabel}：${err.message}`, 'error');
      toast(`${errorLabel}：${err.message}`, 'error');
    }
    return null;
  } finally {
    App.mutating = false;
    document.body.classList.remove('mutating');
    if (App.caseEditor) renderCaseEditor();
    if (App.activeView === 'case-io') renderIO();
    updateDirtyUI();
    refreshRunPlan();
  }
}

/* ------------------------------------------------------------------ */
/* Case library                                                        */
/* ------------------------------------------------------------------ */

function libraryFilteredCases() {
  if (!App.state) return [];
  let list = App.state.cases;
  const { search, source, collectionId } = App.library;
  if (collectionId) {
    const col = collectionById(collectionId);
    if (!col) {
      App.library.collectionId = null;
    } else {
      const members = new Set(col.case_ids);
      list = list.filter((c) => members.has(c.id));
    }
  }
  if (source) {
    if (source === '__none__') list = list.filter((c) => !sourceLanguageOf(c));
    else list = list.filter((c) => sourceLanguageOf(c) === source);
  }
  const q = search.trim().toLowerCase();
  if (q) {
    list = list.filter((c) => c.id.toLowerCase().includes(q) || currentTextOf(c).toLowerCase().includes(q));
  }
  return list;
}

function libraryPageState() {
  const list = libraryFilteredCases();
  const pages = Math.max(1, Math.ceil(list.length / App.library.pageSize));
  if (App.library.page > pages) App.library.page = pages;
  if (App.library.page < 1) App.library.page = 1;
  const start = (App.library.page - 1) * App.library.pageSize;
  return { list, pages, start, pageItems: list.slice(start, start + App.library.pageSize) };
}

function renderLibrary() {
  if (!App.state) return;
  const title = $('library-title');
  const actions = $('library-collection-actions');
  const col = App.library.collectionId ? collectionById(App.library.collectionId) : null;
  if (title) title.textContent = col ? col.name : '全部 Case';
  if (actions) actions.hidden = !col;

  const sourceSel = $('library-source');
  if (sourceSel) {
    const sources = [...new Set(App.state.cases.map(sourceLanguageOf))].sort((a, b) => String(a).localeCompare(String(b)));
    const options = ['<option value="">全部</option>'];
    for (const s of sources) {
      options.push(`<option value="${esc(s || '__none__')}">${esc(s || '（未设置）')}</option>`);
    }
    sourceSel.innerHTML = options.join('');
    const allowed = new Set(['', '__none__', ...sources]);
    if (!allowed.has(App.library.source)) App.library.source = '';
    sourceSel.value = App.library.source;
  }
  const searchInput = $('library-search');
  if (searchInput && document.activeElement !== searchInput && searchInput.value !== App.library.search) {
    searchInput.value = App.library.search;
  }

  const { list, pages, start, pageItems } = libraryPageState();
  const resultCount = $('library-result-count');
  if (resultCount) resultCount.textContent = `${list.length} 个结果`;
  const body = $('library-body');
  if (body) {
    if (!pageItems.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state">${App.state.cases.length ? '没有匹配当前搜索/筛选的 Case。' : '尚无 Case。点击“新建 Case”或导入标准包。'}</div></td></tr>`;
    } else {
      body.innerHTML = pageItems.map((c) => {
        const selected = App.library.selected.has(c.id);
        const names = collectionsForCase(c.id).map((x) => x.name);
        return `<tr class="${selected ? 'selected-row' : ''}" data-library-case="${esc(c.id)}">
          <td class="check-col"><input type="checkbox" data-library-check="${esc(c.id)}" ${selected ? 'checked' : ''} aria-label="${esc(`选择 Case ${c.id}`)}"></td>
          <td class="mono id-cell" title="${esc(c.id)}">${esc(shortId(c.id))}</td>
          <td class="asr-cell" title="${esc(currentTextOf(c))}">${esc(excerptText(currentTextOf(c)) || '（无 CurrentText）')}</td>
          <td class="mono source-cell">${esc(sourceLanguageOf(c) || '—')}</td>
          <td class="collections-cell">${names.length ? names.map((n) => `<span class="collection-name-chip">${esc(n)}</span>`).join('') : '<span class="muted">—</span>'}</td>
          <td class="actions"><button type="button" class="link-btn edit-link" data-library-edit="${esc(c.id)}">${ICON_EDIT}编辑</button></td>
        </tr>`;
      }).join('');
    }
  }

  const pageIds = pageItems.map((c) => c.id);
  const selectedOnPage = pageIds.filter((id) => App.library.selected.has(id)).length;
  const pageCheck = $('library-page-check');
  if (pageCheck) {
    pageCheck.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
    pageCheck.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
    pageCheck.disabled = !pageIds.length;
  }
  const pageCount = $('library-page-count');
  if (pageCount) {
    pageCount.textContent = `已选本页 ${selectedOnPage} / ${pageIds.length} 项${App.library.selected.size ? ` · 全部 ${App.library.selected.size} 项` : ''}`;
  }
  const allFilteredSelected = list.length > 0 && list.every((c) => App.library.selected.has(c.id));
  const selectAll = $('library-select-all');
  if (selectAll) {
    selectAll.textContent = allFilteredSelected
      ? `取消选择全部 ${list.length} 个匹配结果`
      : `选择全部 ${list.length} 个匹配结果`;
    selectAll.disabled = !list.length;
  }
  const none = App.library.selected.size === 0;
  if ($('library-join')) $('library-join').disabled = none || !App.state.collections.length;
  if ($('library-leave')) $('library-leave').disabled = none || !col;
  if ($('library-export')) $('library-export').disabled = none;
  if ($('library-debug')) $('library-debug').disabled = none;
  if ($('library-clear')) $('library-clear').disabled = none;

  const range = $('library-range');
  if (range) {
    range.textContent = list.length
      ? `显示 ${start + 1}–${start + pageItems.length} / ${list.length} 个 Case`
      : '显示 0 / 0 个 Case';
  }
  if ($('library-page')) $('library-page').textContent = String(App.library.page);
  if ($('library-pages')) $('library-pages').textContent = `共 ${pages} 页`;
  if ($('library-prev')) $('library-prev').disabled = App.library.page <= 1;
  if ($('library-next')) $('library-next').disabled = App.library.page >= pages;
}

function libraryTogglePage(checked) {
  const { pageItems } = libraryPageState();
  for (const c of pageItems) {
    if (checked) App.library.selected.add(c.id);
    else App.library.selected.delete(c.id);
  }
  renderLibrary();
}

function libraryToggleAllMatching() {
  const list = libraryFilteredCases();
  const all = list.length > 0 && list.every((c) => App.library.selected.has(c.id));
  for (const c of list) {
    if (all) App.library.selected.delete(c.id);
    else App.library.selected.add(c.id);
  }
  renderLibrary();
}

function libraryApplyForDebug() {
  if (!App.library.selected.size) return;
  const ids = [...App.library.selected].filter((id) => caseById(id));
  if (!ids.length) return;
  App.state.draft.case_ids = ids;
  App.state.draft.collection_ids = [];
  App.state.draft.excluded_case_ids = [];
  App.rangeDraft = null;
  App.activeCaseId = ids[0];
  markEdit();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('本次运行范围已由 Case 库更新');
  if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview(0);
  setView('workbench');
  toast(`已将 ${ids.length} 个 Case 设为本次调试范围（未启动运行）`, 'ok', 3000);
}

function libraryJoin() {
  if (!App.library.selected.size) return;
  if (!App.state.collections.length) {
    openCollectionDialog('create');
    return;
  }
  App.joinCollection = { caseIds: [...App.library.selected] };
  $('join-collection-meta').textContent = `将 ${App.joinCollection.caseIds.length} 个 Case 加入：`;
  $('join-collection-list').innerHTML = App.state.collections.map((c) => `
    <label class="join-row">
      <input type="radio" name="join-target" value="${esc(c.id)}">
      <span>${esc(c.name)}</span>
      <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
    </label>`).join('');
  $('join-collection-error').textContent = '';
  $('join-collection-dialog').showModal();
}

function libraryLeave() {
  const col = App.library.collectionId ? collectionById(App.library.collectionId) : null;
  if (!col || !App.library.selected.size) return;
  const ids = [...App.library.selected].filter((id) => caseById(id));
  if (!ids.length) return;
  if (!window.confirm(`从集合「${col.name}」移除 ${ids.length} 个 Case？\n\nCase 本身不会被删除。`)) return;
  stateMutation(`/api/collections/${encodeURIComponent(col.id)}/members`, 'POST', {
    add_case_ids: [],
    remove_case_ids: ids
  }, {
    errorLabel: '移出集合失败',
    onSuccess: () => {
      App.library.selected.clear();
      toast(`已从「${col.name}」移除 ${ids.length} 个 Case`, 'ok');
    }
  });
}

function librarySourceChanged() {
  App.library.source = $('library-source').value;
  App.library.page = 1;
  renderLibrary();
}

/* ------------------------------------------------------------------ */
/* Collection CRUD                                                     */
/* ------------------------------------------------------------------ */

function openCollectionDialog(mode, id = null) {
  const col = id ? collectionById(id) : null;
  if (mode === 'rename' && !col) return;
  App.collectionDialog = { mode, id };
  $('collection-dialog-title').textContent = mode === 'rename' ? '重命名集合' : '新建集合';
  $('collection-name').value = col ? col.name : '';
  $('collection-error').textContent = '';
  $('collection-submit').textContent = mode === 'rename' ? '保存名称' : '创建集合';
  $('collection-dialog').showModal();
  window.setTimeout(() => { $('collection-name').focus(); $('collection-name').select(); }, 0);
}

function submitCollectionDialog(event) {
  event.preventDefault();
  const name = $('collection-name').value;
  if (!name.trim()) {
    $('collection-error').textContent = '集合名称不能为空。';
    $('collection-name').focus();
    return;
  }
  const { mode, id } = App.collectionDialog;
  const beforeIds = new Set(App.state.collections.map((c) => c.id));
  const path = mode === 'rename' ? `/api/collections/${encodeURIComponent(id)}` : '/api/collections';
  stateMutation(path, mode === 'rename' ? 'PUT' : 'POST', { name }, {
    errorLabel: mode === 'rename' ? '重命名集合失败' : '新建集合失败',
    onSuccess: () => {
      $('collection-dialog').close();
      if (mode !== 'rename') {
        const added = App.state.collections.find((c) => !beforeIds.has(c.id));
        if (added) App.library.collectionId = added.id;
      }
      toast(mode === 'rename' ? '集合已重命名' : '集合已创建', 'ok');
    }
  });
}

function deleteCollection(id) {
  const col = collectionById(id);
  if (!col) return;
  if (!window.confirm(`删除集合「${col.name}」？\n\n只删除集合本身，不会删除其中的 ${col.case_ids.length} 个 Case。`)) return;
  stateMutation(`/api/collections/${encodeURIComponent(id)}`, 'DELETE', {}, {
    errorLabel: '删除集合失败',
    onSuccess: () => {
      if (App.library.collectionId === id) App.library.collectionId = null;
      $('manage-collections-dialog').close();
      toast('集合已删除，Case 保留', 'ok');
    }
  });
}

function renderManageCollections() {
  const host = $('manage-collections-list');
  if (!host) return;
  if (!App.state.collections.length) {
    host.innerHTML = '<div class="empty-state">尚无共享集合。</div>';
    return;
  }
  host.innerHTML = App.state.collections.map((c) => `
    <div class="manage-row">
      <span class="manage-name">${esc(c.name)}</span>
      <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
      <button type="button" class="btn tiny" data-manage-rename="${esc(c.id)}">重命名</button>
      <button type="button" class="btn tiny danger-text" data-manage-delete="${esc(c.id)}">删除</button>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Case editor                                                         */
/* ------------------------------------------------------------------ */

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
    busy: false,
    openedAt: App.editGeneration
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

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function caseEditorDirty() {
  const ed = App.caseEditor;
  if (!ed) return false;
  return ed.jsonText !== ed.baseline.raw
    || ed.editedFields.size > 0
    || ed.editedExtras.size > 0
    || ed.removedExtras.size > 0
    || !setEqual(ed.collectionIds, ed.baselineCollections);
}

function groupEditorDirty() {
  return !!App.groupEditor && stableStringify(App.groupEditor.working) !== App.groupEditor.baseline;
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

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

function ioCollectionsOptions(selected) {
  const options = ['<option value="">不额外加入集合</option>'];
  for (const c of App.state.collections) {
    options.push(`<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}（${esc(String(c.case_ids.length))}）</option>`);
  }
  return options.join('');
}

function detectPackageFormat(text, fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  const first = text.trim().split('\n').map((l) => l.trim()).find(Boolean) || '';
  try {
    const obj = JSON.parse(first);
    if (obj && obj.type === 'package') return 'jsonl';
  } catch { /* not a single object line */ }
  return 'json';
}

function ioFingerprint() {
  return JSON.stringify({ format: App.io.format, content: App.io.content, target: App.io.targetCollectionId });
}

function ioPreviewStale() {
  return !!App.io.preview && (
    App.io.previewStale
    || App.io.previewVersion !== App.version
    || App.io.previewFingerprint !== ioFingerprint()
  );
}

function renderIO() {
  if (!App.state) return;
  const targetSel = $('io-target-collection');
  if (targetSel) {
    targetSel.innerHTML = ioCollectionsOptions(App.io.targetCollectionId);
    if (![...targetSel.options].some((o) => o.value === App.io.targetCollectionId)) App.io.targetCollectionId = '';
    targetSel.value = App.io.targetCollectionId;
  }
  const fileName = $('io-file-name');
  if (fileName) fileName.textContent = App.io.fileName || '未选择文件';
  const summary = $('io-file-summary');
  const stale = ioPreviewStale();
  if (summary) {
    summary.textContent = App.io.content
      ? `已解析 ${(App.io.preview?.cases || []).length} 条 · ${App.io.format === 'jsonl' ? 'JSONL' : 'JSON'}${stale ? ' · 预览已过期' : ''}`
      : '选择 JSON 或 JSONL 标准包';
  }
  const preview = App.io.preview;
  const counts = $('io-counts');
  if (counts) {
    counts.querySelector('.io-new strong').textContent = String(preview ? preview.new_count : 0);
    counts.querySelector('.io-existing strong').textContent = String(preview ? preview.existing_count : 0);
  }
  if ($('io-collection-count')) {
    $('io-collection-count').textContent = preview ? `${preview.collection_count} 个集合记录` : '';
  }
  const body = $('io-preview-body');
  if (body) {
    const rows = preview ? preview.cases : [];
    const visible = App.io.expanded ? rows : rows.slice(0, 6);
    body.innerHTML = visible.length
      ? visible.map((row) => {
        const excerpt = excerptText(row.variables && typeof row.variables.CurrentText === 'string' ? row.variables.CurrentText : '', 34);
        const exists = row.status === 'existing';
        return `<tr>
          <td><span class="mono">${esc(shortId(row.file_id))}</span><span class="muted"> · ${esc(excerpt || '（无 CurrentText）')}</span></td>
          <td class="${exists ? 'status-existing' : 'status-new'}">${exists ? '已存在' : '新增'}</td>
          <td class="muted">${exists ? `复用 Case${row.local_id ? ` ${esc(shortId(row.local_id))}` : ''}` : '新建 Case'}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="3"><div class="empty-state">选择或粘贴标准包后显示预览。</div></td></tr>';
  }
  const expand = $('io-expand');
  if (expand) {
    const hiddenCount = preview ? Math.max(0, preview.cases.length - 6) : 0;
    expand.hidden = hiddenCount === 0;
    expand.textContent = App.io.expanded ? '收起' : `展开其余 ${hiddenCount} 条`;
  }
  const warnings = [];
  if (stale) warnings.push('预览已过期（状态版本或目标集合已变化）；请重新解析后再确认导入。');
  if (preview && preview.warnings && preview.warnings.length) warnings.push(...preview.warnings);
  $('io-error').textContent = warnings.join(' ');
  $('io-recover-btn').hidden = !App.io.recoverNeeded;
  $('io-recover-btn').disabled = App.io.busy || App.mutating;
  $('io-commit-btn').disabled = !preview || stale || App.io.busy || App.mutating;
  $('io-cancel-btn').disabled = App.io.busy || App.mutating;
  $('io-choose-file').disabled = App.io.busy || App.mutating;
  renderExportPanel();
}

function renderExportPanel() {
  if (!App.state) return;
  const selectedCases = [...App.library.selected].filter((id) => caseById(id));
  if ($('export-cases-label')) $('export-cases-label').textContent = `所选 Case · ${selectedCases.length} 项`;
  const checkedCollections = [...App.io.exportCollectionIds].filter((id) => collectionById(id));
  App.io.exportCollectionIds = new Set(checkedCollections);
  if ($('export-collections-label')) $('export-collections-label').textContent = `选定集合 · ${checkedCollections.length} 个`;
  $('export-range-cases').checked = App.io.exportRange === 'cases';
  $('export-range-collections').checked = App.io.exportRange === 'collections';
  $('export-range-cases').disabled = selectedCases.length === 0;
  $('export-range-collections').disabled = !App.state.collections.length;
  if (App.io.exportRange === 'cases' && selectedCases.length === 0 && App.state.collections.length) {
    App.io.exportRange = 'collections';
    $('export-range-cases').checked = false;
    $('export-range-collections').checked = true;
  }
  const list = $('export-collection-list');
  list.hidden = App.io.exportRange !== 'collections';
  list.innerHTML = App.state.collections.length
    ? App.state.collections.map((c) => `
      <label class="join-row compact">
        <input type="checkbox" data-export-collection="${esc(c.id)}" ${App.io.exportCollectionIds.has(c.id) ? 'checked' : ''}>
        <span>${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))}</span>
      </label>`).join('')
    : '<div class="muted small">尚无集合。</div>';
  document.querySelectorAll('[data-export-format]').forEach((btn) => {
    const active = btn.dataset.exportFormat === App.io.exportFormat;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('export-memberships').checked = App.io.exportIncludeMemberships;
  const hasSelection = App.io.exportRange === 'cases'
    ? selectedCases.length > 0
    : App.io.exportCollectionIds.size > 0;
  const btn = $('export-btn');
  btn.textContent = `导出 ${App.io.exportFormat === 'jsonl' ? 'JSONL' : 'JSON'}`;
  btn.disabled = !hasSelection || App.io.busy || App.mutating;
}

async function requestImportPreview({ format, content, fileName = '' } = {}) {
  const text = content !== undefined ? content : App.io.content;
  if (!text.trim()) {
    $('io-error').textContent = '请选择文件或粘贴 JSON / JSONL 内容。';
    return;
  }
  const fmt = format || detectPackageFormat(text, fileName || App.io.fileName);
  App.io.format = fmt;
  App.io.content = text;
  App.io.previewGen += 1;
  const gen = App.io.previewGen;
  const versionAtRequest = App.version;
  const fingerprint = ioFingerprint();
  App.io.busy = true;
  $('io-error').textContent = '解析中…';
  renderIO();
  try {
    const data = await apiPost('/api/cases/import/preview', {
      state_version: versionAtRequest,
      format: fmt,
      content: text,
      collection_ids: App.io.targetCollectionId ? [App.io.targetCollectionId] : []
    });
    if (gen !== App.io.previewGen) return;
    App.io.preview = data;
    App.io.previewVersion = Number.isFinite(Number(data.state_version)) ? Number(data.state_version) : versionAtRequest;
    App.io.previewFingerprint = fingerprint;
    App.io.previewStale = false;
    App.io.recoverNeeded = false;
    App.io.expanded = false;
    $('io-error').textContent = '';
  } catch (err) {
    if (gen !== App.io.previewGen) return;
    App.io.preview = null;
    App.io.previewVersion = null;
    App.io.previewFingerprint = '';
    App.io.previewStale = false;
    App.io.recoverNeeded = err.status === 409;
    $('io-error').textContent = err.status === 409
      ? '预览冲突：服务端状态版本已变化（409）。文件与目标集合已保留；请重新载入并解析，或手动重新解析。'
      : `预览失败：${err.message}`;
  } finally {
    if (gen === App.io.previewGen) {
      App.io.busy = false;
      renderIO();
    }
  }
}

function ioCommit() {
  if (!App.io.preview || App.io.busy || App.mutating) return;
  if (ioPreviewStale()) {
    App.io.recoverNeeded = App.io.previewVersion !== null && App.io.previewVersion !== App.version;
    $('io-error').textContent = App.io.recoverNeeded
      ? '服务端状态版本已变化；请重新载入并解析，文件与目标集合已保留。未提交任何内容。'
      : '预览内容或目标集合已变化；请重新解析后再确认导入。未提交任何内容。';
    renderIO();
    return;
  }
  const version = App.io.previewVersion;
  if (version !== App.version) {
    App.io.previewStale = true;
    App.io.recoverNeeded = true;
    $('io-error').textContent = '服务端状态版本已变化；请重新载入并解析，文件与目标集合已保留。';
    renderIO();
    return;
  }
  const format = App.io.format;
  const content = App.io.content;
  const target = App.io.targetCollectionId;
  const gen = App.editGeneration;
  App.io.busy = true;
  renderIO();
  (async () => {
    try {
      const { payload } = await apiRaw('/api/cases/import', {
        method: 'POST',
        body: {
          state_version: version,
          format,
          content,
          collection_ids: target ? [target] : []
        }
      });
      applyMutationResult(payload.state, payload, gen, (_state, result) => {
        App.io.busy = false;
        App.io.preview = null;
        App.io.previewVersion = null;
        App.io.previewFingerprint = '';
        App.io.previewStale = false;
        App.io.recoverNeeded = false;
        toast(`导入完成：新增 ${result?.new_count ?? 0}，复用 ${result?.existing_count ?? 0}`, 'ok', 5000);
        requestImportPreview({ format, content });
      });
    } catch (err) {
      if (err.status === 409) {
        App.io.previewStale = true;
        App.io.recoverNeeded = true;
        $('io-error').textContent = '导入预览已过期（409）；文件与目标集合已保留。请重新载入并解析后再导入；未写入任何 Case。';
      } else {
        App.io.recoverNeeded = false;
        $('io-error').textContent = `导入失败：${err.message}`;
      }
    } finally {
      App.io.busy = false;
      renderIO();
    }
  })();
}

async function recoverImportPreview() {
  if (App.io.busy || App.mutating) return;
  const content = App.io.content;
  const format = App.io.format;
  const fileName = App.io.fileName;
  const target = App.io.targetCollectionId;
  if (!content.trim()) return;
  App.io.busy = true;
  renderIO();
  const ok = await reloadFromServer();
  if (!ok) {
    App.io.busy = false;
    renderIO();
    return;
  }
  if (target && collectionById(target)) App.io.targetCollectionId = target;
  App.io.recoverNeeded = false;
  App.io.busy = false;
  await requestImportPreview({ format, content, fileName });
}

async function downloadCaseExport() {
  if (!App.state) return;
  const selectedCases = [...App.library.selected].filter((id) => caseById(id));
  const collectionIds = [...App.io.exportCollectionIds].filter((id) => collectionById(id));
  const caseIds = App.io.exportRange === 'cases' ? selectedCases : [];
  const cols = App.io.exportRange === 'collections' ? collectionIds : [];
  if (!caseIds.length && !cols.length) {
    $('export-error').textContent = '请先选择要导出的 Case 或集合。';
    return;
  }
  $('export-error').textContent = '';
  App.io.busy = true;
  renderExportPanel();
  try {
    const res = await fetch('/api/cases/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        state_version: App.version,
        format: App.io.exportFormat,
        case_ids: caseIds,
        collection_ids: cols,
        include_memberships: App.io.exportIncludeMemberships
      })
    });
    if (!res.ok) {
      let message = `导出失败（HTTP ${res.status}）`;
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch { /* keep default */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fileName = match ? match[1] : `promptbench-cases.${App.io.exportFormat}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${fileName}`, 'ok');
  } catch (err) {
    $('export-error').textContent = err.message;
    toast(`导出失败：${err.message}`, 'error');
  } finally {
    App.io.busy = false;
    renderExportPanel();
  }
}

function openIO(range = 'cases') {
  App.io.exportRange = range;
  if (range === 'collections' && App.library.collectionId) {
    App.io.exportCollectionIds = new Set([App.library.collectionId]);
  }
  if (range === 'cases') {
    const selected = [...App.library.selected].length;
    if (!selected && App.state.collections.length) App.io.exportRange = 'collections';
  }
  setView('case-io');
}

/* ------------------------------------------------------------------ */
/* Group editor                                                        */
/* ------------------------------------------------------------------ */

function openGroupEditor(id = null) {
  if (!App.state) return;
  const existing = id ? groupById(id) : null;
  if (id && !existing) return;
  const working = existing ? clone(existing) : nextGroupDefaults();
  if (!Array.isArray(working.language_routes)) working.language_routes = [];
  working.parameters = working.parameters && typeof working.parameters === 'object' && !Array.isArray(working.parameters)
    ? working.parameters
    : {};
  App.groupEditor = {
    mode: existing ? 'edit' : 'create',
    id: working.id,
    working,
    baseline: stableStringify(working),
    paramsText: pretty(working.parameters),
    paramsValid: true,
    error: '',
    busy: false
  };
  setView('group-editor');
  renderGroupEditor();
}

function groupEditorRouteSources() {
  const sources = new Set();
  for (const c of App.state.cases) {
    const s = sourceLanguageOf(c);
    if (s) sources.add(s);
  }
  for (const route of App.groupEditor?.working.language_routes || []) {
    if (route.source_language) sources.add(route.source_language);
  }
  return [...sources].sort((a, b) => a.localeCompare(b));
}

function renderGroupEditor() {
  const ge = App.groupEditor;
  if (!ge) return;
  const w = ge.working;
  $('group-editor-title').textContent = ge.mode === 'edit' ? '编辑对照配置' : '添加对照配置';
  $('group-editor-error').textContent = ge.error || '';
  $('ge-name').value = w.name || '';
  $('ge-model').value = w.model || '';
  $('ge-runs').value = String(w.runs || App.state.settings.default_runs);
  $('ge-enabled').checked = w.enabled !== false;
  const tplSel = $('ge-template');
  tplSel.innerHTML = App.state.templates.length
    ? App.state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name || t.id)}</option>`).join('')
    : '<option value="">（无模板）</option>';
  tplSel.value = w.template_id || '';
  const provSel = $('ge-provider');
  provSel.innerHTML = App.state.providers.length
    ? App.state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} · ${esc(protocolLabel(p.protocol || '未设置协议'))}</option>`).join('')
    : '<option value="">（无 Provider）</option>';
  provSel.value = w.provider_id || '';
  $('group-delete-btn').hidden = ge.mode !== 'edit';

  const sourceList = $('route-source-options');
  if (sourceList) {
    sourceList.innerHTML = groupEditorRouteSources().map((s) => `<option value="${esc(s)}"></option>`).join('');
  }

  const temp = hasOwn(w.parameters, 'temperature') ? w.parameters.temperature : undefined;
  const tempMode = !hasOwn(w.parameters, 'temperature') ? 'omit' : (temp === null ? 'null' : (typeof temp === 'number' ? 'value' : 'custom'));
  document.querySelectorAll('[data-temp-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tempMode === tempMode);
    btn.setAttribute('aria-pressed', btn.dataset.tempMode === tempMode ? 'true' : 'false');
  });
  $('ge-temp-value').value = typeof temp === 'number' ? String(temp) : '';
  $('ge-temp-value').hidden = tempMode !== 'value';
  $('ge-temp-value').disabled = tempMode !== 'value';

  const reasoning = hasOwn(w.parameters, 'reasoning_effort') ? w.parameters.reasoning_effort : undefined;
  const reasoningMode = !hasOwn(w.parameters, 'reasoning_effort')
    ? 'omit'
    : (reasoning === null ? 'null' : (['none', 'low', 'medium', 'high'].includes(reasoning) ? reasoning : 'custom'));
  $('ge-reasoning-mode').value = reasoningMode;
  const paramsTa = $('ge-params');
  if (document.activeElement !== paramsTa) paramsTa.value = ge.paramsText;

  renderRouteRows();
  renderMatchPreview();
}

function renderRouteRows() {
  const ge = App.groupEditor;
  if (!ge) return;
  const host = $('route-rows');
  const routes = ge.working.language_routes;
  if (!routes.length) {
    host.innerHTML = '<div class="route-empty muted small">没有自定义路由；所有源语言使用未匹配默认 en。</div>';
    return;
  }
  host.innerHTML = routes.map((route, index) => `
    <div class="route-row" data-route-index="${index}">
      <input class="input mono route-source-input" data-route-source="${index}" list="route-source-options"
        value="${esc(route.source_language || '')}" placeholder="源语言，例如 zh" aria-label="源语言">
      <span class="route-arrow" aria-hidden="true">→</span>
      <div class="route-targets">
        ${(route.targets || []).map((t, ti) => `
          <span class="target-chip">
            <span>${esc(t.key)} · ${esc(t.name)}</span>
            <button type="button" class="chip-remove" data-target-remove="${index}:${ti}" aria-label="${esc(`移除目标 ${t.key}`)}">×</button>
          </span>`).join('')}
        <button type="button" class="btn tiny add-target" data-add-target="${index}">＋ 添加目标</button>
      </div>
      <button type="button" class="mini-btn danger route-remove" data-route-remove="${index}" title="移除源语言">${ICON_TRASH}</button>
    </div>`).join('');
}

function renderMatchPreview() {
  const ge = App.groupEditor;
  const body = $('match-body');
  if (!ge || !body) return;
  const sources = [...new Set(App.state.cases.map(sourceLanguageOf))].sort((a, b) => a.localeCompare(b));
  if (!sources.length) {
    body.innerHTML = '<tr><td colspan="3"><div class="empty-state">Case 库为空。</div></td></tr>';
    return;
  }
  body.innerHTML = sources.map((source) => {
    const resolved = resolveGroupTargets(ge.working, source);
    return `<tr>
      <td class="mono">${esc(source || '（未设置）')}</td>
      <td class="mono">${esc((resolved.targets || []).map((t) => t.key).join(', ') || '—')}</td>
      <td class="${resolved.usedDefault ? 'match-default' : 'match-hit'}">${resolved.usedDefault ? '默认' : '匹配'}</td>
    </tr>`;
  }).join('');
}

function groupEditorSetTempMode(mode) {
  const ge = App.groupEditor;
  if (!ge) return;
  const params = ge.working.parameters;
  if (mode === 'omit') delete params.temperature;
  else if (mode === 'null') params.temperature = null;
  else if (mode === 'value') {
    const current = hasOwn(params, 'temperature') && typeof params.temperature === 'number' ? params.temperature : 0.1;
    params.temperature = current;
  }
  ge.paramsText = pretty(params);
  renderGroupEditor();
}

function groupEditorSyncParamsFromText() {
  const ge = App.groupEditor;
  if (!ge) return;
  const ta = $('ge-params');
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (err) {
    ge.paramsValid = false;
    ge.error = `高级参数 JSON 解析失败：${err.message}`;
    $('group-editor-error').textContent = ge.error;
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    ge.paramsValid = false;
    ge.error = '高级参数必须是 JSON 对象。';
    $('group-editor-error').textContent = ge.error;
    return;
  }
  for (const reserved of ['model', 'messages', 'stream']) {
    if (hasOwn(parsed, reserved)) {
      ge.paramsValid = false;
      ge.error = `参数中不允许保留字段「${reserved}」。`;
      $('group-editor-error').textContent = ge.error;
      return;
    }
  }
  for (const key of Object.keys(parsed)) {
    if (['authorization', 'api_key', 'api-key', 'apikey', 'headers', 'extra_headers'].includes(key.toLowerCase())) {
      ge.paramsValid = false;
      ge.error = `参数「${key}」可能包含凭据；请改用 Provider 凭据。`;
      $('group-editor-error').textContent = ge.error;
      return;
    }
  }
  ge.paramsValid = true;
  ge.error = '';
  ge.working.parameters = parsed;
  ge.paramsText = ta.value;
  renderGroupEditor();
}

function groupEditorSave() {
  const ge = App.groupEditor;
  if (!ge || ge.busy || App.mutating) return;
  const w = ge.working;
  const errors = [];
  const name = $('ge-name').value.trim();
  const model = $('ge-model').value.trim();
  const runs = Number($('ge-runs').value);
  const templateId = $('ge-template').value;
  const providerId = $('ge-provider').value;
  if (!name) errors.push('配置名称不能为空。');
  if (!templateId || !templateById(templateId)) errors.push('请选择存在的模板。');
  if (!providerId || !providerById(providerId)) errors.push('请选择存在的 Provider。');
  if (!model) errors.push('模型 ID 不能为空。');
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000) errors.push('每 Case 次数必须为 1–1000 的整数。');
  if (!ge.paramsValid) errors.push(ge.error || '高级参数 JSON 无效。');
  const routes = w.language_routes || [];
  errors.push(...validateRoutes(routes));
  if (errors.length) {
    ge.error = errors.join(' ');
    renderGroupEditor();
    return;
  }
  const group = {
    id: w.id,
    name,
    enabled: $('ge-enabled').checked,
    template_id: templateId,
    provider_id: providerId,
    model,
    parameters: clone(w.parameters),
    runs,
    language_routes: routes.map((r) => ({
      source_language: r.source_language,
      targets: (r.targets || []).map((t) => ({ key: t.key, name: t.name }))
    }))
  };
  const idx = App.state.draft.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) App.state.draft.groups[idx] = group;
  else App.state.draft.groups.push(group);
  App.activeGroupId = group.id;
  const bound = templateById(group.template_id);
  if (bound) {
    App.activeTemplateId = bound.id;
    App.activeMessageIndex = 0;
  }
  App.groupEditor = null;
  renderGroupCards();
  renderWorkbenchCase();
  renderTemplateOptions();
  renderTemplateEditor();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('对照配置已修改');
  scheduleSelectionPreview(0);
  setView('workbench', { force: true });
  toast('对照配置已保存到草稿', 'ok');
}

function groupEditorCancel() {
  if (groupEditorDirty() && !window.confirm('放弃对照配置中未保存的更改？')) return;
  App.groupEditor = null;
  setView('workbench', { force: true });
}

function groupEditorDelete() {
  const ge = App.groupEditor;
  if (!ge || ge.mode !== 'edit') return;
  if (!window.confirm(`删除对照配置「${ge.working.name || ge.id}」？历史批次不受影响。`)) return;
  deleteGroup(ge.id);
  App.groupEditor = null;
  setView('workbench', { force: true });
}

function openTargetDialog(routeIndex) {
  if (!App.groupEditor) return;
  App.targetDialog = { routeIndex };
  $('target-key').value = '';
  $('target-name').value = '';
  $('target-error').textContent = '';
  $('target-dialog').showModal();
  window.setTimeout(() => $('target-key').focus(), 0);
}

function submitTargetDialog(event) {
  event.preventDefault();
  const ge = App.groupEditor;
  if (!ge) return;
  const route = ge.working.language_routes[App.targetDialog.routeIndex];
  if (!route) return;
  const key = $('target-key').value;
  const name = $('target-name').value;
  if (!key || key.trim() !== key) {
    $('target-error').textContent = '响应键不能为空，且不能有首尾空白。';
    $('target-key').focus();
    return;
  }
  if (!name || !name.trim() || name.trim() !== name) {
    $('target-error').textContent = '语言名称不能为空，且不能有首尾空白。';
    $('target-name').focus();
    return;
  }
  if ((route.targets || []).some((t) => t.key === key)) {
    $('target-error').textContent = `该源语言已有响应键「${key}」。`;
    $('target-key').focus();
    return;
  }
  route.targets.push({ key, name });
  $('target-dialog').close();
  renderGroupEditor();
}

/* ------------------------------------------------------------------ */
/* Run-range selector                                                  */
/* ------------------------------------------------------------------ */

function pruneRangeDraft() {
  const st = App.rangeDraft;
  if (!st || !App.state) return false;
  const caseIds = new Set(App.state.cases.map((c) => c.id));
  const collectionIds = new Set(App.state.collections.map((c) => c.id));
  const before = JSON.stringify([st.case_ids, st.collection_ids, st.excluded_case_ids]);
  st.case_ids = st.case_ids.filter((id) => caseIds.has(id));
  st.collection_ids = st.collection_ids.filter((id) => collectionIds.has(id));
  st.excluded_case_ids = st.excluded_case_ids.filter((id) => caseIds.has(id));
  const changed = JSON.stringify([st.case_ids, st.collection_ids, st.excluded_case_ids]) !== before;
  if (changed) {
    st.base = stableStringify({
      case_ids: App.state.draft.case_ids,
      collection_ids: App.state.draft.collection_ids,
      excluded_case_ids: App.state.draft.excluded_case_ids
    });
  }
  return changed;
}

function rangeStaging() {
  if (!App.state) return null;
  const draftSel = {
    case_ids: App.state.draft.case_ids,
    collection_ids: App.state.draft.collection_ids,
    excluded_case_ids: App.state.draft.excluded_case_ids
  };
  const base = stableStringify(draftSel);
  if (!App.rangeDraft || App.rangeDraft.base !== base) {
    App.rangeDraft = {
      base,
      case_ids: [...draftSel.case_ids],
      collection_ids: [...draftSel.collection_ids],
      excluded_case_ids: [...draftSel.excluded_case_ids]
    };
  }
  pruneRangeDraft();
  return App.rangeDraft;
}

function scheduleStagedPreview(delay = 200) {
  if (typeof scheduleSelectionPreview !== 'function') return;
  if (App.selectionTimer) window.clearTimeout(App.selectionTimer);
  App.selectionTimer = window.setTimeout(() => {
    App.selectionTimer = null;
    if (!App.rangeDraft) return;
    refreshSelectionPreview({ selection: rangeSelection(), silent: true });
  }, delay);
}

function rangeSelection() {
  const st = rangeStaging();
  return st ? {
    case_ids: [...st.case_ids],
    collection_ids: [...st.collection_ids],
    excluded_case_ids: [...st.excluded_case_ids]
  } : {
    case_ids: [],
    collection_ids: [],
    excluded_case_ids: []
  };
}

function rangeDedupInfo(selection) {
  let memberCount = 0;
  const union = new Set();
  for (const cid of selection.collection_ids) {
    const col = collectionById(cid);
    if (!col) continue;
    memberCount += col.case_ids.length;
    for (const id of col.case_ids) union.add(id);
  }
  if (!selection.collection_ids.length) return null;
  return { overlap: Math.max(0, memberCount - union.size), union: union.size };
}

function renderSelectionPanel() {
  const panel = $('range-panel');
  const collapsed = $('range-collapsed');
  if (!panel) return;
  const pruned = pruneRangeDraft();
  if (pruned) {
    App.selectionPreview = null;
    App.selectionPreviewStale = true;
    App.selectionPreviewKey = '';
  }
  const visible = App.rangeOpen && App.activeView === 'workbench';
  panel.hidden = !visible;
  if (collapsed) collapsed.hidden = visible;
  if (!visible || !App.state) return;
  if (pruned) scheduleStagedPreview(0);
  const staging = rangeStaging();
  const selection = rangeSelection();
  const colHost = $('range-collections');
  const selectedCols = staging.collection_ids.map((id) => collectionById(id)).filter(Boolean);
  colHost.innerHTML = selectedCols.length
    ? selectedCols.map((c) => `
      <label class="range-collection-row">
        <input type="checkbox" checked data-range-collection="${esc(c.id)}">
        <span class="collection-name">${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
      </label>`).join('')
    : '<div class="muted small">未选择共享集合。可用“调整集合”选择。</div>';
  const dedup = rangeDedupInfo(selection);
  $('range-dedup').textContent = dedup
    ? `重叠 ${dedup.overlap} 项 · 去重后 ${dedup.union} 项`
    : '未选择集合';

  const explicitHost = $('range-explicit');
  if (explicitHost) {
    explicitHost.innerHTML = staging.case_ids.length
      ? `<div class="range-subhead">单独选择 <span class="muted small">${staging.case_ids.length} 项</span><button type="button" class="link-btn" id="range-explicit-clear">清空</button></div>
         <div class="exclusion-chips">${staging.case_ids.map((id) => `<span class="exclude-chip mono" title="${esc(id)}">${esc(shortId(id))}<button type="button" data-range-explicit-remove="${esc(id)}" aria-label="移除单独选择">×</button></span>`).join('')}</div>`
      : '<div class="muted small">无单独选择的 Case。</div>';
  }

  $('range-exclusion-count').textContent = `${staging.excluded_case_ids.length} 项`;
  const exHost = $('range-exclusions');
  exHost.innerHTML = staging.excluded_case_ids.length
    ? `<div class="exclusion-chips">${staging.excluded_case_ids.map((id) => `<span class="exclude-chip mono" title="${esc(id)}">${esc(shortId(id))}<button type="button" data-range-exclusion-remove="${esc(id)}" aria-label="取消排除">×</button></span>`).join('')}</div>`
    : '<div class="muted small">无临时排除。</div>';

  const preview = App.selectionPreview && App.selectionPreview.key === selectionKey(selection) && !App.selectionPreview.error
    ? App.selectionPreview.data
    : null;
  const resolved = preview ? preview.case_ids : resolveSelection(selection);
  $('range-count').textContent = String(resolved.length);
  const rows = resolved.slice(0, App.rangeShowAll ? resolved.length : 3).map((id) => {
    const c = caseById(id);
    if (!c) return '';
    const excluded = staging.excluded_case_ids.includes(id);
    return `<div class="range-preview-row">
      <span class="mono range-case-id">${esc(shortId(id))}</span>
      <span class="mono range-source">${esc(sourceLanguageOf(c) || '—')}</span>
      <span class="range-text" title="${esc(currentTextOf(c))}">${esc(excerptText(currentTextOf(c), 30) || '（无 CurrentText）')}</span>
      <button type="button" class="icon-btn tiny-icon" data-range-exclude="${esc(id)}" title="${excluded ? '取消排除' : '本次临时排除'}" ${excluded ? 'disabled' : ''}>
        <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.6 10S5.5 4.9 10 4.9 17.4 10 17.4 10 14.5 15.1 10 15.1 2.6 10 2.6 10z"/><circle cx="10" cy="10" r="2.1"/><path d="M4 16 16 4"/></svg>
      </button>
    </div>`;
  }).join('');
  $('range-preview').innerHTML = rows || '<div class="muted small">本次范围没有 Case。</div>';
  $('range-viewall').textContent = App.rangeShowAll ? '收起' : '查看全部';
  $('range-viewall').disabled = resolved.length <= 3;

  const enabledGroups = App.state.draft.groups.filter((g) => g.enabled);
  const runs = enabledGroups.map((g) => Number(g.runs) || 0);
  const requestCount = preview ? preview.request_count : resolved.length * runs.reduce((a, b) => a + b, 0);
  const formula = runs.length
    ? `${resolved.length} × ${runs.every((r) => r === runs[0]) ? `${runs[0]} × ${runs.length}` : `(${runs.join(' + ')})`} = ${requestCount} 次调用`
    : `${resolved.length} 个 Case · 没有启用配置`;
  $('range-formula').textContent = formula;
  $('range-error').textContent = App.selectionPreview && App.selectionPreview.key === selectionKey(selection) && App.selectionPreview.error
    ? `范围预览失败：${App.selectionPreview.error}`
    : '';
  $('range-apply').disabled = App.mutating;
  const stale = App.selectionPreviewStale || !preview;
  $('range-dedup').classList.toggle('stale', stale);
}

function rangeApply() {
  const staging = rangeStaging();
  if (!staging || App.mutating) return;
  App.state.draft.case_ids = [...staging.case_ids];
  App.state.draft.collection_ids = [...staging.collection_ids];
  App.state.draft.excluded_case_ids = [...staging.excluded_case_ids];
  App.rangeDraft = null;
  markEdit();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('本次运行范围已更新');
  scheduleSelectionPreview(0);
  renderSelectionPanel();
  toast('已应用到本次调试范围（未启动运行，也未修改集合成员）', 'ok', 3500);
}

function openRangeCollectionsDialog() {
  const staging = rangeStaging();
  if (!staging) return;
  $('range-collections-list').innerHTML = App.state.collections.length
    ? App.state.collections.map((c) => `
      <label class="join-row">
        <input type="checkbox" data-range-collection-pick="${esc(c.id)}" ${staging.collection_ids.includes(c.id) ? 'checked' : ''}>
        <span>${esc(c.name)}</span>
        <span class="muted small">${esc(String(c.case_ids.length))} 条</span>
      </label>`).join('')
    : '<div class="empty-state">尚无共享集合。可在 Case 库新建。</div>';
  $('range-collections-summary').textContent = '应用集合范围会清除“单独选择”的 Case；临时排除保留。';
  $('range-collections-dialog').showModal();
}

function applyRangeCollections() {
  const staging = rangeStaging();
  if (!staging) return;
  const ids = [...document.querySelectorAll('[data-range-collection-pick]:checked')].map((el) => el.dataset.rangeCollectionPick);
  staging.collection_ids = ids;
  staging.case_ids = [];
  const caseSet = new Set(resolveSelection({ case_ids: [], collection_ids: ids, excluded_case_ids: [] }));
  staging.excluded_case_ids = staging.excluded_case_ids.filter((id) => caseSet.has(id));
  App.rangeDraft = { ...staging };
  $('range-collections-dialog').close();
  renderSelectionPanel();
  scheduleStagedPreview(0);
}

/* ------------------------------------------------------------------ */
/* Event binding                                                       */
/* ------------------------------------------------------------------ */

function bindCaseEvents() {
  // Library: filters and pagination
  $('library-search').addEventListener('input', (e) => {
    App.library.search = e.target.value;
    App.library.page = 1;
    renderLibrary();
  });
  $('library-source').addEventListener('change', librarySourceChanged);
  $('library-prev').addEventListener('click', () => {
    App.library.page = Math.max(1, App.library.page - 1);
    renderLibrary();
  });
  $('library-next').addEventListener('click', () => {
    const { pages } = libraryPageState();
    App.library.page = Math.min(pages, App.library.page + 1);
    renderLibrary();
  });
  $('library-page-check').addEventListener('change', (e) => libraryTogglePage(e.target.checked));
  $('library-body').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-library-check]');
    if (!cb) return;
    if (cb.checked) App.library.selected.add(cb.dataset.libraryCheck);
    else App.library.selected.delete(cb.dataset.libraryCheck);
    renderLibrary();
  });
  $('library-body').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-library-edit]');
    if (edit) {
      openCaseEditor('edit', edit.dataset.libraryEdit);
      return;
    }
    const row = e.target.closest('tr[data-library-case]');
    if (row && !e.target.closest('input,button')) {
      App.library.selected.has(row.dataset.libraryCase)
        ? App.library.selected.delete(row.dataset.libraryCase)
        : App.library.selected.add(row.dataset.libraryCase);
      renderLibrary();
    }
  });
  $('library-select-all').addEventListener('click', libraryToggleAllMatching);
  $('library-clear').addEventListener('click', () => {
    App.library.selected.clear();
    renderLibrary();
  });
  $('library-join').addEventListener('click', libraryJoin);
  $('library-leave').addEventListener('click', libraryLeave);
  $('library-export').addEventListener('click', () => openIO('cases'));
  $('library-debug').addEventListener('click', libraryApplyForDebug);
  $('new-case-btn').addEventListener('click', () => openCaseEditor('create'));
  $('open-import-btn').addEventListener('click', () => openIO(App.library.selected.size ? 'cases' : 'collections'));
  $('open-export-btn').addEventListener('click', () => openIO(App.library.selected.size ? 'cases' : 'collections'));

  // Collections sidebar + management
  $('collection-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-collection-filter]');
    if (!row) return;
    App.library.collectionId = row.dataset.collectionFilter || null;
    App.library.page = 1;
    renderCollectionNav();
    renderLibrary();
    renderShell();
  });
  $('new-collection-btn').addEventListener('click', () => openCollectionDialog('create'));
  $('manage-collections-btn').addEventListener('click', () => {
    renderManageCollections();
    $('manage-collections-dialog').showModal();
  });
  $('manage-new-collection').addEventListener('click', () => openCollectionDialog('create'));
  $('manage-collections-list').addEventListener('click', (e) => {
    const rename = e.target.closest('[data-manage-rename]');
    if (rename) { openCollectionDialog('rename', rename.dataset.manageRename); return; }
    const del = e.target.closest('[data-manage-delete]');
    if (del) deleteCollection(del.dataset.manageDelete);
  });
  $('rename-collection-btn').addEventListener('click', () => {
    if (App.library.collectionId) openCollectionDialog('rename', App.library.collectionId);
  });
  $('delete-collection-btn').addEventListener('click', () => {
    if (App.library.collectionId) deleteCollection(App.library.collectionId);
  });
  $('collection-form').addEventListener('submit', submitCollectionDialog);
  $('join-collection-confirm').addEventListener('click', () => {
    const checked = document.querySelector('input[name="join-target"]:checked');
    if (!checked) {
      $('join-collection-error').textContent = '请选择一个集合。';
      return;
    }
    const col = collectionById(checked.value);
    if (!col) return;
    const ids = App.joinCollection.caseIds.filter((id) => caseById(id));
    stateMutation(`/api/collections/${encodeURIComponent(col.id)}/members`, 'POST', {
      add_case_ids: ids,
      remove_case_ids: []
    }, {
      errorLabel: '加入集合失败',
      onSuccess: () => {
        $('join-collection-dialog').close();
        App.library.selected.clear();
        renderLibrary();
        toast(`已加入「${col.name}」`, 'ok');
      }
    });
  });

  // Case editor
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

  // Import / export
  $('io-choose-file').addEventListener('click', () => $('io-file-input').click());
  $('io-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    App.io.fileName = file.name;
    App.io.content = await file.text();
    App.io.preview = null;
    App.io.expanded = false;
    $('io-paste-text').value = '';
    requestImportPreview({ format: detectPackageFormat(App.io.content, file.name), content: App.io.content, fileName: file.name });
  });
  $('io-parse-paste').addEventListener('click', () => {
    const text = $('io-paste-text').value;
    App.io.fileName = '粘贴内容';
    App.io.content = text;
    App.io.preview = null;
    requestImportPreview({ format: detectPackageFormat(text, ''), content: text });
  });
  $('io-target-collection').addEventListener('change', (e) => {
    App.io.targetCollectionId = e.target.value;
    if (App.io.preview) requestImportPreview();
  });
  $('io-expand').addEventListener('click', () => {
    App.io.expanded = !App.io.expanded;
    renderIO();
  });
  $('io-commit-btn').addEventListener('click', ioCommit);
  $('io-recover-btn').addEventListener('click', recoverImportPreview);
  $('io-cancel-btn').addEventListener('click', () => {
    App.io.content = '';
    App.io.fileName = '';
    App.io.preview = null;
    App.io.busy = false;
    $('io-paste-text').value = '';
    setView('cases', { force: true });
  });
  $('export-range-cases').addEventListener('change', () => {
    App.io.exportRange = 'cases';
    renderExportPanel();
  });
  $('export-range-collections').addEventListener('change', () => {
    App.io.exportRange = 'collections';
    renderExportPanel();
  });
  $('export-collection-list').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-export-collection]');
    if (!cb) return;
    if (cb.checked) App.io.exportCollectionIds.add(cb.dataset.exportCollection);
    else App.io.exportCollectionIds.delete(cb.dataset.exportCollection);
    renderExportPanel();
  });
  document.querySelectorAll('[data-export-format]').forEach((btn) => {
    btn.addEventListener('click', () => {
      App.io.exportFormat = btn.dataset.exportFormat;
      renderExportPanel();
    });
  });
  $('export-memberships').addEventListener('change', (e) => {
    App.io.exportIncludeMemberships = e.target.checked;
  });
  $('export-btn').addEventListener('click', downloadCaseExport);

  // Group editor
  $('group-cancel-btn').addEventListener('click', groupEditorCancel);
  $('group-save-btn').addEventListener('click', groupEditorSave);
  $('group-delete-btn').addEventListener('click', groupEditorDelete);
  ['ge-name', 'ge-model', 'ge-template', 'ge-provider', 'ge-enabled'].forEach((id) => {
    $(id).addEventListener('input', () => {
      const ge = App.groupEditor;
      if (!ge) return;
      ge.working.name = $('ge-name').value;
      ge.working.model = $('ge-model').value;
      ge.working.template_id = $('ge-template').value;
      ge.working.provider_id = $('ge-provider').value;
      ge.working.enabled = $('ge-enabled').checked;
      markEdit();
      renderMatchPreview();
    });
    $(id).addEventListener('change', () => {
      const ge = App.groupEditor;
      if (!ge) return;
      ge.working.name = $('ge-name').value;
      ge.working.model = $('ge-model').value;
      ge.working.template_id = $('ge-template').value;
      ge.working.provider_id = $('ge-provider').value;
      ge.working.enabled = $('ge-enabled').checked;
      markEdit();
      renderMatchPreview();
    });
  });
  $('ge-runs').addEventListener('change', () => {
    const ge = App.groupEditor;
    if (!ge) return;
    const runs = Number($('ge-runs').value);
    if (Number.isInteger(runs)) ge.working.runs = runs;
    markEdit();
  });
  document.querySelectorAll('[data-temp-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      groupEditorSetTempMode(btn.dataset.tempMode);
      markEdit();
    });
  });
  $('ge-temp-value').addEventListener('change', () => {
    const ge = App.groupEditor;
    if (!ge) return;
    const n = Number($('ge-temp-value').value);
    if (!Number.isFinite(n)) {
      toast('温度必须是数值', 'error');
      return;
    }
    ge.working.parameters.temperature = n;
    ge.paramsText = pretty(ge.working.parameters);
    renderGroupEditor();
    markEdit();
  });
  $('ge-reasoning-mode').addEventListener('change', () => {
    const ge = App.groupEditor;
    if (!ge) return;
    const mode = $('ge-reasoning-mode').value;
    if (mode === 'custom') return;
    if (mode === 'omit') delete ge.working.parameters.reasoning_effort;
    else if (mode === 'null') ge.working.parameters.reasoning_effort = null;
    else ge.working.parameters.reasoning_effort = mode;
    ge.paramsText = pretty(ge.working.parameters);
    renderGroupEditor();
    markEdit();
  });
  $('ge-params').addEventListener('input', groupEditorSyncParamsFromText);
  $('add-route-btn').addEventListener('click', () => {
    const ge = App.groupEditor;
    if (!ge) return;
    ge.working.language_routes.push({ source_language: '', targets: [] });
    renderGroupEditor();
    const inputs = document.querySelectorAll('[data-route-source]');
    inputs[inputs.length - 1]?.focus();
    markEdit();
  });
  $('route-rows').addEventListener('input', (e) => {
    const input = e.target.closest('[data-route-source]');
    const ge = App.groupEditor;
    if (!input || !ge) return;
    const index = Number(input.dataset.routeSource);
    if (ge.working.language_routes[index]) {
      ge.working.language_routes[index].source_language = input.value;
      markEdit();
      renderMatchPreview();
    }
  });
  $('route-rows').addEventListener('click', (e) => {
    const ge = App.groupEditor;
    if (!ge) return;
    const remove = e.target.closest('[data-route-remove]');
    if (remove) {
      ge.working.language_routes.splice(Number(remove.dataset.routeRemove), 1);
      renderGroupEditor();
      markEdit();
      return;
    }
    const add = e.target.closest('[data-add-target]');
    if (add) { openTargetDialog(Number(add.dataset.addTarget)); return; }
    const chipRemove = e.target.closest('[data-target-remove]');
    if (chipRemove) {
      const [ri, ti] = chipRemove.dataset.targetRemove.split(':').map(Number);
      ge.working.language_routes[ri]?.targets.splice(ti, 1);
      renderGroupEditor();
      markEdit();
    }
  });
  $('target-form').addEventListener('submit', submitTargetDialog);
  $('target-key').addEventListener('input', () => {
    const key = $('target-key').value;
    if (!$('target-name').value && LANGUAGE_NAMES[key]) $('target-name').value = LANGUAGE_NAMES[key];
  });

  // Range selector
  $('range-collections-btn').addEventListener('click', openRangeCollectionsDialog);
  $('range-collections-apply').addEventListener('click', applyRangeCollections);
  $('range-collections').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-range-collection]');
    const staging = rangeStaging();
    if (!cb || !staging) return;
    if (!cb.checked) {
      staging.collection_ids = staging.collection_ids.filter((id) => id !== cb.dataset.rangeCollection);
      renderSelectionPanel();
      scheduleStagedPreview(0);
    }
  });
  $('range-exclusions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range-exclusion-remove]');
    const staging = rangeStaging();
    if (!btn || !staging) return;
    staging.excluded_case_ids = staging.excluded_case_ids.filter((id) => id !== btn.dataset.rangeExclusionRemove);
    renderSelectionPanel();
    scheduleStagedPreview(0);
  });
  $('range-explicit').addEventListener('click', (e) => {
    const staging = rangeStaging();
    if (!staging) return;
    const remove = e.target.closest('[data-range-explicit-remove]');
    if (remove) {
      staging.case_ids = staging.case_ids.filter((id) => id !== remove.dataset.rangeExplicitRemove);
      renderSelectionPanel();
      scheduleStagedPreview(0);
      return;
    }
    if (e.target.closest('#range-explicit-clear')) {
      staging.case_ids = [];
      renderSelectionPanel();
      scheduleStagedPreview(0);
    }
  });
  $('range-preview').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range-exclude]');
    const staging = rangeStaging();
    if (!btn || !staging) return;
    const id = btn.dataset.rangeExclude;
    if (!staging.excluded_case_ids.includes(id)) {
      staging.excluded_case_ids.push(id);
      renderSelectionPanel();
      markEdit();
      scheduleStagedPreview(0);
    }
  });
  $('range-viewall').addEventListener('click', () => {
    App.rangeShowAll = !App.rangeShowAll;
    renderSelectionPanel();
  });
  $('range-apply').addEventListener('click', rangeApply);
}
