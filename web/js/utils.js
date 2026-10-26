import { ATTEMPT_STATUS, BATCH_STATUS } from './constants.js';

const $ = (id) => document.getElementById(id);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pretty(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtClock(date) {
  if (!date) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function clipText(text, max = 400000) {
  const s = text == null ? '' : String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n… 已截断显示前 ${max.toLocaleString('en-US')} 字符；完整内容请导出批次 JSON。`;
}

function batchActive(batch) {
  return !!batch && (batch.status === 'running' || batch.status === 'stopping');
}

function statusLabel(status) {
  return BATCH_STATUS[status] || status || '未知';
}

function attemptLabel(status) {
  return ATTEMPT_STATUS[status] || status || '未知';
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

function caseTextOf(c) {
  const variables = c && c.variables && typeof c.variables === 'object' ? c.variables : {};
  if (hasOwn(variables, 'CurrentText') && typeof variables.CurrentText === 'string' && variables.CurrentText.trim()) {
    return variables.CurrentText;
  }
  for (const key of Object.keys(variables).sort()) {
    if (key !== 'SourceLanguage' && typeof variables[key] === 'string' && variables[key].trim()) {
      return variables[key];
    }
  }
  return '';
}

function excerptText(text, max = 44) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function sourceLanguageOf(c) {
  const v = c && c.variables && typeof c.variables === 'object' ? c.variables.SourceLanguage : undefined;
  return typeof v === 'string' ? v : '';
}

function uniqueId(prefix, ids) {
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n += 1;
  ids.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

export { $, attemptLabel, batchActive, caseTextOf, clampInt, clipText, clone, esc, excerptText, fmtClock, fmtDateTime, fmtDuration, fmtTime, hasOwn, pretty, sameValue, shortId, sourceLanguageOf, stableStringify, statusLabel, uniqueId };
