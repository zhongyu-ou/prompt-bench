import { caseById, collectionById, credentialMeta, hasUnsavedWork, isKnownProtocol, pendingCredentialFor, providerById, selectedCaseIds, templateById } from './model.js';
import { App } from './state.js';
import { $, batchActive, esc } from './utils.js';
import { updateDirtyUI } from './shell-view.js';

function validateSettings(settings) {
  const errors = [];
  if (!Number.isInteger(settings.default_runs) || settings.default_runs < 1 || settings.default_runs > 1000) {
    errors.push('默认每 case 次数必须为 1–1000 的整数。');
  }
  if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > 20) {
    errors.push('全局并发上限必须为 1–20 的整数。');
  }
  if (!Number.isInteger(settings.timeout_seconds) || settings.timeout_seconds < 1 || settings.timeout_seconds > 3600) {
    errors.push('请求超时必须为 1–3600 秒。');
  }
  return errors;
}

function validateRoutes(routes) {
  const errors = [];
  if (!Array.isArray(routes)) return ['语言路由必须是数组。'];
  const seen = new Set();
  for (const route of routes) {
    const source = route && typeof route.source_language === 'string' ? route.source_language : '';
    if (!source || source.trim() !== source) {
      errors.push('每条语言路由都需要非空源语言，且不能有首尾空白。');
      continue;
    }
    if (seen.has(source)) errors.push(`源语言「${source}」重复；每组同源语言只能有一条规则。`);
    seen.add(source);
    const targets = Array.isArray(route.targets) ? route.targets : [];
    if (!targets.length) errors.push(`源语言「${source}」至少需要一个目标语言。`);
    const keys = new Set();
    for (const t of targets) {
      const key = t && typeof t.key === 'string' ? t.key : '';
      const name = t && typeof t.name === 'string' ? t.name : '';
      if (!key || key.trim() !== key) errors.push(`源语言「${source}」的目标响应键不能为空且有首尾空白。`);
      if (!name || !name.trim() || name.trim() !== name) errors.push(`源语言「${source}」的目标名称不能为空且有首尾空白。`);
      if (keys.has(key)) errors.push(`源语言「${source}」的目标响应键「${key}」重复。`);
      keys.add(key);
    }
  }
  return errors;
}

function computeRunPlan() {
  const errors = [];
  const warnings = [];
  const cases = selectedCaseIds();
  const enabledGroups = App.state.draft.groups.filter((g) => g.enabled);
  let runsPerCase = 0;
  for (const g of enabledGroups) {
    const label = g.name || g.id;
    const tpl = templateById(g.template_id);
    const prov = providerById(g.provider_id);
    const runs = Number(g.runs);
    if (!tpl) errors.push(`配置「${label}」的模板不存在。`);
    else if (!tpl.messages.length) errors.push(`配置「${label}」使用的模板「${tpl.name || tpl.id}」没有任何消息。`);
    if (!prov) errors.push(`配置「${label}」的 Provider 不存在。`);
    else {
      if (!prov.protocol) errors.push(`Provider「${prov.name || prov.id}」未设置协议。`);
      else if (!App.providerProtocolsLoaded) errors.push('Provider 协议目录未加载，无法验证协议；请刷新后重试。');
      else if (!isKnownProtocol(prov.protocol)) errors.push(`Provider「${prov.name || prov.id}」使用的协议「${prov.protocol}」未实现，无法运行。`);
      if (!/^https?:\/\//i.test(prov.base_url || '')) errors.push(`Provider「${prov.name || prov.id}」的 Base URL 无效。`);
      const pending = pendingCredentialFor(prov.id);
      const meta = credentialMeta(prov.id);
      if (pending && pending.kind === 'set') {
        warnings.push(`Provider「${prov.name || prov.id}」有待保存的手动密钥；保存后生效。`);
      } else if (pending && pending.kind === 'clear') {
        if (meta && meta.requires_auth && !meta.env_available) {
          errors.push(`Provider「${prov.name || prov.id}」清除手动密钥后环境变量不可用，协议要求认证。`);
        } else {
          warnings.push(`Provider「${prov.name || prov.id}」待清除手动密钥，将回退环境变量/无认证。`);
        }
      } else if (meta) {
        if (meta.requires_auth && !meta.available) {
          errors.push(`Provider「${prov.name || prov.id}」缺少可用凭据，协议要求认证。`);
        } else if (!meta.requires_auth) {
          warnings.push(`Provider「${prov.name || prov.id}」允许无认证请求。`);
        }
        if (prov.api_key_env && !meta.env_available && meta.source !== 'manual') {
          warnings.push(`Provider「${prov.name || prov.id}」的环境变量 ${prov.api_key_env} 当前不可用。`);
        }
      } else {
        warnings.push(`Provider「${prov.name || prov.id}」凭据状态尚未验证；保存后由服务端确认。`);
      }
    }
    if (!String(g.model || '').trim()) errors.push(`配置「${label}」未填写模型 ID。`);
    if (!Number.isInteger(runs) || runs < 1 || runs > 1000) errors.push(`配置「${label}」的每 case 次数必须是 1–1000 的整数。`);
    else runsPerCase += runs;
    for (const err of validateRoutes(g.language_routes || [])) errors.push(`配置「${label}」：${err}`);
  }
  if (!cases.length) errors.push('本次运行范围没有 Case（在右侧选择集合，或从 Case 库“用于调试”）。');
  const danglingCollections = App.state.draft.collection_ids.filter((id) => !collectionById(id));
  if (danglingCollections.length) errors.push(`草稿引用了不存在的集合：${danglingCollections.join(', ')}。`);
  const unknownExcluded = App.state.draft.excluded_case_ids.filter((id) => !caseById(id));
  if (unknownExcluded.length) errors.push(`临时排除包含不存在的 Case：${unknownExcluded.join(', ')}。`);
  if (!enabledGroups.length) errors.push('没有启用任何对照配置。');
  const total = cases.length * runsPerCase;
  if (total > 100000) errors.push(`总请求数 ${total} 超过单批次上限 100000。`);
  for (const err of validateSettings(App.state.settings)) errors.push(err);
  for (const err of App.settingsError) if (!errors.includes(err)) errors.push(err);
  if (hasUnsavedWork()) warnings.push('存在未保存更改；如含待保存的手动密钥，会与草稿一起提交。');
  if (hasKnownActiveBatch()) warnings.push('已有批次正在运行；同一时间只允许一个批次，启动按钮已禁用。');
  return { cases, enabledGroups, runsPerCase, total, errors, warnings, concurrency: App.state.settings.concurrency };
}

function hasKnownActiveBatch() {
  if (App.runs.some(batchActive)) return true;
  if (App.currentDetail && batchActive(App.currentDetail.batch)) return true;
  return false;
}

function refreshRunPlan() {
  if (!App.state) return;
  const plan = computeRunPlan();
  renderRunValidation(plan);
  const totalLine = $('total-line');
  if (totalLine) {
    totalLine.textContent = plan.total
      ? `${plan.cases.length} 个 Case × ${plan.runsPerCase} 次 = ${plan.total} 次请求 · 并发 ≤ ${plan.concurrency}`
      : '选择 Case 并启用配置后开始运行';
  }
  const btn = $('run-btn');
  const label = $('run-btn-label');
  if (!btn || !label) return;
  const active = hasKnownActiveBatch();
  const stopping = App.currentDetail?.batch?.status === 'stopping';
  const disabled = active || App.saving || App.loading || App.mutating || plan.errors.length > 0 || plan.total <= 0;
  btn.disabled = disabled;
  btn.classList.toggle('busy', active);
  label.textContent = active
    ? (stopping ? '停止中…' : '批次运行中')
    : (plan.total > 0 ? `运行 ${plan.total} 次` : '运行');
  btn.title = plan.errors.length
    ? `无法运行：${plan.errors[0]}`
    : (active ? '已有批次运行中；可在运行输出面板查看或停止' : '保存草稿并以当前范围启动批次');
  updateDirtyUI();
}

function renderRunValidation(plan) {
  const el = $('run-validation');
  if (!el) return;
  const lines = [];
  for (const err of plan.errors) lines.push(`<div class="validation-line">● ${esc(err)}</div>`);
  for (const warning of plan.warnings) lines.push(`<div class="validation-line warn">○ ${esc(warning)}</div>`);
  if (!plan.errors.length && plan.total > 0) {
    lines.push(`<div class="validation-line ok">● 校验通过：${esc(String(plan.total))} 次请求，待保存后启动。</div>`);
  } else if (!plan.errors.length) {
    lines.push('<div class="validation-line warn">○ 尚未选择可运行的 Case 或配置。</div>');
  }
  el.innerHTML = lines.join('');
}

export { computeRunPlan, hasKnownActiveBatch, refreshRunPlan, validateRoutes, validateSettings };
