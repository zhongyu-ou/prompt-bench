import { esc, pretty, shortId } from './utils.js';
import { groupRouteSummary, protocolById, protocolLabel } from './model.js';

function snapshotChips(items, render) {
  if (!items || !items.length) return '<div class="compare-empty">（空）</div>';
  return `<div class="snapshot-grid">${items.map(render).join('')}</div>`;
}

function snapshotJsonDetails(title, value, open = false) {
  return `<details class="snapshot-request" ${open ? 'open' : ''}>
    <summary>${esc(title)}</summary>
    <pre>${esc(pretty(value))}</pre>
  </details>`;
}

function snapshotHtml(snapshot) {
  if (!snapshot) return '<div class="empty-state">该批次没有可用的冻结快照。</div>';
  const cases = Array.isArray(snapshot.cases) ? snapshot.cases : [];
  const templates = Array.isArray(snapshot.templates) ? snapshot.templates : [];
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const collections = Array.isArray(snapshot.collections) ? snapshot.collections : [];
  const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
  return `
    <div class="batch-snapshot">
      <div class="snapshot-section">
        <h3>批次冻结参数</h3>
        <div class="snapshot-grid">
          <div class="snapshot-chip"><div class="name">超时</div><div class="meta">${esc(String(snapshot.timeout_seconds ?? '—'))} 秒</div></div>
          <div class="snapshot-chip"><div class="name">Case</div><div class="meta">${cases.length} 个</div></div>
          <div class="snapshot-chip"><div class="name">模板</div><div class="meta">${templates.length} 个</div></div>
          <div class="snapshot-chip"><div class="name">Provider</div><div class="meta">${providers.length} 个</div></div>
          <div class="snapshot-chip"><div class="name">对照配置</div><div class="meta">${groups.length} 个</div></div>
          <div class="snapshot-chip"><div class="name">共享集合</div><div class="meta">${collections.length} 个</div></div>
          <div class="snapshot-chip"><div class="name">冻结请求</div><div class="meta">${requests.length} 个渲染请求</div></div>
        </div>
      </div>
      ${collections.length ? `<div class="snapshot-section">
        <h3>本次共享集合</h3>
        ${snapshotChips(collections, (c) => `<div class="snapshot-chip"><div class="name">${esc(c.name || c.id)}</div><div class="meta">${esc(c.id)} · ${esc(String((c.case_ids || []).length))} 个成员</div></div>`)}
      </div>` : ''}
      <div class="snapshot-section">
        <h3>Case 与变量</h3>
        ${snapshotChips(cases, (c) => `<div class="snapshot-chip"><div class="name">${esc(c.name || shortId(c.id))}</div><div class="meta">${esc(c.id)} · ${esc(String(Object.keys(c.variables || {}).length))} 个变量</div></div>`)}
        ${snapshotJsonDetails('查看完整 cases JSON', cases)}
      </div>
      <div class="snapshot-section">
        <h3>模板</h3>
        ${snapshotChips(templates, (t) => `<div class="snapshot-chip"><div class="name">${esc(t.name || t.id)}</div><div class="meta">${esc(t.id)} · ${esc(String((t.messages || []).length))} 条消息</div></div>`)}
        ${snapshotJsonDetails('查看完整 templates JSON', templates)}
      </div>
      <div class="snapshot-section">
        <h3>Provider 引用</h3>
        ${snapshotChips(providers, (p) => `<div class="snapshot-chip"><div class="name">${esc(p.name || p.id)}</div><div class="meta">${providerProtocolTag(p)}<br>${esc(p.base_url || '—')}<br>${esc(p.api_key_env ? `env: ${p.api_key_env}` : '无环境变量')}${p.credential_ref ? `<br>cred ref: ${esc(p.credential_ref)}` : ''}</div></div>`)}
        ${snapshotJsonDetails('查看完整 providers JSON', providers)}
      </div>
      <div class="snapshot-section">
        <h3>对照配置</h3>
        ${snapshotChips(groups, (g) => `<div class="snapshot-chip"><div class="name">${esc(g.name || g.id)}${g.enabled === false ? '（已禁用）' : ''}</div><div class="meta">${esc(g.model || '—')} · ${esc(String(g.runs))} 次<br>${esc(groupRouteSummary(g).join('<br>'))}</div></div>`)}
        ${snapshotJsonDetails('查看完整 groups JSON', groups)}
      </div>
      <div class="snapshot-section">
        <h3>冻结渲染请求</h3>
        <div class="snapshot-requests">
          ${requests.length ? requests.map((r) => `
            <details class="snapshot-request">
              <summary>
                ${r.method ? `<span class="protocol-tag">${esc(r.method)}</span>` : ''}
                <span class="mono">${esc(r.case_name || r.case_id)}</span>
                <span>×</span>
                <span class="mono">${esc(r.group_name || r.group_id)}</span>
                <span class="muted small">${esc(r.model)} · ${esc(String(r.runs))} 次</span>
                <span class="muted small">${esc(r.protocol ? protocolLabel(r.protocol) : '协议未记录')}${r.requires_auth ? ' · 需要认证' : ' · 无认证'}</span>
                ${r.language_resolution ? `<span class="muted small">${esc(r.language_resolution.source_language || '（未设置）')} → ${esc((r.language_resolution.targets || []).map((t) => t.key).join(', '))}${r.language_resolution.used_default ? ' · 默认' : ''}</span>` : ''}
                <span class="muted small mono">${esc(r.prompt_hash ? r.prompt_hash.slice(0, 16) + '…' : '')}</span>
              </summary>
              <pre>${esc(pretty(r.request))}</pre>
              ${(r.method || r.headers) ? `<pre>${esc(pretty({ method: r.method || null, endpoint: r.endpoint || null, headers: r.headers || null }))}</pre>` : ''}
            </details>`).join('') : '<div class="compare-empty">没有冻结请求。</div>'}
        </div>
      </div>
    </div>`;
}

function providerProtocolTag(p) {
  const proto = protocolById(p.protocol);
  if (proto) return `<span class="protocol-tag">${esc(proto.name || proto.id)}</span>`;
  return `<span class="protocol-tag unknown">${esc(p.protocol || '未设置协议')}</span>`;
}

export { providerProtocolTag, snapshotHtml };
