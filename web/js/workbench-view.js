import { $, esc, uniqueId } from './utils.js';
import { credentialMeta, groupRouteSummary, isKnownProtocol, providerById, providersWithCapability, protocolSupports, templateById } from './model.js';
import { App } from './state.js';
import { ICON_EDIT } from './constants.js';


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
    const wrongCapability = prov && prov.protocol && isKnownProtocol(prov.protocol) && !protocolSupports(prov.protocol, 'generation');
    const meta = prov ? credentialMeta(prov.id) : null;
    const credWarn = prov && meta && meta.requires_auth && !meta.available;
    return `
      <div class="group-summary ${g.id === App.activeGroupId ? 'active' : ''} ${g.enabled ? '' : 'disabled'}" data-group-row="${esc(g.id)}">
        <label class="group-check" title="启用或停用该配置">
          <input type="checkbox" data-group-enabled="${esc(g.id)}" ${g.enabled ? 'checked' : ''} aria-label="${esc(`启用对照配置 ${g.name || g.id}`)}">
        </label>
        <button type="button" class="group-main" data-group-select="${esc(g.id)}">
          <span class="group-name">${esc(g.name || g.id)}${missing ? ' <span class="pill warn">待补全</span>' : ''}${wrongCapability ? ' <span class="pill warn">不可用于生成</span>' : ''}${credWarn ? ' <span class="pill warn">凭据不可用</span>' : ''}</span>
          <span class="group-meta">${esc(prov ? (prov.name || prov.id) : 'Provider 缺失')} · <span class="mono">${esc(g.model || '模型未填写')}</span> · 每 Case ${esc(String(g.runs))} 次</span>
          <span class="group-template">模板：${esc(tpl ? (tpl.name || tpl.id) : '模板缺失')}</span>
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
    provider_id: providersWithCapability('generation')[0]?.id || '',
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

export { nextGroupDefaults, renderGroupCards, renderModelSuggestions };
