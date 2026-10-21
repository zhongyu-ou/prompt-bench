import { $, currentTextOf, esc, shortId, sourceLanguageOf, uniqueId } from './utils.js';
import { activeCase, credentialMeta, groupRouteSummary, isKnownProtocol, providerById, resolveGroupTargets, selectedCaseIds, templateById } from './model.js';
import { App } from './state.js';
import { ICON_EDIT } from './constants.js';

function renderWorkbenchCase() {
  const idEl = $('wb-case-id');
  const body = $('wb-case-body');
  if (!idEl || !body) return;
  const resolved = selectedCaseIds();
  if (resolved.length && (!App.activeCaseId || !resolved.includes(App.activeCaseId))) {
    App.activeCaseId = resolved[0];
  }
  const c = activeCase();
  if (!c) {
    idEl.textContent = '';
    body.innerHTML = '<div class="empty-state">Case 库中还没有 Case。</div>';
    return;
  }
  const inScope = resolved.includes(c.id);
  idEl.textContent = shortId(c.id);
  idEl.title = c.id;
  const text = currentTextOf(c);
  const source = sourceLanguageOf(c);
  const groups = App.state.draft.groups.filter((g) => g.enabled);
  const targetLines = groups.map((g) => {
    const resolved = resolveGroupTargets(g, source);
    const targets = resolved.targets.map((t) => t.key).join(', ');
    return `<div class="case-target-line"><span class="case-target-group">${esc(g.name || g.id)}</span><span class="case-target-values">→ ${esc(targets || '—')}${resolved.usedDefault ? ' <span class="default-mark">默认</span>' : ''}</span></div>`;
  }).join('');
  body.innerHTML = `
    <div class="case-preview-text">${esc(text || '（无 CurrentText）')}</div>
    <div class="case-preview-meta">源语言：<span class="mono">${esc(source || '（未设置）')}</span>${inScope ? '' : ' · <span class="pill warn">范围外</span>'}</div>
    ${targetLines || '<div class="muted small">没有启用的对照配置。</div>'}
  `;
}

function groupRoutesHtml(group) {
  const parts = groupRouteSummary(group);
  return parts.map((part, index) => `<span class="${index === parts.length - 1 ? 'route-default' : ''}">${esc(part)}</span>`).join('');
}

function renderGroupCards() {
  const host = $('group-cards');
  if (!host || !App.state) return;
  const groups = App.state.draft.groups;
  const enabled = groups.filter((g) => g.enabled).length;
  $('group-enabled-count').textContent = `${enabled} 个已启用`;
  if (!groups.length) {
    host.innerHTML = '<div class="empty-state">尚无对照组配置。点击“＋ 添加配置”添加模板 / Provider / 模型组合。</div>';
    return;
  }
  host.innerHTML = groups.map((g) => {
    const tpl = templateById(g.template_id);
    const prov = providerById(g.provider_id);
    const missing = !tpl || !prov || !String(g.model || '').trim() || !prov.protocol || !isKnownProtocol(prov.protocol);
    const meta = prov ? credentialMeta(prov.id) : null;
    const credWarn = prov && meta && meta.requires_auth && !meta.available;
    return `
      <div class="group-summary ${g.id === App.activeGroupId ? 'active' : ''} ${g.enabled ? '' : 'disabled'}" data-group-row="${esc(g.id)}">
        <label class="group-check" title="启用或停用该配置">
          <input type="checkbox" data-group-enabled="${esc(g.id)}" ${g.enabled ? 'checked' : ''} aria-label="${esc(`启用对照配置 ${g.name || g.id}`)}">
        </label>
        <button type="button" class="group-main" data-group-select="${esc(g.id)}">
          <span class="group-name">${esc(g.name || g.id)}${missing ? ' <span class="pill warn">待补全</span>' : ''}${credWarn ? ' <span class="pill warn">凭据不可用</span>' : ''}</span>
          <span class="group-meta">${esc(prov ? (prov.name || prov.id) : 'Provider 缺失')} · <span class="mono">${esc(g.model || '模型未填写')}</span> · 每 Case ${esc(String(g.runs))} 次</span>
          <span class="group-routes">${groupRoutesHtml(g)}</span>
        </button>
        <button type="button" class="btn tiny" data-group-edit="${esc(g.id)}">${ICON_EDIT}编辑</button>
      </div>`;
  }).join('');
}

function nextGroupDefaults() {
  const groups = App.state.draft.groups;
  let n = groups.length + 1;
  const names = new Set(groups.map((g) => g.name));
  while (names.has(`配置 ${n}`)) n += 1;
  const ids = new Set(groups.map((g) => g.id));
  return {
    id: uniqueId('group_', ids),
    name: `配置 ${n}`,
    enabled: true,
    template_id: App.activeTemplateId || App.state.templates[0]?.id || '',
    provider_id: App.state.providers[0]?.id || '',
    model: '',
    parameters: {},
    runs: App.state.settings.default_runs || 20,
    language_routes: []
  };
}

function renderModelSuggestions() {
  const datalist = $('model-suggestions');
  if (!datalist || !App.state) return;
  const models = new Set();
  for (const g of App.state.draft.groups) if (g.model) models.add(g.model);
  datalist.innerHTML = [...models].sort().map((m) => `<option value="${esc(m)}"></option>`).join('');
}

export { nextGroupDefaults, renderGroupCards, renderModelSuggestions, renderWorkbenchCase };
