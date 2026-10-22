import { EVALUATION_STATUS, METRIC_KIND_LABELS, METRIC_RETURN_LABELS } from './constants.js';
import { esc, fmtDuration } from './utils.js';

function evaluationStatusTag(status) {
  const label = EVALUATION_STATUS[status] || status || '未知';
  return `<span class="eval-status ${esc(status || '')}">${esc(label)}</span>`;
}

function metricTypeLabel(metric) {
  if (!metric) return '指标';
  return `${METRIC_KIND_LABELS[metric.kind] || metric.kind || '指标'} · ${METRIC_RETURN_LABELS[metric.return_type] || metric.return_type || '未知'}`;
}

function metricMap(detail) {
  const map = new Map();
  const snapshotMetrics = Array.isArray(detail?.snapshot?.metrics) ? detail.snapshot.metrics : [];
  for (const entry of snapshotMetrics) {
    if (entry && entry.metric && entry.metric.id) map.set(entry.metric.id, entry);
  }
  return map;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1e15 || Math.abs(n) < 1e-6) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

function formatValue(value, metric) {
  if (value === null || value === undefined) return '—';
  if (metric?.return_type === 'boolean') {
    if (value === true) return 'true';
    if (value === false) return 'false';
    return String(value);
  }
  if (metric?.return_type === 'number') return formatNumber(value);
  return String(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function legendEntries(outcome, metric) {
  const legend = outcome.legend;
  if (legend && typeof legend === 'object' && !Array.isArray(legend)) {
    return Object.entries(legend).sort((a, b) => {
      const an = Number(a[0]);
      const bn = Number(b[0]);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a[0]).localeCompare(String(b[0]));
    });
  }
  if (Array.isArray(metric?.levels)) return metric.levels.map((level, index) => [String(index), level]);
  return [];
}

function probabilityHtml(outcome, metric) {
  const bits = [];
  const noul = finiteNumber(outcome.noul);
  if (noul !== null) {
    const threshold = finiteNumber(metric?.threshold);
    bits.push(`yes 概率 ${formatNumber(noul)} · 阈值 ${formatNumber(threshold === null ? 0.5 : threshold)}`);
  }
  if (outcome.probabilities && typeof outcome.probabilities === 'object' && !Array.isArray(outcome.probabilities)) {
    const entries = Object.entries(outcome.probabilities);
    if (entries.length) {
      bits.push(`分布：${entries.map(([key, value]) => `${key} ${formatNumber(value)}`).join(' · ')}`);
    }
  }
  const confidence = finiteNumber(outcome.confidence);
  if (confidence !== null) bits.push(`confidence ${formatNumber(confidence)}`);
  const legend = legendEntries(outcome, metric);
  if (legend.length) bits.push(`等级：${legend.map(([key, value]) => `${key} ${value}`).join(' / ')}`);
  return bits.length ? `<div class="eval-probabilities">${esc(bits.join(' · '))}</div>` : '';
}

function outcomeHtml(outcome, metric, { includeRaw = false } = {}) {
  if (!outcome) return '<div class="empty-state">没有评估记录。</div>';
  const status = outcome.status || '';
  const parts = [`<div class="eval-outcome-line">${evaluationStatusTag(status)}</div>`];
  if (status === 'completed') {
    parts.push(`<div class="eval-value-line"><span class="eval-value ${esc(metric?.return_type || '')}">${esc(formatValue(outcome.value, metric))}</span></div>`);
    if (outcome.reason) parts.push(`<div class="eval-reason">${esc(outcome.reason)}</div>`);
    parts.push(probabilityHtml(outcome, metric));
  }
  if (outcome.error) parts.push(`<div class="preview-error">${esc(outcome.error)}</div>`);
  const meta = [];
  if (outcome.response_model) meta.push(`响应模型 ${outcome.response_model}`);
  if (outcome.http_status) meta.push(`HTTP ${outcome.http_status}`);
  if (outcome.duration_ms != null) meta.push(`耗时 ${fmtDuration(outcome.duration_ms)}`);
  if (meta.length) parts.push(`<div class="eval-meta">${esc(meta.join(' · '))}</div>`);
  if (includeRaw && outcome.raw_response) {
    parts.push(`<details class="eval-raw"><summary>原始返回</summary><pre>${esc(outcome.raw_response)}</pre></details>`);
  }
  return parts.join('');
}

function evaluationBadge(result) {
  const evaluations = Array.isArray(result?.evaluations) ? result.evaluations : [];
  if (!evaluations.length) return '';
  const counts = { error: 0, running: 0, pending: 0, completed: 0, skipped: 0, cancelled: 0, interrupted: 0 };
  for (const outcome of evaluations) {
    if (counts[outcome.status] != null) counts[outcome.status] += 1;
  }
  const status = counts.running ? 'running' : counts.pending ? 'pending'
    : counts.error ? 'failed' : counts.interrupted ? 'interrupted'
      : counts.cancelled ? 'cancelled' : counts.skipped ? 'skipped' : 'completed';
  const labels = {
    completed: '成功', failed: '失败', running: '运行中', pending: '待运行',
    cancelled: '已取消', interrupted: '结果未知', skipped: '已跳过'
  };
  const detail = [
    `完成 ${counts.completed}`, `错误 ${counts.error}`,
    `进行中 ${counts.running + counts.pending}`, `取消 ${counts.cancelled}`,
    `跳过 ${counts.skipped}`, `中断 ${counts.interrupted}`
  ].join(' · ');
  return `<span class="status-tag ${status}" title="${esc(detail)}">${labels[status]}</span>`;
}

function progressInfo(batch) {
  const generationTotal = Number(batch?.total) || 0;
  const generationDone = (Number(batch?.completed) || 0) + (Number(batch?.failed) || 0)
    + (Number(batch?.cancelled) || 0) + (Number(batch?.interrupted) || 0);
  const e = batch?.evaluation && typeof batch.evaluation === 'object' ? batch.evaluation : {};
  const evalTotal = Number(e.total) || 0;
  const evalDone = (Number(e.completed) || 0) + (Number(e.error) || 0)
    + (Number(e.skipped) || 0) + (Number(e.cancelled) || 0) + (Number(e.interrupted) || 0);
  const evalBusy = (Number(e.pending) || 0) + (Number(e.running) || 0);
  return { generationTotal, generationDone, evalTotal, evalDone, evalBusy };
}

function summaryExtra(row) {
  const bits = [];
  if (row.skipped) bits.push(`跳过 ${row.skipped}`);
  if (row.cancelled) bits.push(`取消 ${row.cancelled}`);
  if (row.interrupted) bits.push(`中断 ${row.interrupted}`);
  if (row.pending) bits.push(`待评估 ${row.pending}`);
  if (row.running) bits.push(`评估中 ${row.running}`);
  return bits.length ? `<div class="summary-extra">${esc(bits.join(' · '))}</div>` : '';
}

function summaryResult(row, metric) {
  const valid = Number(row.valid) || 0;
  if (metric?.return_type === 'boolean') {
    return `true ${Number(row.true_count) || 0} / ${valid} · false ${Number(row.false_count) || 0}`;
  }
  if (metric?.return_type === 'number') {
    if (!valid) return '暂无有效数值';
    return `均值 ${formatNumber(row.mean)} · 范围 ${formatNumber(row.min)}–${formatNumber(row.max)}`;
  }
  if (metric?.return_type === 'classification') {
    const counts = row.labels && typeof row.labels === 'object' && !Array.isArray(row.labels) ? row.labels : {};
    const declared = Array.isArray(metric.labels) ? metric.labels.map((l) => l.label) : [];
    const keys = [...declared, ...Object.keys(counts).filter((key) => !declared.includes(key))];
    if (!keys.length) return '暂无分类统计';
    return keys.map((key) => `${key} ${Number(counts[key]) || 0}`).join(' · ');
  }
  return `有效 ${valid}`;
}

export { evaluationBadge, evaluationStatusTag, formatNumber, formatValue, metricMap, metricTypeLabel, outcomeHtml, progressInfo, summaryExtra, summaryResult };
