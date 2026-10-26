import { App } from './state.js';
import { $, esc, stableStringify } from './utils.js';
import { caseById, collectionById } from './model.js';
import { apiPost, apiRaw } from './api.js';
import { applyMutationResult } from './mutations.js';
import { toast } from './feedback.js';
import { reloadFromServer } from './persistence.js';
import { setView } from './navigation.js';
import { previewCodeHtml } from './json-preview.js';

let savedTemplatesKey;
let savedTemplates = [];
let observedImportKey = '';
let observedImportBaseline;
let importTemplateChosen = false;
let fieldsRequest = null;
let templateInputsConflict = false;
let importOperation = null;

function savedImportTemplates() {
  if (savedTemplatesKey !== App.savedJson) {
    savedTemplatesKey = App.savedJson;
    savedTemplates = App.savedJson ? JSON.parse(App.savedJson).templates || [] : [];
  }
  return savedTemplates;
}

function importTemplateError() {
  const templates = savedImportTemplates();
  if (!templates.length) return '请先创建并保存模板';
  const saved = templates.find((t) => t.id === App.io.templateId);
  if (!saved) return '请选择已保存的模板';
  const local = App.state.templates.find((t) => t.id === saved.id);
  if (!local || local.name !== saved.name || stableStringify(local.messages) !== stableStringify(saved.messages)) {
    return '请先保存模板再检查数据';
  }
  return '';
}

function syncImportState() {
  const templates = savedImportTemplates();
  if (App.io.templateId && !templates.some((t) => t.id === App.io.templateId)) {
    App.io.templateId = '';
    importTemplateChosen = true;
  }
  const raw = App.io.inputFormat === 'variables';
  const local = raw ? App.state.templates.find((t) => t.id === App.io.templateId) : null;
  const key = stableStringify([App.version, App.io.inputFormat, raw ? App.io.templateId : '', local?.name, local?.messages]);
  if (key === observedImportKey && observedImportBaseline === App.savedJson) return;
  observedImportKey = key;
  observedImportBaseline = App.savedJson;
  App.io.templateInputsGen += 1;
  App.io.templateInputs = null;
  App.io.templateInputsBusy = false;
  App.io.templateInputsError = '';
  templateInputsConflict = false;
  fieldsRequest = null;
  invalidateImportPreview();
}

async function refreshImportTemplateInputs() {
  syncImportState();
  if (App.io.inputFormat !== 'variables') return true;
  const error = importTemplateError();
  if (error) {
    App.io.templateInputsError = error;
    renderIO();
    return false;
  }
  if (App.io.templateInputs) return true;
  if (fieldsRequest) return fieldsRequest.promise;
  const gen = ++App.io.templateInputsGen;
  const version = App.version;
  const templateId = App.io.templateId;
  const baseline = App.savedJson;
  const current = () => gen === App.io.templateInputsGen && version === App.version
    && templateId === App.io.templateId && baseline === App.savedJson
    && App.io.inputFormat === 'variables' && !importTemplateError();
  App.io.templateInputsBusy = true;
  App.io.templateInputsError = '';
  const request = {};
  fieldsRequest = request;
  request.promise = (async () => {
    try {
      const data = await apiPost('/api/templates/inputs', { state_version: version, template_id: templateId });
      if (!current()) return false;
      App.io.templateInputs = data;
      templateInputsConflict = false;
      App.io.recoverNeeded = false;
      return true;
    } catch (err) {
      if (current()) {
        if (err.status === 409) {
          templateInputsConflict = true;
          App.io.recoverNeeded = true;
        }
        App.io.templateInputsError = err.status === 409
          ? '输入字段读取冲突：服务端状态版本已变化（409）。文件、模板与目标集合已保留；请重新载入并解析。'
          : `输入字段读取失败：${err.message}`;
      }
      return false;
    } finally {
      if (fieldsRequest === request) {
        fieldsRequest = null;
        App.io.templateInputsBusy = false;
        renderIO();
      }
    }
  })();
  renderIO();
  return request.promise;
}

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
  if (importOperation && ['preview', 'file'].includes(importOperation.kind)) {
    importOperation = null;
    App.io.busy = false;
  }
  App.io.previewGen += 1;
  App.io.preview = null;
  App.io.previewVersion = null;
  App.io.previewFingerprint = '';
  App.io.previewStale = false;
  // Editing import content does not resolve a field lookup's version conflict.
  App.io.recoverNeeded = templateInputsConflict;
  App.io.expanded = false;
  App.io.jsonRows.clear();
  App.io.error = '';
}

function ioFingerprint() {
  return JSON.stringify({ inputFormat: App.io.inputFormat, templateId: App.io.inputFormat === 'variables' ? App.io.templateId : '', format: App.io.format, content: App.io.content, target: App.io.targetCollectionId });
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
  syncImportState();
  const raw = App.io.inputFormat === 'variables';
  const templateError = raw ? importTemplateError() : '';
  $('io-input-format').value = App.io.inputFormat;
  $('io-template-controls').hidden = !raw;
  const templates = savedImportTemplates();
  $('io-template').innerHTML = '<option value="">请选择模板</option>' + templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('io-template').value = App.io.templateId;
  const inputs = App.io.templateInputs;
  $('io-template-fields').textContent = templateError || App.io.templateInputsError
    || (App.io.templateInputsBusy ? '读取输入字段中…'
      : inputs ? `输入字段：${inputs.keys.length ? inputs.keys.join('、') : '无静态字段'}${inputs.dynamic ? ' · 含动态引用，字段列表不完整' : ''}` : '检查数据时读取模板输入字段。');
  $('io-copy-example').disabled = !raw || !inputs || !!templateError || App.io.templateInputsBusy;
  $('io-paste-help').textContent = raw
    ? '支持对象、对象数组或每行一个对象；ID 自动生成。未提供的文本变量按空内容渲染；列表或对象请填写实际结构。'
    : '粘贴 Promptbench 导出的 JSON / JSONL 标准包，保留 Case ID 与集合记录。';
  $('io-paste-text').placeholder = raw ? '{"text":"输入内容"}' : '粘贴从 Promptbench 导出的标准包内容';
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
  const rows = preview ? preview.cases : [];
  const inputKeys = raw ? preview?.input_keys || inputs?.keys || [] : [];
  const extraKeys = new Set(rows.flatMap((row) => Object.keys(row.variables || {})));
  inputKeys.forEach((key) => extraKeys.delete(key));
  const keys = [...inputKeys, ...[...extraKeys].sort()];
  const columnCount = keys.length + 3;
  $('io-preview-head').innerHTML = `<th scope="col">#</th>${keys.map((key) => `<th scope="col">${esc(key)}</th>`).join('')}<th scope="col">状态</th><th scope="col">JSON</th>`;
  const body = $('io-preview-body');
  if (body) {
    const visible = App.io.expanded ? rows : rows.slice(0, 6);
    body.innerHTML = visible.length
      ? visible.map((row, index) => {
        const cells = keys.map((key) => {
          const variables = row.variables || {};
          const value = variables[key];
          const text = !Object.hasOwn(variables, key) ? '—' : typeof value === 'string' ? value
            : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          return `<td><div class="io-preview-value">${esc(text)}</div></td>`;
        }).join('');
        const exists = row.status === 'existing';
        const expanded = App.io.jsonRows.has(row.file_id);
        const detail = expanded ? `<tr class="io-json-detail"><td colspan="${columnCount}">${previewCodeHtml(row.variables_json, '无 JSON 内容')}</td></tr>` : '';
        return `<tr><td class="mono">${index + 1}</td>${cells}<td class="${exists ? 'status-existing' : 'status-new'}">${exists ? '已存在' : '新增'}</td><td><button type="button" class="btn ghost small" data-io-json="${esc(row.file_id)}" aria-expanded="${expanded}">JSON</button></td></tr>${detail}`;
      }).join('')
      : `<tr><td colspan="${columnCount}"><div class="empty-state">粘贴内容或选择文件，解析后显示预览。</div></td></tr>`;
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
  $('io-recover-btn').disabled = App.io.busy || App.mutating || App.io.templateInputsBusy;
  $('io-commit-btn').disabled = !preview || stale || !!templateError || App.io.templateInputsBusy || App.io.busy || App.mutating;
  $('io-cancel-btn').disabled = App.io.busy || App.mutating;
  $('io-choose-file').disabled = App.io.busy || App.mutating;
  for (const id of ['io-input-format', 'io-template', 'io-paste-text', 'io-parse-paste', 'io-target-collection', 'io-file-input']) {
    $(id).disabled = App.io.busy || App.mutating;
  }
  $('io-parse-paste').disabled ||= !!templateError || App.io.templateInputsBusy;
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
  syncImportState();
  if (App.io.busy || App.mutating || App.io.templateInputsBusy) return;
  if (inputFormat !== App.io.inputFormat) return;
  if (inputFormat === 'variables' && importTemplateError()) {
    App.io.templateInputsError = importTemplateError();
    renderIO();
    return;
  }
  const text = content !== undefined ? content : App.io.content;
  if (!text.trim()) {
    App.io.error = '请选择文件或粘贴 JSON / JSONL 内容。';
    renderIO();
    return;
  }
  const fmt = format || detectImportFormat(text, fileName || App.io.fileName);
  App.io.format = fmt;
  App.io.content = text;
  invalidateImportPreview();
  const gen = App.io.previewGen;
  const version = App.version;
  const fingerprint = ioFingerprint();
  const templateId = App.io.templateId;
  const target = App.io.targetCollectionId;
  const current = () => gen === App.io.previewGen && version === App.version
    && fingerprint === ioFingerprint() && (inputFormat !== 'variables' || !importTemplateError());
  if (!await refreshImportTemplateInputs() || !current()) return;
  const operation = { kind: 'preview' };
  importOperation = operation;
  App.io.busy = true;
  App.io.error = '解析中…';
  renderIO();
  try {
    const data = await apiPost('/api/cases/import/preview', {
      state_version: version,
      format: fmt,
      input_format: inputFormat,
      ...(inputFormat === 'variables' ? { template_id: templateId } : {}),
      content: text,
      collection_ids: target ? [target] : []
    });
    if (!current()) return;
    App.io.preview = data;
    App.io.previewVersion = Number.isFinite(Number(data.state_version)) ? Number(data.state_version) : version;
    App.io.previewFingerprint = fingerprint;
    App.io.previewStale = false;
    App.io.recoverNeeded = false;
    App.io.expanded = false;
    App.io.jsonRows.clear();
    App.io.error = '';
  } catch (err) {
    if (!current()) return;
    App.io.preview = null;
    App.io.previewVersion = null;
    App.io.previewFingerprint = '';
    App.io.previewStale = false;
    App.io.recoverNeeded = err.status === 409;
    App.io.error = err.status === 409
      ? '预览冲突：服务端状态版本已变化（409）。文件、模板与目标集合已保留；请重新载入并解析。'
      : `预览失败：${err.message}`;
  } finally {
    if (importOperation === operation) {
      importOperation = null;
      App.io.busy = false;
      renderIO();
    }
  }
}

async function ioCommit() {
  syncImportState();
  if (!App.io.preview || App.io.busy || App.mutating || App.io.templateInputsBusy) return;
  if (App.io.inputFormat === 'variables' && importTemplateError()) {
    App.io.templateInputsError = importTemplateError();
    renderIO();
    return;
  }
  if (ioPreviewStale()) {
    App.io.recoverNeeded = App.io.previewVersion !== null && App.io.previewVersion !== App.version;
    App.io.error = App.io.recoverNeeded
      ? '服务端状态版本已变化；请重新载入并解析，文件与目标集合已保留。未提交任何内容。'
      : '预览内容、模板或目标集合已变化；请重新解析后再确认导入。未提交任何内容。';
    renderIO();
    return;
  }
  const version = App.io.previewVersion;
  const format = App.io.format;
  const inputFormat = App.io.inputFormat;
  const templateId = App.io.templateId;
  const content = App.io.content;
  const target = App.io.targetCollectionId;
  const fingerprint = ioFingerprint();
  const previewGen = App.io.previewGen;
  const editGen = App.editGeneration;
  const operation = { kind: 'commit' };
  const current = () => previewGen === App.io.previewGen && version === App.version
    && fingerprint === ioFingerprint() && (inputFormat !== 'variables' || !importTemplateError());
  let refreshPreview = false;
  importOperation = operation;
  App.io.busy = true;
  renderIO();
  try {
    const { payload } = await apiRaw('/api/cases/import', {
      method: 'POST',
      body: {
        state_version: version,
        format,
        input_format: inputFormat,
        ...(inputFormat === 'variables' ? { template_id: templateId } : {}),
        content,
        collection_ids: target ? [target] : []
      }
    });
    const adoptPreview = current();
    // A committed mutation must update the authoritative resources even if the
    // local import view changed; only matching input may receive a new preview.
    applyMutationResult(payload.state, payload, editGen, (_state, result) => {
      if (!adoptPreview) return;
      invalidateImportPreview();
      toast(`导入完成：新增 ${result?.new_count ?? 0}，复用 ${result?.existing_count ?? 0}`, 'ok', 5000);
      refreshPreview = true;
    });
  } catch (err) {
    if (!current()) return;
    if (err.status === 409) {
      App.io.previewStale = true;
      App.io.recoverNeeded = true;
      App.io.error = '导入预览已过期（409）；文件、模板与目标集合已保留。请重新载入并解析后再导入；未写入任何 Case。';
    } else {
      App.io.recoverNeeded = false;
      App.io.error = `导入失败：${err.message}`;
    }
  } finally {
    if (importOperation === operation) {
      importOperation = null;
      App.io.busy = false;
      renderIO();
      if (refreshPreview && fingerprint === ioFingerprint()) requestImportPreview({ format, inputFormat, content });
    }
  }
}

async function recoverImportPreview() {
  savedImportTemplates();
  if (App.io.busy || App.mutating || App.io.templateInputsBusy) return;
  const fingerprint = ioFingerprint();
  const templateId = App.io.templateId;
  const inputFormat = App.io.inputFormat;
  const operation = { kind: 'recover' };
  importOperation = operation;
  App.io.busy = true;
  renderIO();
  const ok = await reloadFromServer();
  if (importOperation !== operation) return;
  importOperation = null;
  App.io.busy = false;
  if (!ok) {
    renderIO();
    return;
  }
  syncImportState();
  if (inputFormat === 'variables' && (!savedImportTemplates().some((t) => t.id === templateId)
    || App.io.templateId !== templateId || importTemplateError())) {
    invalidateImportPreview();
    App.io.templateInputsError = importTemplateError() || '原模板已失效，请重新选择已保存的模板';
    renderIO();
    return;
  }
  if (fingerprint !== ioFingerprint()) {
    renderIO();
    return;
  }
  templateInputsConflict = false;
  App.io.recoverNeeded = false;
  const version = App.version;
  if (!await refreshImportTemplateInputs() || version !== App.version || fingerprint !== ioFingerprint()) return;
  if (App.io.content.trim()) await requestImportPreview();
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
  syncImportState();
  if (!importTemplateChosen) {
    const templates = savedImportTemplates();
    const preferred = templates.find((t) => t.id === App.activeTemplateId) || templates[0];
    if (preferred) {
      App.io.templateId = preferred.id;
      importTemplateChosen = true;
    }
  }
  setView('case-io');
  refreshImportTemplateInputs();
}

export function bindIOEvents() {
  $('io-choose-file').addEventListener('click', () => $('io-file-input').click());
  $('io-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    syncImportState();
    if (!file || App.io.busy || App.mutating) return;
    if (App.io.inputFormat === 'variables' && importTemplateError()) {
      App.io.templateInputsError = importTemplateError();
      renderIO();
      return;
    }
    invalidateImportPreview();
    const gen = App.io.previewGen;
    const version = App.version;
    const fingerprint = ioFingerprint();
    const operation = { kind: 'file' };
    importOperation = operation;
    App.io.busy = true;
    renderIO();
    try {
      const content = await file.text();
      if (gen !== App.io.previewGen || version !== App.version || fingerprint !== ioFingerprint()) return;
      App.io.fileName = file.name;
      App.io.content = content;
      $('io-paste-text').value = '';
      renderIO();
      importOperation = null;
      App.io.busy = false;
      await requestImportPreview({ content, fileName: file.name });
    } catch (err) {
      if (gen === App.io.previewGen) App.io.error = `读取文件失败：${err.message}`;
    } finally {
      if (importOperation === operation) {
        importOperation = null;
        App.io.busy = false;
        renderIO();
      }
    }
  });
  $('io-paste-text').addEventListener('input', (e) => {
    invalidateImportPreview();
    App.io.content = e.target.value;
    App.io.fileName = '粘贴内容';
    App.io.format = detectImportFormat(App.io.content);
    renderIO();
  });
  $('io-parse-paste').addEventListener('click', () => requestImportPreview());
  const refreshChangedContext = async () => {
    renderIO();
    const fingerprint = ioFingerprint();
    const version = App.version;
    if (await refreshImportTemplateInputs() && version === App.version
      && fingerprint === ioFingerprint() && App.io.content.trim()) requestImportPreview();
  };
  $('io-input-format').addEventListener('change', (e) => {
    if (App.io.busy || App.mutating) return;
    invalidateImportPreview();
    App.io.inputFormat = e.target.value;
    App.io.format = detectImportFormat(App.io.content, App.io.fileName);
    refreshChangedContext();
  });
  $('io-template').addEventListener('change', (e) => {
    if (App.io.busy || App.mutating) return;
    invalidateImportPreview();
    App.io.templateId = e.target.value;
    importTemplateChosen = true;
    refreshChangedContext();
  });
  $('io-copy-example').addEventListener('click', async () => {
    syncImportState();
    if (App.io.inputFormat !== 'variables' || importTemplateError()
      || App.io.templateInputsBusy || !App.io.templateInputs) return;
    try {
      await navigator.clipboard.writeText(App.io.templateInputs.example_json);
      toast('字段 JSON 已复制；列表或对象请填写实际结构', 'ok');
    } catch {
      toast('复制失败：剪贴板不可用或权限被拒绝。', 'error');
    }
  });
  $('io-preview-body').addEventListener('click', (e) => {
    const button = e.target.closest('[data-io-json]');
    if (!button) return;
    const id = button.dataset.ioJson;
    if (App.io.jsonRows.has(id)) App.io.jsonRows.delete(id);
    else App.io.jsonRows.add(id);
    renderIO();
  });
  $('io-target-collection').addEventListener('change', (e) => {
    if (App.io.busy || App.mutating) return;
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
    if (App.io.busy || App.mutating) return;
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
