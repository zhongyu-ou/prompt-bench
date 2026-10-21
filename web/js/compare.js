import { $, attemptLabel, clone, esc, fmtDateTime, fmtDuration, pretty, statusLabel } from './utils.js';
import { App } from './state.js';
import { showBanner, toast } from './feedback.js';
import { apiGet } from './api.js';
import { updateCompareButton } from './history-view.js';
import { protocolLabel } from './model.js';

function requestParameters(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return {};
  const copy = clone(request);
  delete copy.model;
  delete copy.messages;
  delete copy.stream;
  return copy;
}

async function showCompare() {
  const ids = [...App.compareIds];
  if (ids.length < 2 || ids.length > 6) {
    toast('请选择 2–6 个批次进行对比', 'info');
    return;
  }
  const btn = $('compare-btn');
  btn.disabled = true;
  btn.textContent = '载入中…';
  try {
    const details = await Promise.all(ids.map((id) => apiGet(`/api/runs/${encodeURIComponent(id)}`)));
    renderCompare(details);
    $('history-list-view').hidden = true;
    $('compare-view').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showBanner(`载入对比批次失败：${err.message}`, 'error');
    toast(`载入对比批次失败：${err.message}`, 'error');
  } finally {
    updateCompareButton();
  }
}

function renderCompare(details) {
  const keyMap = new Map();
  for (const d of details) {
    const requests = Array.isArray(d.snapshot?.requests) ? d.snapshot.requests : [];
    for (const r of requests) {
      const key = `${r.case_id}::${r.group_id}`;
      if (!keyMap.has(key)) {
        keyMap.set(key, {
          case_id: r.case_id,
          case_name: r.case_name,
          group_id: r.group_id,
          group_name: r.group_name
        });
      }
    }
  }
  $('compare-count').textContent = `${details.length} 个批次 · ${keyMap.size} 个 case/配置`;
  const body = $('compare-body');
  if (!keyMap.size) {
    body.innerHTML = '<div class="empty-state">选中的批次没有可比较的冻结请求。</div>';
    return;
  }
  const blocks = [...keyMap.values()].map((key) => {
    const cells = details.map((d) => {
      const b = d.batch || {};
      const request = (d.snapshot?.requests || []).find((r) => r.case_id === key.case_id && r.group_id === key.group_id);
      if (!request) {
        return `<div class="compare-run">
          <div class="compare-run-head"><span class="compare-run-name">${esc(b.name || b.id)}</span><span class="compare-run-id">#${esc(b.id)}</span></div>
          <div class="compare-empty">该批次无此 case/配置。</div>
        </div>`;
      }
      const group = (d.snapshot?.groups || []).find((g) => g.id === key.group_id);
      const params = requestParameters(request.request);
      const results = (d.results || [])
        .filter((r) => r.case_id === key.case_id && r.group_id === key.group_id)
        .sort((a, z) => (a.iteration || 0) - (z.iteration || 0));
      const ok = results.filter((r) => r.status === 'completed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const outputText = results.map((r) => {
        const label = `#${r.iteration} ${attemptLabel(r.status)} · ${r.model || ''} · ${fmtDuration(r.duration_ms)}`;
        const value = r.status === 'completed' ? (r.output || '（空输出）') : (r.error || r.output || '（无输出）');
        return `${label}\n${value}`;
      }).join('\n\n');
      return `<div class="compare-run">
        <div class="compare-run-head">
          <span class="compare-run-name">${esc(b.name || b.id)}</span>
          <span class="compare-run-id">#${esc(b.id)}</span>
        </div>
        <div class="compare-run-id">${esc(statusLabel(b.status))} · ${esc(fmtDateTime(b.created_at))}</div>
        <div>
          <div class="compare-param-label">协议</div>
          <div class="mono small">${esc(request.protocol ? protocolLabel(request.protocol) : '未记录')}${request.requires_auth ? ' · 需要认证' : ' · 无认证'}</div>
        </div>
        <div>
          <div class="compare-param-label">模型</div>
          <div class="mono small">${esc(request.model || group?.model || '—')}</div>
        </div>
        <div>
          <div class="compare-param-label">参数（实际请求，已移除 messages）</div>
          <pre>${esc(pretty(params))}</pre>
        </div>
        <div class="compare-param-label">Endpoint</div>
        <div class="mono small" title="${esc(request.endpoint || '')}">${esc(request.method ? request.method + ' ' : '')}${esc(request.endpoint || '—')}</div>
        <details class="compare-outputs">
          <summary>输出 ${results.length} 条（成功 ${ok} / 失败 ${failed}）</summary>
          <div class="compare-output-meta">每 case 次数 ${esc(String(request.runs))} · prompt hash ${esc((request.prompt_hash || '').slice(0, 16) || '—')}</div>
          <div class="output-pre">${esc(outputText || '（暂无结果）')}</div>
        </details>
      </div>`;
    }).join('');
    return `<div class="compare-group">
      <div class="compare-key-head">
        <span class="case">${esc(key.case_name || key.case_id)}</span>
        <span class="muted">case ${esc(key.case_id)}</span>
        <span class="group">· 配置 ${esc(key.group_name || key.group_id)}</span>
      </div>
      <div class="compare-runs">${cells}</div>
    </div>`;
  }).join('');
  body.innerHTML = `<div class="compare-wrap"><div class="compare-groups">${blocks}</div></div>`;
}

export { showCompare };
