import { App } from './state.js';
import { groupById, groupEditorDirty, markEdit, protocolLabel, providerById, resolveGroupTargets, templateById } from './model.js';
import { $, clone, esc, hasOwn, pretty, sourceLanguageOf, stableStringify } from './utils.js';
import { nextGroupDefaults, renderGroupCards, renderModelSuggestions } from './workbench-view.js';
import { setView } from './navigation.js';
import { ICON_TRASH, LANGUAGE_NAMES } from './constants.js';
import { refreshRunPlan, validateRoutes } from './run-plan.js';
import { renderTemplateEditor, renderTemplateMismatch, renderTemplateOptions } from './templates.js';
import { renderShell, updateDirtyUI } from './shell-view.js';
import { scheduleSelectionPreview } from './selection.js';
import { toast } from './feedback.js';

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
  renderTemplateOptions();
  renderTemplateEditor();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
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

function setActiveGroup(id) {
  const g = groupById(id);
  if (!g) return;
  App.activeGroupId = id;
  const bound = templateById(g.template_id);
  if (bound) {
    App.activeTemplateId = bound.id;
    App.activeMessageIndex = 0;
    renderTemplateOptions();
    renderTemplateEditor();
  }
  renderGroupCards();
  renderTemplateMismatch();
  renderShell();
}

function deleteGroup(id) {
  const g = groupById(id);
  if (!g) return;
  if (!window.confirm(`删除对照配置「${g.name || g.id}」？历史批次不受影响。`)) return;
  App.state.draft.groups = App.state.draft.groups.filter((x) => x.id !== id);
  if (App.activeGroupId === id) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
}

export function bindGroupEvents() {
  $('add-group-btn').addEventListener('click', () => {
    openGroupEditor(null);
  });
  $('group-cards').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-group-enabled]');
    if (!cb) return;
    const g = groupById(cb.dataset.groupEnabled);
    if (!g) return;
    g.enabled = cb.checked;
    renderGroupCards();
    updateDirtyUI();
    refreshRunPlan();
    scheduleSelectionPreview();
  });
  $('group-cards').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-group-edit]');
    if (edit) { setActiveGroup(edit.dataset.groupEdit); openGroupEditor(edit.dataset.groupEdit); return; }
    const select = e.target.closest('[data-group-select]');
    if (select) setActiveGroup(select.dataset.groupSelect);
  });
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
}

export { renderGroupEditor };
