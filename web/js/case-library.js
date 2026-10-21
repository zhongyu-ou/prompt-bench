import { App } from './state.js';
import { caseById, collectionById, collectionsForCase, markEdit } from './model.js';
import { $, currentTextOf, esc, excerptText, shortId, sourceLanguageOf } from './utils.js';
import { ICON_EDIT } from './constants.js';
import { renderShell, updateDirtyUI } from './shell-view.js';
import { refreshRunPlan } from './run-plan.js';
import { scheduleSelectionPreview } from './selection.js';
import { setView } from './navigation.js';
import { toast } from './feedback.js';
import { stateMutation } from './mutations.js';
import { openCaseEditor } from './case-editor.js';
import { openIO } from './case-io.js';

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
  scheduleSelectionPreview(0);
  setView('workbench');
  toast(`已选择 ${ids.length} 个 Case；点击工作台的运行按钮启动`, 'ok', 3000);
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

function renderCollectionNav() {
  const section = $('collection-section');
  if (!section) return;
  section.hidden = App.activeView !== 'cases';
  const list = $('collection-list');
  if (!list || !App.state) return;
  const allActive = !App.library.collectionId;
  const rows = [`
    <button type="button" class="collection-row ${allActive ? 'active' : ''}" data-collection-filter="">
      <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="3.5" width="10" height="13" rx="1.2"/><path d="M3.4 6v10.5h9"/></svg>
      <span class="collection-name">全部 Case</span>
      <span class="collection-count">${esc(String(App.state.cases.length))}</span>
    </button>`];
  for (const c of App.state.collections) {
    rows.push(`
      <button type="button" class="collection-row ${App.library.collectionId === c.id ? 'active' : ''}" data-collection-filter="${esc(c.id)}">
        <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.8 5.8h4l1.5 1.7h8.9v7.2a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4z"/></svg>
        <span class="collection-name" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="collection-count">${esc(String(c.case_ids.length))}</span>
      </button>`);
  }
  list.innerHTML = rows.join('');
}

export function bindLibraryEvents() {
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
}

export { renderCollectionNav, renderLibrary };
