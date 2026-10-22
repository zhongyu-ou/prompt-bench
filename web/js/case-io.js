import { App } from './state.js';
import { $, esc } from './utils.js';
import { caseById, collectionById } from './model.js';
import { apiPost, apiRaw } from './api.js';
import { applyMutationResult } from './mutations.js';
import { toast } from './feedback.js';
import { reloadFromServer } from './persistence.js';
import { setView } from './navigation.js';

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

function detectImportFormat(text, fileName = '') {
  if (App.io.inputFormat === 'package') return detectPackageFormat(text, fileName);
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'jsonl';
  }
}

function invalidateImportPreview() {
  App.io.previewGen += 1;
  App.io.preview = null;
  App.io.previewVersion = null;
  App.io.previewFingerprint = '';
  App.io.previewStale = false;
  App.io.recoverNeeded = false;
  App.io.expanded = false;
  App.io.error = '';
}

function ioFingerprint() {
  return JSON.stringify({ inputFormat: App.io.inputFormat, format: App.io.format, content: App.io.content, target: App.io.targetCollectionId });
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
  const raw = App.io.inputFormat === 'eve-vocat';
  $('io-input-format').value = App.io.inputFormat;
  $('io-paste-help').textContent = raw
    ? 'CurrentText 和 SourceLanguage 必填；PriorText、ReplacementMap 缺省为空。支持对象、对象数组或每行一个对象；ID 自动生成。'
    : '粘贴 Promptbench 导出的 JSON / JSONL 标准包，保留 Case ID 与集合记录。';
  $('io-paste-text').placeholder = raw
    ? '{"CurrentText":"法治的理念要得到践行。","PriorText":"问渠哪得清如许？为有源头活水来。\\n我是一个长期生活在书斋里的人。","ReplacementMap":"","SourceLanguage":"zh-CN"}'
    : '粘贴从 Promptbench 导出的标准包内容';
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
      ? `${App.io.preview ? `已解析 ${App.io.preview.cases.length} 条` : '待解析'} · ${App.io.format === 'jsonl' ? 'JSONL' : 'JSON'}${stale ? ' · 预览已过期' : ''}`
      : '粘贴内容，或选择 JSON / JSONL 文件';
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
      ? visible.map((row, index) => {
        const cells = ['SourceLanguage', 'CurrentText', 'PriorText', 'ReplacementMap'].map((key) => {
          const value = row.variables?.[key];
          const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
          return `<td><div class="io-preview-value">${esc(text)}</div></td>`;
        }).join('');
        const exists = row.status === 'existing';
        return `<tr><td class="mono">${index + 1}</td>${cells}<td class="${exists ? 'status-existing' : 'status-new'}">${exists ? '已存在' : '新增'}</td></tr>`;
      }).join('')
      : '<tr><td colspan="6"><div class="empty-state">粘贴内容或选择文件，解析后显示预览。</div></td></tr>';
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
  $('io-error').textContent = [App.io.error, ...warnings].filter(Boolean).join(' ');
  $('io-recover-btn').hidden = !App.io.recoverNeeded;
  $('io-recover-btn').disabled = App.io.busy || App.mutating;
  $('io-commit-btn').disabled = !preview || stale || App.io.busy || App.mutating;
  $('io-cancel-btn').disabled = App.io.busy || App.mutating;
  $('io-choose-file').disabled = App.io.busy || App.mutating;
  for (const id of ['io-input-format', 'io-paste-text', 'io-parse-paste', 'io-target-collection', 'io-file-input']) {
    $(id).disabled = App.io.busy || App.mutating;
  }
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

async function requestImportPreview({ format, inputFormat = App.io.inputFormat, content, fileName = '' } = {}) {
  const text = content !== undefined ? content : App.io.content;
  if (!text.trim()) {
    App.io.error = '请选择文件或粘贴 JSON / JSONL 内容。';
    renderIO();
    return;
  }
  App.io.inputFormat = inputFormat;
  const fmt = format || detectImportFormat(text, fileName || App.io.fileName);
  App.io.format = fmt;
  App.io.content = text;
  App.io.previewGen += 1;
  const gen = App.io.previewGen;
  const versionAtRequest = App.version;
  const fingerprint = ioFingerprint();
  App.io.busy = true;
  App.io.error = '解析中…';
  renderIO();
  try {
    const data = await apiPost('/api/cases/import/preview', {
      state_version: versionAtRequest,
      format: fmt,
      input_format: inputFormat,
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
    App.io.error = '';
  } catch (err) {
    if (gen !== App.io.previewGen) return;
    App.io.preview = null;
    App.io.previewVersion = null;
    App.io.previewFingerprint = '';
    App.io.previewStale = false;
    App.io.recoverNeeded = err.status === 409;
    App.io.error = err.status === 409
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
    App.io.error = App.io.recoverNeeded
      ? '服务端状态版本已变化；请重新载入并解析，文件与目标集合已保留。未提交任何内容。'
      : '预览内容或目标集合已变化；请重新解析后再确认导入。未提交任何内容。';
    renderIO();
    return;
  }
  const version = App.io.previewVersion;
  const format = App.io.format;
  const inputFormat = App.io.inputFormat;
  const content = App.io.content;
  const target = App.io.targetCollectionId;
  let refreshPreview = false;
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
          input_format: inputFormat,
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
        refreshPreview = true;
      });
    } catch (err) {
      if (err.status === 409) {
        App.io.previewStale = true;
        App.io.recoverNeeded = true;
        App.io.error = '导入预览已过期（409）；文件与目标集合已保留。请重新载入并解析后再导入；未写入任何 Case。';
      } else {
        App.io.recoverNeeded = false;
        App.io.error = `导入失败：${err.message}`;
      }
    } finally {
      App.io.busy = false;
      renderIO();
      if (refreshPreview) requestImportPreview({ format, inputFormat, content });
    }
  })();
}

async function recoverImportPreview() {
  if (App.io.busy || App.mutating) return;
  const content = App.io.content;
  const format = App.io.format;
  const inputFormat = App.io.inputFormat;
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
  await requestImportPreview({ format, inputFormat, content, fileName });
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

export function bindIOEvents() {
  $('io-choose-file').addEventListener('click', () => $('io-file-input').click());
  $('io-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || App.io.busy || App.mutating) return;
    invalidateImportPreview();
    const gen = App.io.previewGen;
    App.io.busy = true;
    renderIO();
    try {
      const content = await file.text();
      if (gen !== App.io.previewGen) return;
      App.io.fileName = file.name;
      App.io.content = content;
      $('io-paste-text').value = '';
      await requestImportPreview({ content, fileName: file.name });
    } catch (err) {
      if (gen === App.io.previewGen) App.io.error = `读取文件失败：${err.message}`;
    } finally {
      App.io.busy = false;
      e.target.value = '';
      renderIO();
    }
  });
  $('io-paste-text').addEventListener('input', (e) => {
    invalidateImportPreview();
    App.io.content = e.target.value;
    App.io.fileName = '粘贴内容';
    App.io.format = detectImportFormat(App.io.content);
    renderIO();
  });
  $('io-parse-paste').addEventListener('click', () => {
    if (App.io.busy || App.mutating) return;
    invalidateImportPreview();
    const text = $('io-paste-text').value;
    App.io.fileName = '粘贴内容';
    App.io.content = text;
    requestImportPreview({ content: text });
  });
  $('io-input-format').addEventListener('change', (e) => {
    invalidateImportPreview();
    App.io.inputFormat = e.target.value;
    App.io.format = detectImportFormat(App.io.content, App.io.fileName);
    renderIO();
    if (App.io.content.trim()) requestImportPreview();
  });
  $('io-target-collection').addEventListener('change', (e) => {
    const hadContent = !!App.io.content.trim();
    invalidateImportPreview();
    App.io.targetCollectionId = e.target.value;
    renderIO();
    if (hadContent) requestImportPreview();
  });
  $('io-expand').addEventListener('click', () => {
    App.io.expanded = !App.io.expanded;
    renderIO();
  });
  $('io-commit-btn').addEventListener('click', ioCommit);
  $('io-recover-btn').addEventListener('click', recoverImportPreview);
  $('io-cancel-btn').addEventListener('click', () => {
    invalidateImportPreview();
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
}

export { openIO, renderIO };
