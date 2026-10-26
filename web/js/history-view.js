import { $, esc, fmtDateTime, statusLabel } from './utils.js';
import { App } from './state.js';
import { statusTag } from './feedback.js';
import { snapshotHtml } from './snapshot.js';
import { renderResultBrowser } from './output.js';
import { hasKnownActiveBatch } from './run-plan.js';

function renderHistoryList() {
  const list = $('history-run-list');
  if (!list) return;
  $('history-count').textContent = String(App.runs.length);
  $('history-meta').textContent = `${App.runs.length} 个持久化批次`;
  if (!App.runs.length) {
    list.innerHTML = App.runsLoaded
      ? '<div class="empty-state">尚无持久化运行记录。完成一次运行后可在这里查看、导出或复跑。</div>'
      : '<div class="empty-state">载入历史中…</div>';
    updateCompareButton();
    return;
  }
  list.innerHTML = App.runs.map((b) => {
    const checked = App.compareIds.has(b.id);
    return `
      <div class="run-item ${b.id === App.historySelectedId ? 'active' : ''}">
        <input type="checkbox" data-compare-id="${esc(b.id)}" ${checked ? 'checked' : ''} aria-label="${esc(`选择批次 ${b.name || b.id} 用于对比`)}">
        <button type="button" class="run-main" data-history-open="${esc(b.id)}">
          <span class="run-name">${esc(b.name || b.id)}</span>
          <span class="run-sub">#${esc(b.id)} · ${esc(fmtDateTime(b.created_at))}</span>
          <span class="run-tags">
            ${statusTag(b.status)}
            <span class="pill subtle">${esc(String(b.total ?? 0))} 次</span>
            <span class="pill subtle">完成 ${esc(String(b.completed ?? 0))}</span>
            ${b.failed ? `<span class="pill err">失败 ${esc(String(b.failed))}</span>` : ''}
            ${b.replay_of ? '<span class="pill subtle">复跑</span>' : ''}
          </span>
        </button>
      </div>`;
  }).join('');
  updateCompareButton();
}

function updateCompareButton() {
  const btn = $('compare-btn');
  if (!btn) return;
  btn.disabled = App.compareIds.size < 2 || App.compareIds.size > 6;
  btn.textContent = App.compareIds.size ? `对比选中（${App.compareIds.size}）` : '对比选中';
}

function renderHistoryDetail(detail) {
  const el = $('history-detail');
  if (!el) return;
  const b = detail.batch || {};
  const results = detail.results || [];
  el.innerHTML = `
    <div class="history-detail">
      <div class="detail-head">
        <div>
          <h2 class="detail-title">${esc(b.name || b.id)}</h2>
          <div class="detail-sub">
            <span class="mono">#${esc(b.id)}</span>
            <span>创建 ${esc(fmtDateTime(b.created_at))}</span>
            ${b.finished_at ? `<span>结束 ${esc(fmtDateTime(b.finished_at))}</span>` : ''}
            ${b.replay_of ? `<span>复跑自 <span class="mono">#${esc(b.replay_of)}</span></span>` : ''}
          </div>
        </div>
        <div class="detail-actions">
          <button type="button" class="btn tiny" data-run-export="${esc(b.id)}">导出 JSON</button>
          <button type="button" class="btn tiny" data-run-replay="${esc(b.id)}" ${hasKnownActiveBatch() || App.loading ? 'disabled' : ''}>按冻结快照仅重新生成</button>
          <button type="button" class="btn tiny" data-run-output="${esc(b.id)}">在输出面板查看</button>
          <button type="button" class="btn tiny" data-run-refresh="${esc(b.id)}">刷新</button>
        </div>
      </div>
      <div class="detail-stats">
        <div class="stat"><div class="k">状态</div><div class="v">${esc(statusLabel(b.status))}</div></div>
        <div class="stat"><div class="k">总请求</div><div class="v">${esc(String(b.total ?? 0))}</div></div>
        <div class="stat"><div class="k">成功</div><div class="v">${esc(String(b.completed ?? 0))}</div></div>
        <div class="stat"><div class="k">失败</div><div class="v">${esc(String(b.failed ?? 0))}</div></div>
        <div class="stat"><div class="k">已取消</div><div class="v">${esc(String(b.cancelled ?? 0))}</div></div>
        <div class="stat"><div class="k">结果未知</div><div class="v">${esc(String(b.interrupted ?? 0))}</div></div>
        <div class="stat"><div class="k">在途</div><div class="v">${esc(String(b.in_flight ?? 0))}</div></div>
        <div class="stat"><div class="k">并发</div><div class="v">${esc(String(b.concurrency ?? '—'))}</div></div>
      </div>
      ${b.evaluation_execution_id ? `<p>关联评估 #${esc(b.evaluation_execution_id)}（状态独立于生成）；在输出面板选择评估版本查看。</p>` : ''}
      <section class="detail-section">
        <h3>冻结快照</h3>
        ${snapshotHtml(detail.snapshot)}
      </section>
      <section class="detail-section">
        <h3>结果（${results.length}）</h3>
        <div class="result-list detail-results"></div>
      </section>
    </div>`;
  renderResultBrowser(el.querySelector('.detail-results'), results, '没有结果记录。', detail);
}

export { renderHistoryDetail, renderHistoryList, updateCompareButton };
