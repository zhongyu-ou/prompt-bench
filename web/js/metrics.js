import { App } from './state.js';
import { apiPost } from './api.js';
import { $, clone, esc, stableStringify } from './utils.js';
import { toast } from './feedback.js';
import { setView } from './navigation.js';
import { saveState } from './persistence.js';
import { computeRunPlan, refreshRunPlan } from './run-plan.js';
import { updateDirtyUI } from './shell-view.js';
import {
  credentialMeta, markEdit, metricById, metricEditorDirty, metricProviderIssue,
  newMetricId, normalizeMetric, providerById, providersWithCapability, protocolCapabilityLabels
} from './model.js';
import { METRIC_KIND_LABELS, METRIC_RETURN_LABELS } from './constants.js';
import { metricTypeLabel, outcomeHtml } from './evaluation.js';

const DEFAULT_METRIC_MODEL = 'jev-latest';
const DEFAULT_TRIAL_OUTPUT = '{"corrected_text":"总书记向广大劳动群众致以节日祝贺和诚挚慰问。","en":"General Secretary extended holiday greetings and sincere regards to the working people."}';

function resetTrial() {
  App.metricTrial = { targetMode: 'output', pointer: '', input: DEFAULT_TRIAL_OUTPUT, result: null, error: '' };
}

function firstDecisionProviderId() {
  return providersWithCapability('decision')[0]?.id || '';
}

function newMetricWorking(kind) {
  return {
    id: newMetricId(),
    name: '',
    kind,
    return_type: 'boolean',
    rule: '',
    code: '',
    provider_id: kind === 'model' ? firstDecisionProviderId() : '',
    model: kind === 'model' ? DEFAULT_METRIC_MODEL : '',
    threshold: 0.5,
    levels: ['', ''],
    labels: [{ label: '', description: '' }, { label: '', description: '' }]
  };
}

function openMetricEditor(id, { confirmDiscard = true } = {}) {
  const metric = metricById(id);
  if (!metric) return;
  if (confirmDiscard && metricEditorDirty() && App.metricEditor?.id !== id) {
    if (!window.confirm('当前指标有未保存的更改。放弃并切换？')) return;
  }
  const working = normalizeMetric(clone(metric));
  App.metricEditor = {
    mode: 'edit',
    id: working.id,
    working,
    baseline: stableStringify(working),
    error: '',
    busy: false
  };
  resetTrial();
  renderMetricsView();
}

function startNewMetric(kind) {
  if (metricEditorDirty() && !window.confirm('当前指标有未保存的更改。放弃并新建？')) return;
  const working = normalizeMetric(newMetricWorking(kind));
  App.metricEditor = {
    mode: 'create',
    id: working.id,
    working,
    baseline: stableStringify(working),
    error: '',
    busy: false
  };
  resetTrial();
  renderMetricsView();
}

function ensureMetricEditor() {
  const metrics = App.state?.metrics || [];
  if (!App.metricEditor && metrics.length) {
    const working = normalizeMetric(clone(metrics[0]));
    App.metricEditor = {
      mode: 'edit',
      id: working.id,
      working,
      baseline: stableStringify(working),
      error: '',
      busy: false
    };
    resetTrial();
  }
  if (App.metricEditor && App.metricEditor.mode === 'edit' && !metricById(App.metricEditor.id)) {
    App.metricEditor = null;
  }
}

function updateMetricSaveUi() {
  const el = $('metric-save-state');
  const btn = $('metric-save-btn');
  if (!el || !btn) return;
  if (!App.metricEditor) {
    el.textContent = '管理可在批次中复用的判断规则';
    btn.disabled = true;
    return;
  }
  const dirty = metricEditorDirty();
  const create = App.metricEditor.mode === 'create';
  el.textContent = dirty || create ? '指标有未保存更改' : '指标已保存';
  el.classList.toggle('dirty', dirty || create);
  btn.disabled = App.metricEditor.busy || App.saving || App.mutating || (!dirty && !create);
}

function renderMetricsView() {
  if (!App.state || !$('metric-list')) return;
  ensureMetricEditor();
  const metrics = App.state.metrics;
  $('metric-count').textContent = String(metrics.length);
  const query = String(App.metricSearch || '').trim().toLowerCase();
  const filtered = query
    ? metrics.filter((m) => `${m.name} ${m.rule} ${m.kind} ${m.return_type}`.toLowerCase().includes(query))
    : metrics;
  const list = $('metric-list');
  if (!metrics.length) {
    list.innerHTML = `<div class="metrics-empty-body">
      <strong>还没有指标</strong>
      <span>添加代码规则或模型判断，用来评估每次生成的输出。</span>
      <div class="btn-row">
        <button type="button" class="btn primary" data-metric-new="code">新建代码指标</button>
        <button type="button" class="btn" data-metric-new="model">新建模型指标</button>
      </div>
    </div>`;
  } else if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">没有匹配的指标。</div>';
  } else {
    list.innerHTML = filtered.map((m) => {
      const active = App.metricEditor?.id === m.id;
      const selected = App.state.draft.metrics.some((ref) => ref.metric_id === m.id);
      return `<button type="button" class="metric-list-item${active ? ' active' : ''}" data-metric-id="${esc(m.id)}" aria-pressed="${active}">
        <span class="metric-list-name">${esc(m.name || '未命名指标')}</span>
        <span class="metric-list-meta">${esc(metricTypeLabel(m))}${selected ? ' · 已选' : ''}</span>
      </button>`;
    }).join('');
  }
  renderMetricEditor();
  updateMetricSaveUi();
}

function setEditorValue(id, value) {
  const el = $(id);
  if (el && document.activeElement !== el) el.value = value;
}

function providerOptionsHtml(selectedId) {
  const providers = providersWithCapability('decision');
  const options = providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} · ${esc(protocolCapabilityLabels(p.protocol).join(' / '))}</option>`);
  if (selectedId && !providers.some((p) => p.id === selectedId)) {
    const existing = providerById(selectedId);
    options.unshift(`<option value="${esc(selectedId)}" disabled>${esc(existing ? `${existing.name || existing.id}（不可用于决策）` : 'Provider 缺失')}</option>`);
  }
  return options.length ? options.join('') : '<option value="">（无决策评估 Provider）</option>';
}

function levelsHtml(working) {
  const levels = Array.isArray(working.levels) ? working.levels : [];
  return levels.map((level, index) => `<div class="level-row">
    <span class="level-index mono">${index}</span>
    <input class="input" type="text" value="${esc(level)}" data-level-index="${index}" aria-label="等级 ${index} 描述" placeholder="等级描述">
    <button type="button" class="mini-btn danger" data-level-remove="${index}" aria-label="移除等级 ${index}" ${levels.length <= 2 ? 'disabled' : ''}>×</button>
  </div>`).join('');
}

function labelsHtml(working) {
  const labels = Array.isArray(working.labels) ? working.labels : [];
  return labels.map((label, index) => `<div class="label-row">
    <div class="field"><span>标签</span><input class="input mono" type="text" value="${esc(label.label)}" data-label-index="${index}" data-label-field="label" aria-label="分类标签 ${index + 1}"></div>
    <div class="field"><span>描述</span><input class="input" type="text" value="${esc(label.description)}" data-label-index="${index}" data-label-field="description" aria-label="分类标签 ${index + 1} 描述"></div>
    <button type="button" class="mini-btn danger" data-label-remove="${index}" aria-label="移除标签 ${index + 1}" ${labels.length <= 2 ? 'disabled' : ''}>×</button>
  </div>`).join('');
}

function renderMetricEditor() {
  const editor = App.metricEditor;
  const empty = $('metric-editor-empty');
  const host = $('metric-editor');
  if (!empty || !host) return;
  if (!editor) {
    empty.hidden = false;
    host.hidden = true;
    return;
  }
  empty.hidden = true;
  host.hidden = false;
  const w = editor.working;
  $('metric-editor-title').textContent = w.name || (editor.mode === 'create' ? '新建指标' : '未命名指标');
  $('metric-editor-type-tag').textContent = metricTypeLabel(w);
  $('metric-delete-btn').hidden = editor.mode !== 'edit';
  setEditorValue('metric-editor-name', w.name);
  setEditorValue('metric-editor-kind', w.kind);
  setEditorValue('metric-editor-return', w.return_type);
  setEditorValue('metric-rule', w.rule);
  setEditorValue('metric-code', w.code || '');
  setEditorValue('metric-model', w.model || '');
  setEditorValue('metric-threshold', Number.isFinite(Number(w.threshold)) ? String(w.threshold) : '0.5');
  const provider = $('metric-provider');
  if (provider) {
    provider.innerHTML = providerOptionsHtml(w.provider_id);
    provider.value = w.provider_id || '';
  }
  $('metric-code-section').hidden = w.kind !== 'code';
  $('metric-model-section').hidden = w.kind !== 'model';
  $('metric-bool-section').hidden = !(w.kind === 'model' && w.return_type === 'boolean');
  $('metric-number-section').hidden = !(w.kind === 'model' && w.return_type === 'number');
  $('metric-labels-section').hidden = w.return_type !== 'classification';
  $('metric-trial-section').hidden = w.kind !== 'code';
  $('metric-levels').innerHTML = levelsHtml(w);
  $('metric-labels').innerHTML = labelsHtml(w);
  const proto = providerById(w.provider_id) ? providerById(w.provider_id).protocol : '';
  $('metric-provider-hint').textContent = w.kind === 'model'
    ? (proto ? `决策能力：${protocolCapabilityLabels(proto).join(' / ') || '未知'}。JEV 仅用于模型指标，不参与文本生成。` : '选择支持决策评估的 Provider；JEV 只用于模型指标。')
    : '';
  $('metric-editor-error').textContent = editor.error || '';
  renderTrialUi();
}

function renderTrialUi() {
  const trial = App.metricTrial;
  const mode = $('metric-trial-target-mode');
  const pointerField = $('metric-trial-pointer-field');
  const pointer = $('metric-trial-pointer');
  const input = $('metric-trial-input');
  if (mode) mode.value = trial.targetMode;
  if (pointerField) pointerField.hidden = trial.targetMode !== 'json_pointer';
  if (pointer && document.activeElement !== pointer) pointer.value = trial.pointer;
  if (input && document.activeElement !== input) input.value = trial.input;
  const result = $('metric-trial-result');
  if (!result) return;
  if (trial.error) result.innerHTML = `<div class="preview-error">${esc(trial.error)}</div>`;
  else if (trial.result) {
    result.innerHTML = trial.result.status === 'completed'
      ? `<div class="metric-trial-ok"><div class="metric-trial-caption">试算结果</div>${outcomeHtml(trial.result, App.metricEditor?.working, { includeRaw: true })}</div>`
      : `<div class="metric-trial-err"><div class="metric-trial-caption">试算错误</div>${outcomeHtml(trial.result, App.metricEditor?.working, { includeRaw: true })}</div>`;
  } else {
    result.innerHTML = '<div class="muted small">试算只在本地请求中执行，不写入历史或真实 Case。</div>';
  }
}

function metricPayload(w) {
  const payload = {
    id: w.id,
    name: String(w.name || '').trim(),
    kind: w.kind,
    return_type: w.return_type,
    rule: String(w.rule || '').trim()
  };
  if (w.kind === 'code') {
    payload.code = w.code || '';
  } else {
    payload.provider_id = w.provider_id || '';
    payload.model = String(w.model || '').trim();
  }
  if (w.kind === 'model' && w.return_type === 'boolean') payload.threshold = Number(w.threshold);
  if (w.kind === 'model' && w.return_type === 'number') payload.levels = (Array.isArray(w.levels) ? w.levels : []).map((level) => String(level || '').trim());
  if (w.return_type === 'classification') {
    payload.labels = (Array.isArray(w.labels) ? w.labels : []).map((label) => ({
      label: String(label.label || '').trim(),
      description: String(label.description || '').trim()
    }));
  }
  return payload;
}

function validateMetricDraft(w) {
  const errors = [];
  const payload = metricPayload(w);
  if (!payload.name) errors.push('指标名称不能为空。');
  if (!payload.rule) errors.push('判断规则不能为空。');
  if (!payload.id || payload.id.trim() !== payload.id || payload.id.length > 128) errors.push('指标 ID 必须是 1–128 字符且不能有首尾空白。');
  if (new TextEncoder().encode(payload.rule).length > 65536) errors.push('判断规则超过 64 KiB。');
  if (w.kind === 'code') {
    if (!String(w.code || '').trim()) errors.push('JavaScript 函数不能为空。');
    if (new TextEncoder().encode(w.code || '').length > 65536) errors.push('JavaScript 函数超过 64 KiB。');
  } else {
    const provider = providerById(w.provider_id);
    if (!provider) errors.push('请选择存在的决策 Provider。');
    else if (!providersWithCapability('decision').some((p) => p.id === provider.id)) errors.push('该 Provider 不支持决策评估，不能用于模型指标。');
    if (!payload.model) errors.push('模型版本不能为空。');
    if (w.return_type === 'boolean') {
      if (!Number.isFinite(payload.threshold) || payload.threshold < 0 || payload.threshold > 1) errors.push('true 概率阈值必须是 0–1 的数值。');
    }
    if (w.return_type === 'number') {
      if (payload.levels.length < 2 || payload.levels.length > 10) errors.push('数值指标需要 2–10 个等级。');
      if (payload.levels.some((level) => !level)) errors.push('每个数值等级都需要非空描述。');
    }
  }
  if (w.return_type === 'classification') {
    if (payload.labels.length < 2 || payload.labels.length > 100) errors.push('分类指标需要 2–100 个标签。');
    const seen = new Set();
    for (const label of payload.labels) {
      if (!label.label) { errors.push('分类标签不能为空。'); continue; }
      if (new TextEncoder().encode(label.label).length > 256) errors.push(`分类标签「${label.label}」超过 256 字节。`);
      if (seen.has(label.label)) errors.push(`分类标签「${label.label}」重复。`);
      seen.add(label.label);
      if (w.kind === 'model' && !label.description) errors.push(`分类标签「${label.label}」需要描述。`);
    }
  }
  return { errors, payload };
}

async function saveMetricEditor() {
  const editor = App.metricEditor;
  if (!editor || editor.busy || App.saving || App.mutating) return;
  const { errors, payload } = validateMetricDraft(editor.working);
  if (errors.length) {
    editor.error = errors.join(' ');
    renderMetricEditor();
    return;
  }
  editor.busy = true;
  editor.error = '';
  let stagedCreate = false;
  renderMetricsView();
  try {
    if (editor.mode === 'edit') {
      const index = App.state.metrics.findIndex((m) => m.id === payload.id);
      if (index < 0) throw new Error('指标已不存在，请重新载入。');
      App.state.metrics[index] = normalizeMetric(payload);
    } else {
      if (App.state.metrics.some((m) => m.id === payload.id)) throw new Error('指标 ID 冲突，请重试新建。');
      App.state.metrics.push(normalizeMetric(payload));
      stagedCreate = true;
    }
    markEdit();
    const ok = await saveState({ silent: true });
    if (!ok) {
      if (stagedCreate) App.state.metrics = App.state.metrics.filter((m) => m.id !== payload.id);
      editor.error = '保存失败，更改尚未提交。请检查页面错误提示后重试。';
      return;
    }
    const saved = metricById(payload.id);
    if (saved) {
      editor.mode = 'edit';
      editor.id = saved.id;
      editor.working = normalizeMetric(clone(saved));
      editor.baseline = stableStringify(editor.working);
    }
    toast('指标已保存', 'ok');
  } catch (err) {
    if (stagedCreate) App.state.metrics = App.state.metrics.filter((m) => m.id !== payload.id);
    editor.error = `保存指标失败：${err.message}`;
  } finally {
    editor.busy = false;
    renderMetricsView();
  }
}

async function deleteMetricEditor() {
  const editor = App.metricEditor;
  if (!editor || editor.mode !== 'edit') return;
  const metric = metricById(editor.id);
  if (!metric) return;
  const selected = App.state.draft.metrics.some((ref) => ref.metric_id === metric.id);
  const note = selected ? '\n\n该指标已选，会同时从选择中移除。' : '';
  if (!window.confirm(`删除指标「${metric.name || metric.id}」？${note}\n\n已保存的历史批次与冻结快照不受影响；不会对历史重新评估。`)) return;
  const removed = metric.id;
  App.state.metrics = App.state.metrics.filter((m) => m.id !== removed);
  App.state.draft.metrics = App.state.draft.metrics.filter((ref) => ref.metric_id !== removed);
  App.metricEditor = null;
  markEdit();
  renderMetricsView();
  refreshRunPlan();
  const ok = await saveState({ silent: true });
  if (ok) toast('指标已删除', 'ok');
}

function renderMetricSelection() {
  const host = $('metric-pick-list');
  if (!host || !App.state) return;
  const metrics = App.state.metrics;
  const refs = App.state.draft.metrics;
  if (!metrics.length) {
    host.innerHTML = `<div class="metric-pick-empty">
      <div class="btn-row">
        <button type="button" class="btn tiny primary" data-metric-new="code">新建代码指标</button>
        <button type="button" class="btn tiny" data-metric-new="model">新建模型指标</button>
      </div>
    </div>`;
  } else {
    host.innerHTML = metrics.map((metric) => {
      const ref = refs.find((item) => item.metric_id === metric.id);
      const checked = !!ref;
      const target = ref?.target || { mode: 'output', pointer: '' };
      const issue = checked ? metricProviderIssue(metric) : { error: '', warning: '' };
      return `<div class="metric-pick-row${checked ? ' checked' : ''}" data-metric-row="${esc(metric.id)}">
        <label class="metric-pick-check">
          <input type="checkbox" data-metric-pick="${esc(metric.id)}" ${checked ? 'checked' : ''} aria-label="选择指标 ${esc(metric.name || metric.id)}">
          <span class="metric-pick-name">${esc(metric.name || '未命名指标')}</span>
          <span class="metric-kind-tag ${esc(metric.kind)}">${esc(METRIC_KIND_LABELS[metric.kind] || metric.kind)}</span>
          <span class="metric-return-tag">${esc(METRIC_RETURN_LABELS[metric.return_type] || metric.return_type)}</span>
        </label>
        ${checked ? `<div class="metric-target-row">
          <label class="inline-field"><span>评估对象</span>
            <select class="input select compact" data-metric-target-mode="${esc(metric.id)}" aria-label="指标 ${esc(metric.name || metric.id)} 的评估对象">
              <option value="output" ${target.mode === 'output' ? 'selected' : ''}>整段输出</option>
              <option value="json_pointer" ${target.mode === 'json_pointer' ? 'selected' : ''}>JSON Pointer</option>
            </select>
          </label>
          ${target.mode === 'json_pointer' ? `<label class="inline-field metric-pointer-field"><span>Pointer</span><input class="input compact mono" type="text" value="${esc(target.pointer)}" data-metric-pointer="${esc(metric.id)}" placeholder="/en（留空为根）" aria-label="指标 ${esc(metric.name || metric.id)} 的 JSON Pointer"></label>` : ''}
        </div>` : ''}
        ${issue.error ? `<div class="metric-issue error" role="alert">${esc(issue.error)}：${esc(metric.name || metric.id)} 暂不可用。<button type="button" class="link-btn" data-metric-fix-provider="${esc(metric.id)}">配置 Provider</button><button type="button" class="link-btn" data-metric-unpick="${esc(metric.id)}">取消该指标</button></div>` : ''}
        ${issue.warning ? `<div class="metric-issue warn">${esc(issue.warning)}：${esc(metric.name || metric.id)}。</div>` : ''}
      </div>`;
    }).join('');
    const dangling = refs.filter((ref) => !metricById(ref.metric_id));
    if (dangling.length) {
      host.innerHTML += dangling.map((ref) => `<div class="metric-issue error" role="alert">所选指标「${esc(ref.metric_id)}」已不存在。<button type="button" class="link-btn" data-metric-unpick="${esc(ref.metric_id)}">移除选择</button></div>`).join('');
    }
  }
  const plan = computeRunPlan();
  const budget = $('metric-budget');
  if (budget) {
    if (!refs.length) {
      budget.textContent = '';
    } else if (plan.modelCount) {
      budget.textContent = `已选 ${refs.length} 项指标 · 生成后最多 ${plan.maxModelCalls} 次模型评估调用`;
    } else {
      budget.textContent = `已选 ${refs.length} 项代码指标 · 无模型评估调用`;
    }
  }
}

function addMetricSelection(id) {
  if (App.state.draft.metrics.some((ref) => ref.metric_id === id)) return;
  App.state.draft.metrics.push({ metric_id: id, target: { mode: 'output', pointer: '' } });
  markEdit();
  updateDirtyUI();
  renderMetricSelection();
  refreshRunPlan();
}

function removeMetricSelection(id) {
  App.state.draft.metrics = App.state.draft.metrics.filter((ref) => ref.metric_id !== id);
  markEdit();
  updateDirtyUI();
  renderMetricSelection();
  refreshRunPlan();
}

function buildAiPrompt(metric) {
  const type = metric.return_type;
  const valueContract = type === 'boolean'
    ? '布尔值 true / false'
    : type === 'number'
      ? '有限数值（Number.isFinite(value) 必须为 true）'
      : '字符串标签（必须来自下面列出的固定标签）';
  const reasonContract = type === 'boolean'
    ? "可选 reason：用一句中文说明判断依据，例如 '发现汉字字符'。"
    : '不要伪造原因。';
  const labels = type === 'classification'
    ? `\n固定分类标签：\n${(metric.labels || []).map((label) => `- ${label.label}${label.description ? `：${label.description}` : ''}`).join('\n') || '（尚未配置）'}\n`
    : '';
  const synthetic = type === 'boolean'
    ? '示例（合成数据，不是真实 Case）：若 input.target 是字符串 "Hello 世界" 且规则是检测汉字，可返回 { value: true, reason: "发现汉字字符" }；若 input.target 是对象，按规则自行校验类型后再判断。'
    : type === 'number'
      ? '示例（合成数据，不是真实 Case）：根据规则和等级描述返回有限的等级数值，不换算百分制。'
      : '示例（合成数据，不是真实 Case）：返回固定标签中的一个字符串。';
  return `你正在为 Promptbench 编写一个受限的 JavaScript 评估函数。

判断规则：
${metric.rule || '（尚未填写判断规则）'}

函数契约：
function evaluate(input) → { value: ${valueContract}, reason?: string }

输入对象：
- input.target：本次唯一评估对象，由后端按用户选择提取，保留原始 JSON 类型（字符串、数字、布尔、对象、数组或 null）。不要假定它一定是字符串；按规则校验类型。
- input.case：冻结的 Case 输入 { id, variables }，只作上下文。
- input.output：本次生成的完整输出字符串，只作上下文。
- input.language_resolution：可选的语言路由上下文。
- input.group：生成对照组的 { id, name, model }，只作上下文。
- input.iteration：本次生成的轮次，只作上下文。
只判断 input.target；其他字段不是替代评估对象。
${labels}
运行时限制：
- 必须是同步函数，evaluate 单次执行上限 200 ms。
- 独立 QuickJS 引擎堆上限 16 MiB；编码后的输入上限 1 MiB，返回值上限 64 KiB。
- 不得使用 import、require、fetch、XMLHttpRequest、文件、进程、环境变量或第三方包。
- 不得修改 input 或其属性。
- 返回值必须是 JSON 可表示的 { value, reason? }；Promise、undefined、NaN、Infinity 或类型不符都无效。
- reason 必须是可选字符串，不要伪造模型理由。
- 分类指标必须精确返回固定标签之一。

${synthetic}

请只输出函数代码（不要 Markdown 代码围栏，不要解释）。`;
}

function openAiDialog() {
  const editor = App.metricEditor;
  if (!editor) return;
  $('metric-ai-text').textContent = buildAiPrompt(editor.working);
  $('metric-ai-error').textContent = '';
  $('metric-ai-dialog').showModal();
}

async function copyAiPrompt() {
  const text = $('metric-ai-text').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('metric-ai-dialog').close();
    toast('AI 提示词已复制', 'ok');
  } catch {
    $('metric-ai-error').textContent = '复制失败：剪贴板不可用或权限被拒绝，请手动选择文本。';
  }
}

async function runMetricTrial() {
  const editor = App.metricEditor;
  if (!editor || editor.working.kind !== 'code') return;
  const { errors, payload } = validateMetricDraft(editor.working);
  if (errors.length) {
    App.metricTrial.error = errors.join(' ');
    renderTrialUi();
    return;
  }
  const target = {
    mode: App.metricTrial.targetMode,
    pointer: App.metricTrial.targetMode === 'json_pointer' ? App.metricTrial.pointer : ''
  };
  if (target.mode === 'json_pointer' && target.pointer && !target.pointer.startsWith('/')) {
    App.metricTrial.error = 'JSON Pointer 必须以 / 开头；留空表示根对象。';
    renderTrialUi();
    return;
  }
  App.metricTrial.result = null;
  App.metricTrial.error = '';
  renderTrialUi();
  try {
    const outcome = await apiPost('/api/metrics/trial', {
      metric: payload,
      target,
      input: {
        case: { id: 'local-trial', variables: {} },
        output: App.metricTrial.input,
        group: { id: 'local-trial', name: '本地试算', model: '' },
        iteration: 1
      }
    });
    App.metricTrial.result = outcome;
  } catch (err) {
    App.metricTrial.error = `试算失败：${err.message}`;
  }
  renderTrialUi();
}

function openManagerFromSelection(kind = '') {
  setView('metrics');
  if (kind) startNewMetric(kind);
  else if (!App.metricEditor && App.state.metrics.length) openMetricEditor(App.state.metrics[0].id);
}

function openMetricEditorById(id) {
  if (!metricById(id)) return false;
  setView('metrics');
  openMetricEditor(id, { confirmDiscard: false });
  return true;
}

export function bindMetricEvents() {
  $('manage-metrics-btn').addEventListener('click', () => openManagerFromSelection());
  $('metric-pick-list').addEventListener('change', (e) => {
    const pick = e.target.closest('[data-metric-pick]');
    if (pick) {
      if (pick.checked) addMetricSelection(pick.dataset.metricPick);
      else removeMetricSelection(pick.dataset.metricPick);
      return;
    }
    const mode = e.target.closest('[data-metric-target-mode]');
    if (mode) {
      const ref = App.state.draft.metrics.find((item) => item.metric_id === mode.dataset.metricTargetMode);
      if (!ref) return;
      ref.target.mode = mode.value === 'json_pointer' ? 'json_pointer' : 'output';
      if (ref.target.mode === 'output') ref.target.pointer = '';
      markEdit();
      updateDirtyUI();
      renderMetricSelection();
      refreshRunPlan();
      const input = $('metric-pick-list').querySelector(`[data-metric-pointer="${CSS.escape(ref.metric_id)}"]`);
      if (input) input.focus();
    }
  });
  $('metric-pick-list').addEventListener('input', (e) => {
    const pointer = e.target.closest('[data-metric-pointer]');
    if (!pointer) return;
    const ref = App.state.draft.metrics.find((item) => item.metric_id === pointer.dataset.metricPointer);
    if (!ref) return;
    ref.target.pointer = pointer.value;
    markEdit();
    updateDirtyUI();
    refreshRunPlan();
  });
  $('metric-pick-list').addEventListener('click', (e) => {
    const create = e.target.closest('[data-metric-new]');
    if (create) { openManagerFromSelection(create.dataset.metricNew); return; }
    const fix = e.target.closest('[data-metric-fix-provider]');
    if (fix) { setView('providers'); return; }
    const unpick = e.target.closest('[data-metric-unpick]');
    if (unpick) removeMetricSelection(unpick.dataset.metricUnpick);
  });

  $('metric-new-code-btn').addEventListener('click', () => startNewMetric('code'));
  $('metric-new-model-btn').addEventListener('click', () => startNewMetric('model'));
  $('metric-new-inline-btn').addEventListener('click', () => startNewMetric('model'));
  $('metric-save-btn').addEventListener('click', saveMetricEditor);
  $('metric-delete-btn').addEventListener('click', deleteMetricEditor);
  $('metric-search').addEventListener('input', () => {
    App.metricSearch = $('metric-search').value;
    renderMetricsView();
  });
  $('metric-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-metric-id]');
    if (item) openMetricEditor(item.dataset.metricId);
    const create = e.target.closest('[data-metric-new]');
    if (create) startNewMetric(create.dataset.metricNew);
  });

  $('metric-editor-name').addEventListener('input', () => {
    const editor = App.metricEditor;
    if (!editor) return;
    editor.working.name = $('metric-editor-name').value;
    $('metric-editor-title').textContent = editor.working.name || '未命名指标';
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-rule').addEventListener('input', () => {
    if (!App.metricEditor) return;
    App.metricEditor.working.rule = $('metric-rule').value;
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-code').addEventListener('input', () => {
    if (!App.metricEditor) return;
    App.metricEditor.working.code = $('metric-code').value;
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-editor-kind').addEventListener('change', () => {
    const editor = App.metricEditor;
    if (!editor) return;
    editor.working.kind = $('metric-editor-kind').value === 'model' ? 'model' : 'code';
    if (editor.working.kind === 'model') {
      if (!editor.working.provider_id) editor.working.provider_id = firstDecisionProviderId();
      if (!String(editor.working.model || '').trim()) editor.working.model = DEFAULT_METRIC_MODEL;
    }
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-editor-return').addEventListener('change', () => {
    const editor = App.metricEditor;
    if (!editor) return;
    editor.working.return_type = ['boolean', 'number', 'classification'].includes($('metric-editor-return').value)
      ? $('metric-editor-return').value : 'boolean';
    if (editor.working.return_type === 'number' && (!Array.isArray(editor.working.levels) || editor.working.levels.length < 2)) editor.working.levels = ['', ''];
    if (editor.working.return_type === 'classification' && (!Array.isArray(editor.working.labels) || editor.working.labels.length < 2)) {
      editor.working.labels = [{ label: '', description: '' }, { label: '', description: '' }];
    }
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-provider').addEventListener('change', () => {
    if (!App.metricEditor) return;
    App.metricEditor.working.provider_id = $('metric-provider').value;
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-model').addEventListener('input', () => {
    if (!App.metricEditor) return;
    App.metricEditor.working.model = $('metric-model').value;
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-threshold').addEventListener('input', () => {
    if (!App.metricEditor) return;
    App.metricEditor.working.threshold = $('metric-threshold').value === '' ? NaN : Number($('metric-threshold').value);
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-add-level').addEventListener('click', () => {
    const editor = App.metricEditor;
    if (!editor) return;
    if (!Array.isArray(editor.working.levels)) editor.working.levels = [];
    if (editor.working.levels.length >= 10) return;
    editor.working.levels.push('');
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-levels').addEventListener('input', (e) => {
    const input = e.target.closest('[data-level-index]');
    const editor = App.metricEditor;
    if (!input || !editor) return;
    if (!Array.isArray(editor.working.levels)) editor.working.levels = [];
    editor.working.levels[Number(input.dataset.levelIndex)] = input.value;
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-levels').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-level-remove]');
    const editor = App.metricEditor;
    if (!remove || !editor || !Array.isArray(editor.working.levels) || editor.working.levels.length <= 2) return;
    editor.working.levels.splice(Number(remove.dataset.levelRemove), 1);
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-add-label').addEventListener('click', () => {
    const editor = App.metricEditor;
    if (!editor) return;
    if (!Array.isArray(editor.working.labels)) editor.working.labels = [];
    if (editor.working.labels.length >= 100) return;
    editor.working.labels.push({ label: '', description: '' });
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-labels').addEventListener('input', (e) => {
    const input = e.target.closest('[data-label-index]');
    const editor = App.metricEditor;
    if (!input || !editor) return;
    if (!Array.isArray(editor.working.labels)) editor.working.labels = [];
    const label = editor.working.labels[Number(input.dataset.labelIndex)];
    if (!label) return;
    label[input.dataset.labelField] = input.value;
    markEdit();
    updateMetricSaveUi();
  });
  $('metric-labels').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-label-remove]');
    const editor = App.metricEditor;
    if (!remove || !editor || !Array.isArray(editor.working.labels) || editor.working.labels.length <= 2) return;
    editor.working.labels.splice(Number(remove.dataset.labelRemove), 1);
    markEdit();
    renderMetricEditor();
    updateMetricSaveUi();
  });
  $('metric-provider-link').addEventListener('click', () => setView('providers'));
  $('metric-ai-btn').addEventListener('click', openAiDialog);
  $('metric-ai-copy').addEventListener('click', copyAiPrompt);
  $('metric-trial-target-mode').addEventListener('change', () => {
    App.metricTrial.targetMode = $('metric-trial-target-mode').value === 'json_pointer' ? 'json_pointer' : 'output';
    if (App.metricTrial.targetMode === 'output') App.metricTrial.pointer = '';
    renderTrialUi();
  });
  $('metric-trial-pointer').addEventListener('input', () => {
    App.metricTrial.pointer = $('metric-trial-pointer').value;
  });
  $('metric-trial-input').addEventListener('input', () => {
    App.metricTrial.input = $('metric-trial-input').value;
  });
  $('metric-trial-run').addEventListener('click', runMetricTrial);
}

export { openMetricEditorById, renderMetricSelection, renderMetricsView, openManagerFromSelection };
