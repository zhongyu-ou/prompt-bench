/* Promptbench · standalone local prompt workbench frontend.
 * Vanilla ES2020. Talks to the Go server at the same origin.
 * All server/provider/model-derived text is escaped before every innerHTML use.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const BATCH_STATUS = {
  running: '运行中',
  stopping: '停止中',
  completed: '已完成',
  completed_with_errors: '完成（有错误）',
  stopped: '已停止',
  interrupted: '中断（结果未知）'
};

const ATTEMPT_STATUS = {
  pending: '待运行',
  running: '运行中',
  completed: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '结果未知'
};

const ROLE_LABEL = { system: 'system · 系统', developer: 'developer · 开发者', user: 'user · 用户', assistant: 'assistant · 助手' };

const ICON_EDIT = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.8-3.4 8.9-8.9a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1l-8.9 8.9L4 16z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l.7 10h6.6l.7-10M8.4 8v5M11.6 8v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const KNOWN_VARIABLES = ['CurrentText', 'PriorText', 'SourceLanguage', 'ReplacementMap'];
const PROHIBITED_VARIABLES = ['TargetLanguageNameMap'];
const LANGUAGE_NAMES = { en: 'English', jp: 'Japanese', ja: 'Japanese', es: 'Spanish', zh: 'Chinese', 'zh-CN': 'Chinese (Simplified)', ko: 'Korean', fr: 'French', de: 'German' };

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

const App = {
  state: null,
  version: 0,
  savedJson: '',
  savedAt: null,
  saving: false,
  mutating: false,
  loading: false,
  editGeneration: 0,
  activeView: 'workbench',
  activeCaseId: null,
  activeTemplateId: null,
  activeMessageIndex: 0,
  activeGroupId: null,
  preview: null,
  previewStale: true,
  previewToken: 0,
  currentRunId: null,
  currentDetail: null,
  pollTimer: null,
  pollBusy: false,
  pollFailures: 0,
  pollTicks: 0,
  batchSeenActive: false,
  runs: [],
  runsLoaded: false,
  historySelectedId: null,
  historyDetail: null,
  compareIds: new Set(),
  outputTab: 'results',
  outputFilter: { group: '', case: '', status: '' },
  expandedResults: new Set(),
  outputScrollTop: 0,
  outputRenderRunId: null,
  snapshotRenderedFor: null,
  settingsError: [],
  providerDialog: { mode: 'create', id: null, clearKey: false },
  credentialMutations: new Map(),
  credentials: {},
  providerProtocols: [],
  providerProtocolsLoaded: false,
  providerCatalogError: '',
  templateDialog: null,
  bannerAction: null,
  connOnline: null,
  lastRunsSignature: '',
  lastFilterSignature: '',
  selectionPreview: null,
  selectionPreviewKey: '',
  selectionPreviewStale: true,
  selectionTimer: null,
  rangeOpen: true,
  rangeDraft: null,
  rangeShowAll: false,
  library: {
    page: 1,
    pageSize: 8,
    search: '',
    source: '',
    collectionId: null,
    selected: new Set(),
    expandedPreview: false
  },
  caseEditor: null,
  io: {
    format: 'jsonl',
    fileName: '',
    content: '',
    preview: null,
    previewGen: 0,
    previewVersion: null,
    previewFingerprint: '',
    previewStale: false,
    recoverNeeded: false,
    expanded: false,
    busy: false,
    targetCollectionId: '',
    exportRange: 'cases',
    exportFormat: 'jsonl',
    exportCollectionIds: new Set(),
    exportIncludeMemberships: true
  },
  groupEditor: null,
  collectionDialog: { mode: 'create', id: null },
  joinCollection: { caseIds: [] },
  targetDialog: { routeIndex: -1 }
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

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
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeCredentials(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const source = ['manual', 'env', 'anonymous', 'missing', 'invalid'].includes(value.source)
      ? value.source
      : 'missing';
    out[id] = {
      manual_set: value.manual_set === true,
      env_available: value.env_available === true,
      source,
      available: value.available === true,
      requires_auth: value.requires_auth === true
    };
  }
  return out;
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

function markEdit() {
  App.editGeneration += 1;
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

function currentTextOf(c) {
  const v = c && c.variables && typeof c.variables === 'object' ? c.variables.CurrentText : undefined;
  return typeof v === 'string' ? v : '';
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

function activeCase() {
  return App.state ? App.state.cases.find((c) => c.id === App.activeCaseId) || null : null;
}

function activeTemplate() {
  return App.state ? App.state.templates.find((t) => t.id === App.activeTemplateId) || null : null;
}

function activeGroup() {
  return App.state && App.state.draft
    ? App.state.draft.groups.find((g) => g.id === App.activeGroupId) || null
    : null;
}

function activeMessage() {
  const tpl = activeTemplate();
  return tpl ? tpl.messages[App.activeMessageIndex] || null : null;
}

function caseById(id) {
  return App.state ? App.state.cases.find((c) => c.id === id) || null : null;
}

function collectionById(id) {
  return App.state ? App.state.collections.find((c) => c.id === id) || null : null;
}

function collectionsForCase(id) {
  return App.state ? App.state.collections.filter((c) => c.case_ids.includes(id)) : [];
}

function templateById(id) {
  return App.state ? App.state.templates.find((t) => t.id === id) || null : null;
}

function providerById(id) {
  return App.state ? App.state.providers.find((p) => p.id === id) || null : null;
}

function protocolById(id) {
  return App.providerProtocols.find((p) => p.id === id) || null;
}

function protocolLabel(id) {
  const p = protocolById(id);
  return p ? (p.name || p.id) : (id || '未设置协议');
}

function isKnownProtocol(id) {
  return !!protocolById(id);
}

function credentialMeta(providerId) {
  return App.credentials[providerId] || null;
}

function groupById(id) {
  return App.state ? App.state.draft.groups.find((g) => g.id === id) || null : null;
}

function uniqueId(prefix, ids) {
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n += 1;
  ids.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

function newProviderId() {
  const ids = new Set(App.state ? App.state.providers.map((p) => p.id) : []);
  let id = '';
  do {
    id = `provider_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  } while (ids.has(id));
  return id;
}

function resolveSelection(selection) {
  if (!App.state) return [];
  const caseSet = new Set(App.state.cases.map((c) => c.id));
  const seen = new Set();
  const ordered = [];
  const add = (id) => {
    if (!caseSet.has(id) || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  for (const id of selection.case_ids || []) add(id);
  for (const cid of selection.collection_ids || []) {
    const c = collectionById(cid);
    if (!c) continue;
    for (const id of c.case_ids) add(id);
  }
  const excluded = new Set(selection.excluded_case_ids || []);
  return ordered.filter((id) => !excluded.has(id));
}

function selectedCaseIds() {
  return App.state ? resolveSelection(App.state.draft) : [];
}

function resolveGroupTargets(group, sourceLanguage) {
  const routes = Array.isArray(group.language_routes) ? group.language_routes : [];
  for (const route of routes) {
    if (route && route.source_language === sourceLanguage) {
      return { targets: Array.isArray(route.targets) ? route.targets : [], usedDefault: false };
    }
  }
  return { targets: [{ key: 'en', name: 'English' }], usedDefault: true };
}

function groupRouteSummary(group) {
  const routes = Array.isArray(group.language_routes) ? group.language_routes : [];
  const parts = routes.map((r) => {
    const targets = (r.targets || []).map((t) => t.key).join(', ');
    return `${r.source_language || '（空）'} → ${targets || '（无目标）'}`;
  });
  parts.push('未匹配 → en');
  return parts;
}

function isDirty() {
  return !!App.state && stableStringify(App.state) !== App.savedJson;
}

function hasPendingCredentials() {
  return App.credentialMutations.size > 0;
}

function pendingCredentialFor(id) {
  return App.credentialMutations.get(id) || null;
}

function hasUnsavedWork() {
  return isDirty() || hasPendingCredentials();
}

function discardCredentialMutation(id) {
  App.credentialMutations.delete(id);
  updateDirtyUI();
  renderProviders();
  if (typeof renderGroupCards === 'function') renderGroupCards();
}

function isBusyVisual() {
  return App.saving || App.loading || App.mutating;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function apiRaw(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  if (options.signal) opts.signal = options.signal;
  let res;
  try {
    res = await fetch(path, opts);
    setConnection(true);
  } catch (err) {
    setConnection(false);
    const error = new Error('无法连接本地服务。请确认 Promptbench 服务正在运行。');
    error.cause = err;
    throw error;
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && payload.error
      ? payload.error
      : `请求失败（HTTP ${res.status}）`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return { payload, text, res };
}

async function api(path, options = {}) {
  return (await apiRaw(path, options)).payload;
}

const apiGet = (path) => api(path);
const apiPost = (path, body = {}) => api(path, { method: 'POST', body });
const apiPut = (path, body) => api(path, { method: 'PUT', body });

/* ------------------------------------------------------------------ */
/* Connection / banner / toast                                         */
/* ------------------------------------------------------------------ */

function setConnection(ok, text) {
  App.connOnline = ok;
  const el = $('conn-status');
  const label = $('conn-text');
  if (!el || !label) return;
  el.classList.toggle('online', ok);
  el.classList.toggle('offline', !ok);
  label.textContent = text || (ok ? '本地服务在线' : '连接中断');
}

function showBanner(message, type = 'error', action = null, actionLabel = '重新载入最新状态') {
  const banner = $('global-banner');
  const text = $('global-banner-text');
  const reload = $('banner-reload-btn');
  if (!banner || !text) return;
  text.textContent = message;
  banner.hidden = false;
  banner.classList.toggle('warn', type === 'warn');
  App.bannerAction = action;
  reload.hidden = !action;
  reload.textContent = actionLabel;
}

function hideBanner() {
  const banner = $('global-banner');
  if (banner) banner.hidden = true;
  App.bannerAction = null;
  const reload = $('banner-reload-btn');
  if (reload) reload.hidden = true;
}

function toast(message, type = 'info', ms = 3600) {
  const region = $('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = String(message);
  region.appendChild(node);
  window.setTimeout(() => node.remove(), ms);
}

/* ------------------------------------------------------------------ */
/* Loading and normalization                                           */
/* ------------------------------------------------------------------ */

function normalizeState(input) {
  const s = input && typeof input === 'object' ? input : {};
  s.version = Number.isFinite(Number(s.version)) ? Number(s.version) : 0;
  s.cases = Array.isArray(s.cases) ? s.cases : [];
  s.collections = Array.isArray(s.collections) ? s.collections : [];
  s.templates = Array.isArray(s.templates) ? s.templates : [];
  s.providers = Array.isArray(s.providers) ? s.providers : [];
  s.settings = s.settings && typeof s.settings === 'object' ? s.settings : {};
  s.settings.default_runs = clampInt(s.settings.default_runs, 1, 1000, 20);
  s.settings.concurrency = clampInt(s.settings.concurrency, 1, 20, 20);
  s.settings.timeout_seconds = clampInt(s.settings.timeout_seconds, 1, 3600, 120);
  s.draft = s.draft && typeof s.draft === 'object' ? s.draft : {};
  s.draft.name = typeof s.draft.name === 'string' ? s.draft.name : '';
  s.draft.case_ids = Array.isArray(s.draft.case_ids) ? s.draft.case_ids : [];
  s.draft.collection_ids = Array.isArray(s.draft.collection_ids) ? s.draft.collection_ids : [];
  s.draft.excluded_case_ids = Array.isArray(s.draft.excluded_case_ids) ? s.draft.excluded_case_ids : [];
  s.draft.groups = Array.isArray(s.draft.groups) ? s.draft.groups : [];
  for (const c of s.cases) {
    if (!c.id) c.id = `case_${Math.random().toString(36).slice(2, 8)}`;
    c.variables = c.variables && typeof c.variables === 'object' && !Array.isArray(c.variables) ? c.variables : {};
  }
  for (const c of s.collections) {
    if (!c.id) c.id = `collection_${Math.random().toString(36).slice(2, 8)}`;
    c.name = typeof c.name === 'string' ? c.name : '';
    c.case_ids = Array.isArray(c.case_ids) ? c.case_ids.filter((id) => typeof id === 'string') : [];
  }
  for (const t of s.templates) {
    if (!t.id) t.id = `tpl_${Math.random().toString(36).slice(2, 8)}`;
    if (!t.name) t.name = t.id;
    t.messages = Array.isArray(t.messages) ? t.messages : [];
    for (const m of t.messages) {
      m.role = ['system', 'developer', 'user', 'assistant'].includes(m.role) ? m.role : 'user';
      m.content = typeof m.content === 'string' ? m.content : '';
    }
  }
  for (const p of s.providers) {
    if (!p.id) p.id = `provider_${Math.random().toString(36).slice(2, 8)}`;
    p.name = typeof p.name === 'string' ? p.name : p.id;
    p.protocol = typeof p.protocol === 'string' ? p.protocol : '';
    p.base_url = typeof p.base_url === 'string' ? p.base_url : '';
    p.api_key_env = typeof p.api_key_env === 'string' ? p.api_key_env : '';
    p.credential_ref = typeof p.credential_ref === 'string' ? p.credential_ref : '';
  }
  delete s.credentials;
  for (const g of s.draft.groups) {
    if (!g.id) g.id = `group_${Math.random().toString(36).slice(2, 8)}`;
    g.name = typeof g.name === 'string' ? g.name : g.id;
    g.enabled = g.enabled !== false;
    g.template_id = typeof g.template_id === 'string' ? g.template_id : '';
    g.provider_id = typeof g.provider_id === 'string' ? g.provider_id : '';
    g.model = typeof g.model === 'string' ? g.model : '';
    g.parameters = g.parameters && typeof g.parameters === 'object' && !Array.isArray(g.parameters) ? g.parameters : {};
    g.runs = clampInt(g.runs, 1, 1000, s.settings.default_runs);
    g.language_routes = Array.isArray(g.language_routes) ? g.language_routes.map((route) => ({
      source_language: typeof route?.source_language === 'string' ? route.source_language : '',
      targets: Array.isArray(route?.targets) ? route.targets.map((t) => ({
        key: typeof t?.key === 'string' ? t.key : '',
        name: typeof t?.name === 'string' ? t.name : ''
      })) : []
    })) : [];
  }
  return s;
}

async function loadState() {
  App.loading = true;
  updateDirtyUI();
  try {
    const { payload } = await apiRaw('/api/state');
    const credentials = payload && typeof payload === 'object' ? payload.credentials : null;
    App.credentials = normalizeCredentials(credentials);
    if (payload && typeof payload === 'object') delete payload.credentials;
    App.state = normalizeState(payload);
    App.version = App.state.version;
    App.savedJson = stableStringify(App.state);
    App.savedAt = new Date();
    App.preview = null;
    App.previewStale = true;
    App.selectionPreview = null;
    App.selectionPreviewStale = true;
    ensureSelections();
    const resolved = selectedCaseIds();
    if (resolved.length && !resolved.includes(App.activeCaseId)) App.activeCaseId = resolved[0];
  } finally {
    App.loading = false;
    updateDirtyUI();
  }
}

function ensureSelections() {
  if (!App.state) return;
  const cases = App.state.cases;
  const templates = App.state.templates;
  const groups = App.state.draft.groups;
  if (!caseById(App.activeCaseId)) App.activeCaseId = cases.length ? cases[0].id : null;
  if (!templateById(App.activeTemplateId)) App.activeTemplateId = templates.length ? templates[0].id : null;
  if (!groupById(App.activeGroupId)) App.activeGroupId = groups.length ? groups[0].id : null;
  const boundGroup = activeGroup();
  const boundTemplate = boundGroup ? templateById(boundGroup.template_id) : null;
  if (boundTemplate) App.activeTemplateId = boundTemplate.id;
  const tpl = activeTemplate();
  const maxIndex = tpl && tpl.messages.length ? tpl.messages.length - 1 : 0;
  if (App.activeMessageIndex > maxIndex) App.activeMessageIndex = maxIndex;
  if (!tpl || !tpl.messages.length) App.activeMessageIndex = 0;
  if (App.state.collections && !App.library.collectionId) {
    // keep "all cases" filter
  } else if (App.library.collectionId && !collectionById(App.library.collectionId)) {
    App.library.collectionId = null;
  }
  const ids = new Set(App.state.cases.map((c) => c.id));
  for (const id of [...App.library.selected]) if (!ids.has(id)) App.library.selected.delete(id);
}

/* ------------------------------------------------------------------ */
/* Generic rendering helpers                                           */
/* ------------------------------------------------------------------ */

function statusTag(status, labels = BATCH_STATUS) {
  return `<span class="status-tag ${esc(status)}">${esc(labels[status] || status || '未知')}</span>`;
}

function svgChevronDown() {
  return '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7.5 10 13l5-5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function viewCrumb() {
  const base = App.state ? (App.state.draft.name || 'ASR 多目标翻译') : 'ASR 多目标翻译';
  switch (App.activeView) {
    case 'cases': {
      const col = App.library.collectionId ? collectionById(App.library.collectionId) : null;
      return `${base} / Case 库 · ${col ? col.name : '全部 Case'}`;
    }
    case 'case-editor': return `${base} / Case 库 / 编辑`;
    case 'case-io': return `${base} / Case 导入与导出`;
    case 'group-editor': {
      const id = App.groupEditor ? App.groupEditor.id : App.activeGroupId;
      const g = id ? groupById(id) : null;
      return `${base} / 工作台 / ${g ? (g.name || '配置') : '新配置'}`;
    }
    case 'history': return `${base} / 运行记录`;
    case 'providers': return `${base} / Providers`;
    case 'settings': return `${base} / 全局设置`;
    default: return `${base} / 工作台 · 本次运行范围`;
  }
}

function renderShell() {
  if (!App.state) return;
  const draft = App.state.draft;
  $('crumb').textContent = viewCrumb();
  $('state-version').textContent = `v${App.version}`;
  $('state-version').title = `服务端状态版本 ${App.version}`;
  const nameInput = $('draft-name');
  if (nameInput && document.activeElement !== nameInput && nameInput.value !== draft.name) nameInput.value = draft.name;
  const meta = $('draft-meta');
  if (meta) meta.textContent = `${App.state.cases.length} 个 Case · ${draft.groups.length} 个配置`;
  document.title = `${hasUnsavedWork() ? '● ' : ''}Promptbench · ${draft.name || 'Prompt 调试'}`;
}

function updateDirtyUI() {
  renderShell();
  const el = $('save-state');
  if (!el) return;
  const dirty = hasUnsavedWork();
  el.classList.remove('dirty', 'error');
  if (!App.connOnline && App.state === null) {
    el.textContent = '未连接';
    el.classList.add('error');
  } else if (App.saving) {
    el.textContent = '保存中…';
  } else if (App.mutating) {
    el.textContent = '正在写入…';
  } else if (dirty) {
    el.textContent = '有未保存更改';
    el.classList.add('dirty');
  } else {
    el.textContent = App.savedAt ? `已保存 ${fmtClock(App.savedAt)}` : '已保存';
  }
  const saveBtn = $('save-btn');
  if (saveBtn) saveBtn.disabled = App.saving || App.mutating;
  if (App.state) {
    document.title = `${dirty ? '● ' : ''}Promptbench · ${App.state.draft.name || 'Prompt 调试'}`;
  }
}

function renderAll() {
  ensureSelections();
  renderShell();
  renderCollectionNav();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderWorkbenchCase();
  renderModelSuggestions();
  renderProviders();
  renderSettings();
  renderHistoryList();
  renderOutput();
  renderPreviewState();
  if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  if (typeof renderLibrary === 'function') renderLibrary();
  if (typeof renderCaseEditor === 'function') renderCaseEditor();
  if (typeof renderIO === 'function') renderIO();
  if (typeof renderGroupEditor === 'function') renderGroupEditor();
  updateDirtyUI();
  refreshRunPlan();
  if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview(0);
}

/* ------------------------------------------------------------------ */
/* Sidebar: collections                                                */
/* ------------------------------------------------------------------ */

function renderCollectionNav() {
  const section = $('collection-section');
  if (!section) return;
  section.hidden = App.activeView !== 'cases';
  const list = $('collection-list');
  if (!list || !App.state) return;
  const allActive = !App.library.collectionId;
  const rows = [`
    <button type="button" class="collection-row ${allActive ? 'active' : ''}" data-collection-filter="">
      <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="3.5" width="10" height="13" rx="1.2"/><path d="M3.4 6v10.5h9"/></svg>
      <span class="collection-name">全部 Case</span>
      <span class="collection-count">${esc(String(App.state.cases.length))}</span>
    </button>`];
  for (const c of App.state.collections) {
    rows.push(`
      <button type="button" class="collection-row ${App.library.collectionId === c.id ? 'active' : ''}" data-collection-filter="${esc(c.id)}">
        <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.8 5.8h4l1.5 1.7h8.9v7.2a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4z"/></svg>
        <span class="collection-name" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="collection-count">${esc(String(c.case_ids.length))}</span>
      </button>`);
  }
  list.innerHTML = rows.join('');
}

/* ------------------------------------------------------------------ */
/* Editor: templates / messages                                        */
/* ------------------------------------------------------------------ */

function renderTemplateMismatch() {
  const btn = $('template-mismatch');
  if (!btn) return;
  const g = activeGroup();
  const editing = activeTemplate();
  if (!g || !editing) {
    btn.hidden = true;
    return;
  }
  const bound = templateById(g.template_id);
  if (bound && bound.id === editing.id) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = bound
    ? `编辑器「${editing.name || editing.id}」≠ 配置绑定「${bound.name || bound.id}」 · 切到绑定模板`
    : '配置绑定的模板缺失 · 请编辑配置';
  btn.title = '预览与运行始终使用对照配置绑定的模板，与编辑器当前浏览的模板无关。';
}

function focusBoundTemplate() {
  const g = activeGroup();
  const bound = g ? templateById(g.template_id) : null;
  if (!g || !bound) {
    toast('当前配置没有可用的绑定模板。', 'error');
    return;
  }
  App.activeTemplateId = bound.id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  renderInsertVarList();
  toast(`已切到配置「${g.name || g.id}」绑定的模板`, 'ok', 2000);
}

function renderTemplateOptions() {
  const sel = $('template-select');
  if (!sel || !App.state) return;
  const templates = App.state.templates;
  sel.innerHTML = templates.length
    ? templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name || t.id)}</option>`).join('')
    : '<option value="">（无模板）</option>';
  sel.value = App.activeTemplateId || '';
  const nameInput = $('template-name');
  if (nameInput) {
    nameInput.disabled = !templates.length;
    if (document.activeElement !== nameInput) nameInput.value = activeTemplate()?.name || '';
  }
  $('template-id').textContent = activeTemplate() ? `id: ${activeTemplate().id}` : '';
  $('dup-template-btn').disabled = !templates.length;
  $('del-template-btn').disabled = !templates.length;
}

function renderTemplateEditor() {
  if (!App.state) return;
  const tpl = activeTemplate();
  const msg = activeMessage();
  const ta = $('message-content');
  const role = $('message-role');
  const tabs = $('message-tabs');
  const tabTitle = tpl ? tpl.name : '模板消息';

  if (!tpl) {
    tabs.innerHTML = '<span class="message-tabs-empty">尚无模板。点击“新建模板”开始。</span>';
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = '请先新建模板。';
    role.disabled = true;
    $('add-message-btn').disabled = true;
    $('del-message-btn').disabled = true;
    $('insert-var-menu').hidden = true;
    updateLineInfo(ta, $('message-lineinfo'));
    updateEditorContextLabel();
    renderTemplateMismatch();
    return;
  }

  $('insert-var-menu').hidden = false;
  $('add-message-btn').disabled = false;
  if (!tpl.messages.length) {
    tabs.innerHTML = '<span class="message-tabs-empty">该模板没有消息。点击“＋ 消息”添加。</span>';
  } else {
    tabs.innerHTML = tpl.messages.map((m, index) => `
      <button type="button" class="message-tab role-${esc(m.role)}" role="tab"
        aria-selected="${index === App.activeMessageIndex ? 'true' : 'false'}"
        data-message-index="${index}">
        <span class="role-dot" aria-hidden="true"></span>${esc(`${index + 1} · ${m.role}`)}
      </button>
    `).join('');
  }
  ta.disabled = !msg;
  $('del-message-btn').disabled = !msg;
  role.disabled = !msg;
  if (msg) {
    ta.placeholder = '编写 Go text/template 消息内容，例如 {{ .CurrentText }}';
    if (ta.value !== msg.content) ta.value = msg.content;
    role.value = msg.role;
  } else {
    ta.value = '';
    ta.placeholder = '添加一条消息后开始编辑。';
    role.value = 'user';
  }
  updateLineInfo(ta, $('message-lineinfo'));
  updateEditorContextLabel();
  renderTemplateMismatch();
}

function updateEditorContextLabel() {
  const el = $('editor-context-label');
  if (!el) return;
  const tpl = activeTemplate();
  el.textContent = tpl ? `${tabTitleSafe(tpl)} · ${tpl.messages.length} 条消息 · 后端渲染` : '';
}

function tabTitleSafe(tpl) {
  return tpl ? (tpl.name || tpl.id) : '模板';
}

function setActiveCase(id) {
  if (!caseById(id)) return;
  App.activeCaseId = id;
  renderWorkbenchCase();
  renderTemplateEditor();
  renderInsertVarList();
  renderShell();
  markPreviewStale('已切换案例');
}

function renderInsertVarList() {
  const list = $('insert-var-list');
  if (!list) return;
  const c = activeCase();
  if (!c) {
    list.innerHTML = '<div class="menu-empty">尚未选择 case</div>';
    return;
  }
  const keys = Object.keys(c.variables || {}).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort();
  if (!keys.length) {
    list.innerHTML = '<div class="menu-empty">当前 case 没有可用变量，请在 Case 库中添加。</div>';
    return;
  }
  list.innerHTML = keys.map((k) => `<button type="button" data-var-insert="${esc(k)}">{{ .${esc(k)} }}</button>`).join('');
}

function insertVariableToken(key) {
  const tpl = activeTemplate();
  const msg = activeMessage();
  const ta = $('message-content');
  if (!tpl || !msg || !ta) return;
  const token = `{{ .${key} }}`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + token + ta.value.slice(end);
  msg.content = next;
  ta.value = next;
  const pos = start + token.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  updateLineInfo(ta, $('message-lineinfo'));
  updateDirtyUI();
  markPreviewStale('模板已修改');
}

function handleMessageInput() {
  const msg = activeMessage();
  const ta = $('message-content');
  if (!msg || !ta) return;
  msg.content = ta.value;
  updateLineInfo(ta, $('message-lineinfo'));
  updateDirtyUI();
  markPreviewStale('模板已修改');
}

function updateLineInfo(textarea, label) {
  if (!textarea || !label) return;
  const pos = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, pos);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  const col = pos - lastBreak;
  const total = textarea.value.split('\n').length;
  label.textContent = `行 ${line}，列 ${col} · ${total} 行`;
}

/* ------------------------------------------------------------------ */
/* Template CRUD                                                       */
/* ------------------------------------------------------------------ */

function openTemplateDialog() {
  const input = $('template-new-name');
  input.value = `模板 ${App.state.templates.length + 1}`;
  $('template-error').textContent = '';
  $('template-dialog').showModal();
  window.setTimeout(() => { input.focus(); input.select(); }, 0);
}

function createTemplate(name) {
  const ids = new Set(App.state.templates.map((t) => t.id));
  const id = uniqueId('template_', ids);
  const tpl = { id, name: name.trim(), messages: [{ role: 'user', content: '' }] };
  App.state.templates.push(tpl);
  App.activeTemplateId = id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('模板已新建');
}

function duplicateTemplate() {
  const src = activeTemplate();
  if (!src) return;
  const ids = new Set(App.state.templates.map((t) => t.id));
  const id = uniqueId('template_', ids);
  const copy = clone(src);
  copy.id = id;
  copy.name = `${src.name || src.id} 副本`;
  App.state.templates.push(copy);
  App.activeTemplateId = id;
  App.activeMessageIndex = 0;
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
  toast('已复制模板到草稿，保存后生效', 'ok');
}

function deleteTemplate() {
  const tpl = activeTemplate();
  if (!tpl) return;
  const groups = App.state.draft.groups.filter((g) => g.template_id === tpl.id);
  const extra = groups.length ? `\n\n草稿中引用它的 ${groups.length} 个对照配置也会被移除。` : '';
  if (!window.confirm(`删除模板「${tpl.name || tpl.id}」？${extra}\n\n已保存的历史批次不受影响。`)) return;
  App.state.templates = App.state.templates.filter((t) => t.id !== tpl.id);
  if (groups.length) {
    App.state.draft.groups = App.state.draft.groups.filter((g) => g.template_id !== tpl.id);
    if (!groupById(App.activeGroupId)) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  }
  App.activeTemplateId = App.state.templates[0]?.id || null;
  App.activeMessageIndex = 0;
  ensureSelections();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('模板已删除');
}

function addMessage() {
  const tpl = activeTemplate();
  if (!tpl) return;
  tpl.messages.push({ role: 'user', content: '' });
  App.activeMessageIndex = tpl.messages.length - 1;
  renderTemplateEditor();
  updateDirtyUI();
  markPreviewStale('模板消息已添加');
  $('message-content').focus();
}

function deleteMessage() {
  const tpl = activeTemplate();
  const msg = activeMessage();
  if (!tpl || !msg) return;
  if (tpl.messages.length <= 1) {
    toast('模板至少需要一条消息；如需清空请删除整个模板。', 'error');
    return;
  }
  tpl.messages.splice(App.activeMessageIndex, 1);
  App.activeMessageIndex = Math.min(App.activeMessageIndex, Math.max(0, tpl.messages.length - 1));
  renderTemplateEditor();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('模板消息已删除');
}

/* ------------------------------------------------------------------ */
/* Workbench: current case + group cards                               */
/* ------------------------------------------------------------------ */

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
  renderWorkbenchCase();
  renderTemplateMismatch();
  renderShell();
  markPreviewStale('已切换对照配置');
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

function deleteGroup(id) {
  const g = groupById(id);
  if (!g) return;
  if (!window.confirm(`删除对照配置「${g.name || g.id}」？历史批次不受影响。`)) return;
  App.state.draft.groups = App.state.draft.groups.filter((x) => x.id !== id);
  if (App.activeGroupId === id) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('对照配置已删除');
}

/* ------------------------------------------------------------------ */
/* Validation and run plan                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Selection preview (authoritative counts)                            */
/* ------------------------------------------------------------------ */

function selectionKey(selection) {
  return JSON.stringify({
    v: App.version,
    cases: [...(selection.case_ids || [])],
    collections: [...(selection.collection_ids || [])],
    excluded: [...(selection.excluded_case_ids || [])],
    groups: App.state.draft.groups.map((g) => [g.id, g.enabled, g.runs, g.language_routes]),
    runs: App.state.settings.default_runs
  });
}

function currentAppliedSelection() {
  const draft = App.state.draft;
  return {
    case_ids: [...draft.case_ids],
    collection_ids: [...draft.collection_ids],
    excluded_case_ids: [...draft.excluded_case_ids]
  };
}

function scheduleSelectionPreview(delay = 220) {
  if (App.selectionTimer) window.clearTimeout(App.selectionTimer);
  App.selectionTimer = window.setTimeout(() => {
    App.selectionTimer = null;
    refreshSelectionPreview({ silent: true });
  }, delay);
}

async function refreshSelectionPreview({ selection = null, silent = false } = {}) {
  if (!App.state) return null;
  const sel = selection || currentAppliedSelection();
  const key = selectionKey(sel);
  App.selectionPreviewKey = key;
  App.selectionPreviewStale = true;
  if (!silent && typeof renderSelectionPanel === 'function') renderSelectionPanel();
  try {
    const data = await apiPost('/api/selection/preview', {
      state_version: App.version,
      case_ids: sel.case_ids,
      collection_ids: sel.collection_ids,
      excluded_case_ids: sel.excluded_case_ids,
      groups: App.state.draft.groups.map(clone)
    });
    if (App.selectionPreviewKey !== key) return null;
    App.selectionPreview = { key, data, forStaging: !!selection };
    App.selectionPreviewStale = false;
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
    return data;
  } catch (err) {
    if (App.selectionPreviewKey !== key) return null;
    App.selectionPreviewStale = true;
    App.selectionPreview = { key, error: err.message, forStaging: !!selection };
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
    if (!silent && err.status === 409) {
      showBanner('运行范围预览冲突：服务端状态版本已变化（409）。请重新载入后再操作。', 'error', reloadFromServer);
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Save / reload                                                       */
/* ------------------------------------------------------------------ */

function editableStateSnapshot() {
  return {
    templates: clone(App.state.templates),
    providers: clone(App.state.providers),
    settings: clone(App.state.settings),
    draft: clone(App.state.draft)
  };
}

async function saveState({ silent = false } = {}) {
  if (!App.state) return false;
  if (App.saving || App.mutating) return false;
  if (App.settingsError.length) {
    showBanner(`设置存在错误，未保存：${App.settingsError[0]}`, 'error');
    return false;
  }
  if (!isDirty() && !hasPendingCredentials()) {
    if (!silent) toast('没有需要保存的更改', 'info', 1800);
    return true;
  }
  App.saving = true;
  const gen = App.editGeneration;
  updateDirtyUI();
  refreshRunPlan();
  const editable = editableStateSnapshot();
  const submittedMutations = new Map();
  for (const [id, mutation] of App.credentialMutations) submittedMutations.set(id, { ...mutation });
  const credentialUpdates = {};
  for (const [id, mutation] of submittedMutations) {
    if (mutation.kind === 'set') {
      if (editable.providers.some((p) => p.id === id)) credentialUpdates[id] = { action: 'set', key: mutation.value };
    } else if (mutation.kind === 'clear') {
      credentialUpdates[id] = { action: 'clear' };
    }
  }
  // Generic PUT is narrow on purpose: cases/collections are authoritative through dedicated
  // endpoints, so browser number normalization can never rewrite imported Case input.
  const body = {
    version: App.version,
    templates: editable.templates,
    providers: editable.providers,
    settings: editable.settings,
    draft: editable.draft
  };
  if (Object.keys(credentialUpdates).length) body.credential_updates = credentialUpdates;
  try {
    const { payload } = await apiRaw('/api/state', { method: 'PUT', body });
    const serverState = normalizeState(clone(payload));
    const serverJson = stableStringify(serverState);
    App.version = serverState.version;
    App.credentials = normalizeCredentials(payload.credentials);
    App.savedAt = new Date();
    App.savedJson = serverJson;
    if (gen === App.editGeneration) {
      const keepActiveCase = App.activeCaseId;
      const keepActiveGroup = App.activeGroupId;
      App.state = serverState;
      ensureSelections();
      if (caseById(keepActiveCase)) App.activeCaseId = keepActiveCase;
      if (groupById(keepActiveGroup)) App.activeGroupId = keepActiveGroup;
      renderTemplateOptions();
      renderTemplateEditor();
      renderGroupCards();
      renderSettings();
      renderWorkbenchCase();
    } else {
      App.state.version = App.version;
      showBanner('保存期间有新编辑：服务端已保存提交时的版本，当前页面内容未被覆盖。确认后可再次保存。', 'warn');
    }
    for (const [id, mutation] of submittedMutations) {
      const current = App.credentialMutations.get(id);
      if (current && sameValue(current, mutation)) App.credentialMutations.delete(id);
    }
    hideBanner();
    clearEditorRenderError();
    renderProviders();
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
    if (!silent) {
      toast(submittedMutations.size
        ? '草稿与手动凭据已保存（凭据由后端加密存储）。运行中的批次继续使用其冻结快照。'
        : '草稿已保存。运行中的批次继续使用其冻结快照。', 'ok');
    }
    if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview(0);
    return true;
  } catch (err) {
    if (err.status === 409) {
      showBanner('保存冲突：服务端状态已被其他窗口或会话修改。当前草稿未覆盖服务端；请重新载入后合并更改。', 'error', reloadFromServer);
      toast('保存失败：版本冲突（409）', 'error');
    } else {
      showBanner(`保存失败：${err.message}`, 'error');
      if (/template|render|parse|模板|消息|message/i.test(err.message)) {
        showEditorRenderError(`保存失败（模板校验）：${err.message}`);
      }
      toast(`保存失败：${err.message}`, 'error');
    }
    return false;
  } finally {
    App.saving = false;
    updateDirtyUI();
    refreshRunPlan();
  }
}

async function ensureSaved() {
  if (!App.state) return false;
  if (!isDirty() && !hasPendingCredentials()) return true;
  const ok = await saveState({ silent: true });
  if (!ok) return false;
  if (isDirty() || hasPendingCredentials()) {
    markPreviewStale('保存期间草稿或凭据又有编辑');
    showBanner('保存期间草稿又被编辑，本次操作未执行。请确认当前内容后再次点击。', 'warn');
    toast('保存期间草稿有新的编辑，已取消本次预览/运行', 'error', 5000);
    refreshRunPlan();
    return false;
  }
  return true;
}

async function reloadFromServer() {
  if (hasUnsavedWork() && !window.confirm('重新载入会丢弃本地未保存更改（包括编辑器内容、待保存的手动密钥）。继续？')) return false;
  App.credentialMutations.clear();
  try {
    await loadState();
    App.preview = null;
    App.previewStale = true;
    App.historyDetail = null;
    App.caseEditor = null;
    App.groupEditor = null;
    App.io.preview = null;
    hideBanner();
    renderAll();
    renderPreviewState();
    await refreshRuns({ quiet: true });
    refreshPreview({ silent: true });
    toast('已重新载入服务端状态', 'ok');
    return true;
  } catch (err) {
    showBanner(`重新载入失败：${err.message}`, 'error', reloadFromServer);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function markPreviewStale(reason) {
  App.previewToken += 1;
  App.previewStale = true;
  const state = $('preview-state');
  if (state) {
    state.textContent = '需刷新';
    state.className = 'pill subtle';
    if (reason) state.title = reason;
  }
}

function renderPreviewState() {
  const state = $('preview-state');
  if (!state) return;
  if (!App.preview) {
    state.textContent = '未预览';
    state.className = 'pill subtle';
    $('preview-endpoint').textContent = '—';
    $('preview-hash').textContent = '—';
    $('preview-protocol').textContent = '—';
    if ($('preview-language')) $('preview-language').textContent = '—';
    $('preview-endpoint').title = '';
    $('preview-hash').title = '';
    $('preview-protocol').title = '';
    $('preview-body').textContent = '选择案例与对照配置后点击“刷新预览”。';
    const extra = $('preview-extra');
    if (extra) extra.hidden = true;
    $('preview-headers').textContent = '';
    $('preview-raw-request').textContent = '';
  } else {
    state.textContent = App.previewStale ? '需刷新' : '实时';
    state.className = App.previewStale ? 'pill subtle' : 'pill ok';
  }
}

async function refreshPreview({ silent = false } = {}) {
  if (!App.state) return;
  const token = ++App.previewToken;
  const btn = $('refresh-preview-btn');
  const initialCase = activeCase();
  const initialGroup = activeGroup();
  if (!initialCase || !initialGroup) {
    App.preview = null;
    App.previewStale = true;
    $('preview-error').textContent = '需要选择一个 case 和一个对照配置。';
    renderPreviewState();
    return;
  }
  btn.disabled = true;
  $('preview-error').textContent = '';
  $('preview-state').textContent = '加载中…';
  $('preview-state').className = 'pill subtle';
  try {
    const ok = await ensureSaved();
    if (token !== App.previewToken) return;
    if (!ok) {
      App.previewStale = true;
      renderPreviewState();
      return;
    }
    const c = activeCase();
    const g = activeGroup();
    if (!c || !g) {
      App.preview = null;
      App.previewStale = true;
      $('preview-error').textContent = '选择已改变，请重新预览。';
      renderPreviewState();
      return;
    }
    const caseId = c.id;
    const groupSnapshot = clone(g);
    const stateVersion = App.version;
    const res = await apiPost('/api/preview', { case_id: caseId, group: groupSnapshot, state_version: stateVersion });
    if (token !== App.previewToken) return;
    App.preview = res;
    App.previewStale = false;
    const req = res.request;
    $('preview-body').textContent = JSON.stringify(req, null, 2);
    $('preview-protocol').textContent = res.protocol ? protocolLabel(res.protocol) : '—';
    $('preview-protocol').title = res.protocol || '';
    const method = res.method ? String(res.method) : '';
    const endpoint = res.endpoint || '';
    const requestLine = method && endpoint ? `${method} ${endpoint}` : (endpoint || '—');
    $('preview-endpoint').textContent = requestLine;
    $('preview-endpoint').title = requestLine;
    $('preview-hash').textContent = res.prompt_hash || '—';
    $('preview-hash').title = res.prompt_hash || '';
    if ($('preview-language')) {
      const lr = res.language_resolution;
      $('preview-language').textContent = lr
        ? `${lr.source_language || '（未设置）'} → ${(lr.targets || []).map((t) => t.key).join(', ') || '—'}${lr.used_default ? ' · 默认' : ''}`
        : '—';
      $('preview-language').title = $('preview-language').textContent;
    }
    const headers = res.headers && typeof res.headers === 'object' && !Array.isArray(res.headers) ? res.headers : null;
    const hasHeaders = !!headers && Object.keys(headers).length > 0;
    $('preview-headers').textContent = hasHeaders ? pretty(headers) : '（无额外非认证请求头）';
    $('preview-raw-request').textContent = res.raw_request || '（服务端未提供原始正文字段）';
    const extra = $('preview-extra');
    if (extra) extra.hidden = !(hasHeaders || res.raw_request);
    renderPreviewState();
    clearEditorRenderError();
    if (!silent) toast('预览已按服务端当前保存状态生成', 'ok', 1800);
  } catch (err) {
    if (token !== App.previewToken) return;
    App.previewStale = true;
    if (err.status === 409) {
      $('preview-error').textContent = `预览冲突：${err.message}`;
      $('preview-state').textContent = '冲突';
      $('preview-state').className = 'pill err';
      showEditorRenderError('预览未执行：服务端状态版本已变化（409）。请重新载入后再预览，避免展示过期请求。');
      showBanner('预览冲突：服务端状态版本已变化（可能另一标签页保存了草稿）。未使用过期状态生成预览。', 'error', reloadFromServer);
      return;
    }
    $('preview-error').textContent = `预览失败：${err.message}`;
    $('preview-state').textContent = '错误';
    $('preview-state').className = 'pill err';
    showEditorRenderError(`模板渲染 / 请求预览失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function showEditorRenderError(message) {
  const el = $('editor-render-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearEditorRenderError() {
  const el = $('editor-render-error');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

async function copyPreview() {
  const text = $('preview-body').textContent;
  if (!App.preview || !text) {
    toast('暂无请求预览可复制', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('请求 JSON 已复制', 'ok', 1800);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('请求 JSON 已复制', 'ok', 1800); }
    catch { toast('复制失败，请手动选择文本', 'error'); }
    ta.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Runs: start, poll, stop, resume                                     */
/* ------------------------------------------------------------------ */

async function startRun() {
  if (!App.state || App.saving || App.loading || App.mutating) return;
  let plan = computeRunPlan();
  if (plan.errors.length) {
    showBanner(`无法启动：${plan.errors[0]}`, 'error');
    refreshRunPlan();
    return;
  }
  if (hasKnownActiveBatch()) {
    showBanner('已有批次正在运行或停止中。同一时间只允许一个批次；请等待其完成或先停止。', 'warn');
    return;
  }
  const ok = await ensureSaved();
  if (!ok) return;
  plan = computeRunPlan();
  if (plan.errors.length) {
    showBanner(`无法启动：${plan.errors[0]}`, 'error');
    refreshRunPlan();
    return;
  }
  if (hasKnownActiveBatch()) {
    showBanner('已有批次正在运行或停止中。同一时间只允许一个批次。', 'warn');
    return;
  }
  App.loading = true;
  refreshRunPlan();
  App.outputFilter = { group: '', case: '', status: '' };
  App.lastFilterSignature = '';
  App.outputScrollTop = 0;
  App.expandedResults.clear();
  try {
    const body = {
      name: (App.state.draft.name || '').trim() || '未命名批次',
      case_ids: [...App.state.draft.case_ids],
      collection_ids: [...App.state.draft.collection_ids],
      excluded_case_ids: [...App.state.draft.excluded_case_ids],
      groups: App.state.draft.groups.filter((g) => g.enabled).map(clone),
      concurrency: clampInt(App.state.settings.concurrency, 1, 20, 20),
      state_version: App.version
    };
    const batch = await apiPost('/api/runs', body);
    App.currentRunId = batch.id;
    App.currentDetail = null;
    App.expandedResults.clear();
    setView('workbench', { force: true });
    setOutputTab('results');
    await loadRunIntoOutput(batch.id);
    startPolling();
    await refreshRuns({ quiet: true });
    toast(`批次 #${batch.id} 已启动`, 'ok');
  } catch (err) {
    if (err.status === 409) {
      showBanner('无法启动（服务端 409）：可能已有批次运行/停止中，或另一标签页修改了服务端草稿版本。未启动新批次。', 'warn');
      await refreshRuns({ quiet: true });
    } else {
      showBanner(`启动批次失败：${err.message}`, 'error');
    }
    toast(`启动失败：${err.message}`, 'error');
  } finally {
    App.loading = false;
    updateDirtyUI();
    refreshRunPlan();
  }
}

async function loadRunIntoOutput(id) {
  if (!id) return;
  const requested = id;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(requested)}`);
    if (App.currentRunId !== requested) return;
    App.currentDetail = detail;
    App.expandedResults.clear();
    renderOutput();
    refreshRunPlan();
    if (batchActive(detail.batch)) {
      App.batchSeenActive = true;
      startPolling();
    } else {
      stopPolling();
    }
  } catch (err) {
    showBanner(`载入运行 #${requested} 失败：${err.message}`, 'error');
  }
}

function startPolling() {
  if (App.pollTimer) return;
  App.pollTimer = window.setInterval(pollCurrentRun, 1600);
  pollCurrentRun();
}

function stopPolling() {
  if (App.pollTimer) {
    window.clearInterval(App.pollTimer);
    App.pollTimer = null;
  }
}

async function pollCurrentRun() {
  if (!App.currentRunId || App.pollBusy) return;
  App.pollBusy = true;
  const requested = App.currentRunId;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(requested)}`);
    App.pollFailures = 0;
    if (App.currentRunId !== requested) return;
    const wasActive = App.currentDetail ? batchActive(App.currentDetail.batch) : false;
    const nowActive = batchActive(detail.batch);
    App.currentDetail = detail;
    renderOutput();
    refreshRunPlan();
    App.pollTicks += 1;
    if (App.pollTicks % 4 === 0) refreshRuns({ quiet: true });
    if (!nowActive) {
      stopPolling();
      await refreshRuns({ quiet: true });
      if (wasActive || App.batchSeenActive) {
        const summary = detail.batch;
        toast(`批次 #${summary.id} ${statusLabel(summary.status)}：完成 ${summary.completed || 0}/${summary.total || 0}，失败 ${summary.failed || 0}`, summary.failed ? 'error' : 'ok', 5000);
        App.batchSeenActive = false;
      }
    }
  } catch (err) {
    App.pollFailures += 1;
    if (App.pollFailures === 3) {
      showBanner(`轮询运行状态失败：${err.message}。将持续重试；编辑器内容不会被改动。`, 'warn');
    }
  } finally {
    App.pollBusy = false;
  }
}

async function stopRun() {
  const detail = App.currentDetail;
  if (!detail || !batchActive(detail.batch)) return;
  const btn = $('stop-btn');
  btn.disabled = true;
  try {
    const summary = await apiPost(`/api/runs/${encodeURIComponent(detail.batch.id)}/stop`, {});
    if (App.currentDetail && App.currentDetail.batch.id === summary.id) App.currentDetail.batch = summary;
    renderOutput();
    refreshRunPlan();
    toast('已请求停止：不再派发新请求，在途请求会完成。', 'ok');
    startPolling();
  } catch (err) {
    showBanner(`停止失败：${err.message}`, 'error');
    toast(`停止失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refreshRuns({ quiet = false } = {}) {
  try {
    const payload = await apiGet('/api/runs');
    App.runs = Array.isArray(payload) ? payload : [];
    App.runsLoaded = true;
    App.lastRunsSignature = JSON.stringify(App.runs.map((b) => [b.id, b.status, b.completed, b.failed, b.total]));
    renderHistoryList();
    refreshRunPlan();
  } catch (err) {
    if (!quiet) {
      showBanner(`载入运行列表失败：${err.message}`, 'error');
      toast(`载入运行列表失败：${err.message}`, 'error');
    }
  }
}

async function resumeActiveRun() {
  const active = App.runs.find(batchActive);
  if (!active) return;
  App.currentRunId = active.id;
  await loadRunIntoOutput(active.id);
  if (App.currentDetail && batchActive(App.currentDetail.batch)) {
    startPolling();
    setOutputTab('results');
  }
}

/* ------------------------------------------------------------------ */
/* Output panel                                                        */
/* ------------------------------------------------------------------ */

function setOutputTab(tab) {
  App.outputTab = tab;
  const isResults = tab === 'results';
  const tabResults = $('out-tab-results');
  const tabSnapshot = $('out-tab-snapshot');
  tabResults.setAttribute('aria-selected', isResults ? 'true' : 'false');
  tabSnapshot.setAttribute('aria-selected', isResults ? 'false' : 'true');
  $('output-results-panel').hidden = !isResults;
  $('output-snapshot-panel').hidden = isResults;
  $('output-toolbar').hidden = !isResults;
}

function syncFilterOptions(detail) {
  const results = detail.results || [];
  const groups = new Map();
  const cases = new Map();
  for (const r of results) {
    if (r.group_id) groups.set(r.group_id, r.group_name || r.group_id);
    if (r.case_id) cases.set(r.case_id, r.case_name || r.case_id);
  }
  const signature = JSON.stringify([[...groups.entries()], [...cases.entries()]]);
  if (signature !== App.lastFilterSignature) {
    App.lastFilterSignature = signature;
    const gSel = $('filter-group');
    const cSel = $('filter-case');
    gSel.innerHTML = '<option value="">全部</option>' + [...groups.entries()]
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    cSel.innerHTML = '<option value="">全部</option>' + [...cases.entries()]
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  }
  const gSel = $('filter-group');
  const cSel = $('filter-case');
  gSel.value = [...gSel.options].some((o) => o.value === App.outputFilter.group) ? App.outputFilter.group : '';
  cSel.value = [...cSel.options].some((o) => o.value === App.outputFilter.case) ? App.outputFilter.case : '';
  App.outputFilter.group = gSel.value;
  App.outputFilter.case = cSel.value;
  $('filter-status').value = App.outputFilter.status || '';
  void detail;
}

function captureResultState() {
  const panel = $('output-results-panel');
  if (panel) App.outputScrollTop = panel.scrollTop;
  document.querySelectorAll('#result-list details[data-rid]').forEach((d) => {
    if (d.open) App.expandedResults.add(d.dataset.rid);
    else App.expandedResults.delete(d.dataset.rid);
  });
}

function renderOutput() {
  const detail = App.currentDetail;
  const batch = detail?.batch || null;
  const currentBatchId = batch?.id || null;
  const sameRun = currentBatchId !== null && App.outputRenderRunId === currentBatchId;
  if (sameRun) captureResultState();
  else {
    App.outputScrollTop = 0;
    App.outputRenderRunId = currentBatchId;
  }
  const stopBtn = $('stop-btn');
  const statusLabelEl = $('run-status-label');
  const progressTrack = $('progress-track');
  const progressFill = $('progress-fill');
  const progressText = $('progress-text');
  const empty = $('output-empty');
  const list = $('result-list');

  if (!batch) {
    statusLabelEl.textContent = '尚无运行';
    statusLabelEl.className = 'progress-label';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressTrack.setAttribute('aria-valuemax', '0');
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 0';
    stopBtn.hidden = true;
    $('batch-meta').textContent = '';
    empty.hidden = false;
    empty.textContent = '尚未运行。选择案例和对照配置后点击“运行”。';
    list.innerHTML = '';
    $('result-count').textContent = '';
    App.outputRenderRunId = null;
    App.snapshotRenderedFor = null;
    renderOutputSnapshot();
    return;
  }

  const finished = (batch.completed || 0) + (batch.failed || 0) + (batch.cancelled || 0) + (batch.interrupted || 0);
  const active = batchActive(batch);
  statusLabelEl.textContent = `${statusLabel(batch.status)}${batch.in_flight ? ` · 在途 ${batch.in_flight}` : ''}`;
  statusLabelEl.className = `progress-label${active ? ' running' : ''}${batch.failed ? ' err' : ''}`;
  progressTrack.setAttribute('aria-valuemax', String(batch.total || 0));
  progressTrack.setAttribute('aria-valuenow', String(finished));
  progressTrack.setAttribute('aria-valuetext', `${finished} / ${batch.total || 0}，在途 ${batch.in_flight || 0}`);
  progressFill.style.width = batch.total ? `${Math.min(100, (finished / batch.total) * 100)}%` : '0%';
  progressText.textContent = `${finished} / ${batch.total || 0}`;
  stopBtn.hidden = !active;
  stopBtn.disabled = batch.status === 'stopping';
  stopBtn.innerHTML = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/></svg>${batch.status === 'stopping' ? '停止中…' : '停止运行'}`;
  $('batch-meta').textContent = `#${batch.id} · ${batch.name || ''} · 并发 ${batch.concurrency} · ${fmtDateTime(batch.created_at)}`;

  const results = detail.results || [];
  empty.hidden = results.length > 0;
  empty.textContent = active
    ? '批次已创建，正在等待首次请求派发…'
    : '该批次没有结果记录。';

  syncFilterOptions(detail);
  const filtered = results.filter((r) => {
    if (App.outputFilter.group && r.group_id !== App.outputFilter.group) return false;
    if (App.outputFilter.case && r.case_id !== App.outputFilter.case) return false;
    if (App.outputFilter.status && r.status !== App.outputFilter.status) return false;
    return true;
  });
  $('result-count').textContent = `${filtered.length} / ${results.length} 条`;
  list.innerHTML = filtered.length
    ? filtered.map((r) => resultRowHtml(r)).join('')
    : `<div class="empty-state">${results.length ? '没有匹配当前筛选条件的结果。' : '等待结果…'}</div>`;
  const panel = $('output-results-panel');
  if (panel) panel.scrollTop = App.outputScrollTop;
  renderOutputSnapshot();
}

function resultRowHtml(r) {
  const open = App.expandedResults.has(r.id) ? 'open' : '';
  const rawRequest = r.raw_request || (r.request ? pretty(r.request) : '');
  const rawResponse = r.raw_response || '';
  const output = r.output || '';
  const error = r.error || '';
  const snippetSource = output || error || (r.status === 'running' ? '正在等待模型响应…' : r.status === 'pending' ? '尚未派发' : '（无输出）');
  const snippet = String(snippetSource).replace(/\s+/g, ' ').slice(0, 240);
  const started = r.started_at ? fmtTime(r.started_at) : '—';
  return `
    <details class="result-details" data-rid="${esc(r.id)}" ${open}>
      <summary class="result-summary">
        <span class="time">${esc(started)}</span>
        <span class="case" title="${esc(`${r.case_name || ''} ${r.case_id || ''}`)}"><span class="rep">#${esc(String(r.iteration ?? ''))}</span> ${esc(r.case_name || r.case_id || '—')}</span>
        <span class="model" title="${esc(r.model || '')}">${esc(r.model || '—')}</span>
        <span>${statusTag(r.status, ATTEMPT_STATUS)}</span>
        <span class="dur">${esc(fmtDuration(r.duration_ms))}</span>
        <span class="snippet" title="${esc(snippetSource)}">${esc(snippet)}</span>
      </summary>
      <div class="result-raw">
        <div class="raw-meta">
          <span>组 <span class="mono">${esc(r.group_name || r.group_id || '—')}</span></span>
          <span>轮次 <span class="mono">${esc(String(r.iteration ?? '—'))}</span></span>
          ${r.method ? `<span>方法 <span class="mono">${esc(r.method)}</span></span>` : ''}
          ${r.endpoint ? `<span>Endpoint <span class="mono">${esc(r.endpoint)}</span></span>` : ''}
          <span>模型 <span class="mono">${esc(r.model || '—')}</span></span>
          <span>响应模型 <span class="mono">${esc(r.response_model || '—')}</span></span>
          <span>HTTP <span class="mono">${esc(String(r.http_status || '—'))}</span></span>
          <span>耗时 <span class="mono">${esc(fmtDuration(r.duration_ms))}</span></span>
          <span>hash <span class="mono">${esc(r.prompt_hash || '—')}</span></span>
        </div>
        ${r.headers && typeof r.headers === 'object' ? `<div class="raw-block"><h4>非认证请求头</h4><pre>${esc(pretty(r.headers))}</pre></div>` : ''}
        <div class="raw-block">
          <h4>原始请求 raw_request</h4>
          <pre>${esc(clipText(rawRequest) || '（尚未派发）')}</pre>
        </div>
        <div class="raw-block">
          <h4>原始响应 raw_response</h4>
          <pre>${esc(clipText(rawResponse) || '（无响应正文）')}</pre>
        </div>
        ${output ? `<div class="raw-block"><h4>解析输出 output</h4><pre>${esc(clipText(output))}</pre></div>` : ''}
        ${error ? `<div class="raw-block"><h4>错误 error</h4><pre>${esc(clipText(error))}</pre></div>` : ''}
      </div>
    </details>`;
}

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

function renderOutputSnapshot() {
  const el = $('output-snapshot');
  const empty = $('output-snapshot-empty');
  const detail = App.currentDetail;
  if (!el) return;
  if (!detail || !detail.snapshot) {
    el.innerHTML = '';
    App.snapshotRenderedFor = null;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const runId = detail.batch?.id || null;
  if (runId && App.snapshotRenderedFor === runId && el.innerHTML) return;
  el.innerHTML = snapshotHtml(detail.snapshot);
  App.snapshotRenderedFor = runId;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function renderHistoryList() {
  const list = $('history-run-list');
  if (!list) return;
  $('history-count').textContent = String(App.runs.length);
  $('history-meta').textContent = `${App.runs.length} 个持久化批次 · 历史保存在服务端 SQLite`;
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

async function loadHistoryDetail(id) {
  App.historySelectedId = id;
  renderHistoryList();
  const empty = $('history-detail-empty');
  const detailEl = $('history-detail');
  empty.hidden = false;
  empty.textContent = `载入批次 #${id}…`;
  detailEl.hidden = true;
  try {
    const detail = await apiGet(`/api/runs/${encodeURIComponent(id)}`);
    if (App.historySelectedId !== id) return;
    App.historyDetail = detail;
    empty.hidden = true;
    detailEl.hidden = false;
    renderHistoryDetail(detail);
  } catch (err) {
    empty.hidden = false;
    empty.textContent = `载入失败：${err.message}`;
    toast(`载入批次失败：${err.message}`, 'error');
  }
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
          <button type="button" class="btn tiny" data-run-replay="${esc(b.id)}">按冻结快照复跑</button>
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
      <section class="detail-section">
        <h3>冻结快照</h3>
        ${snapshotHtml(detail.snapshot)}
      </section>
      <section class="detail-section">
        <h3>结果（${results.length}）</h3>
        <div class="result-list detail-results">
          ${results.length ? results.map((r) => resultRowHtml(r)).join('') : '<div class="empty-state">没有结果记录。</div>'}
        </div>
      </section>
    </div>`;
}

function exportRun(id) {
  const a = document.createElement('a');
  a.href = `/api/runs/${encodeURIComponent(id)}/export`;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function replayRun(id) {
  if (hasKnownActiveBatch()) {
    showBanner('无法复跑：已有批次正在运行或停止中（同一时间只允许一个批次）。', 'warn');
    return;
  }
  try {
    const batch = await apiPost(`/api/runs/${encodeURIComponent(id)}/replay`, {});
    App.currentRunId = batch.id;
    App.currentDetail = null;
    App.expandedResults.clear();
    setView('workbench', { force: true });
    setOutputTab('results');
    await loadRunIntoOutput(batch.id);
    startPolling();
    await refreshRuns({ quiet: true });
    toast(`已按冻结快照创建新批次 #${batch.id}`, 'ok');
  } catch (err) {
    if (err.status === 409) {
      showBanner('无法复跑：已有批次正在运行或停止中（服务端 409）。', 'warn');
      await refreshRuns({ quiet: true });
    } else {
      showBanner(`复跑失败：${err.message}`, 'error');
    }
    toast(`复跑失败：${err.message}`, 'error');
  }
}

async function openRunInOutput(id) {
  App.currentRunId = id;
  App.expandedResults.clear();
  App.outputFilter = { group: '', case: '', status: '' };
  App.lastFilterSignature = '';
  setView('workbench', { force: true });
  setOutputTab('results');
  await loadRunIntoOutput(id);
  if (App.currentDetail && batchActive(App.currentDetail.batch)) startPolling();
}

/* ------------------------------------------------------------------ */
/* Compare runs                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

function updateProviderCatalogNote() {
  const el = $('provider-catalog-note');
  if (!el) return;
  if (!App.providerProtocolsLoaded) {
    el.hidden = false;
    el.textContent = `协议目录不可用：${App.providerCatalogError || '无法读取 /api/protocols'}。修复后才能验证或运行 Provider。`;
  } else if (!App.providerProtocols.length) {
    el.hidden = false;
    el.textContent = '服务端没有已实现的 Provider 协议；当前无法安全运行。';
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function providerProtocolTag(p) {
  const proto = protocolById(p.protocol);
  if (proto) return `<span class="protocol-tag">${esc(proto.name || proto.id)}</span>`;
  return `<span class="protocol-tag unknown">${esc(p.protocol || '未设置协议')}</span>`;
}

function credentialSourceBadge(meta) {
  if (!meta) return { cls: '', label: '未验证' };
  switch (meta.source) {
    case 'manual': return { cls: 'manual', label: '手动密钥' };
    case 'env': return { cls: meta.env_available ? 'env' : 'missing', label: meta.env_available ? '环境变量可用' : '环境变量缺失' };
    case 'anonymous': return { cls: 'noauth', label: '无认证' };
    case 'invalid': return { cls: 'missing', label: '凭据无效' };
    case 'missing': return { cls: 'missing', label: '缺少凭据' };
    default: return { cls: 'missing', label: '凭据状态未知' };
  }
}

function providerCredentialCellHtml(p) {
  const meta = credentialMeta(p.id);
  const pending = pendingCredentialFor(p.id);
  const badges = [];
  if (pending && pending.kind === 'set') badges.push('<span class="cred-badge pending">待保存：手动密钥</span>');
  if (pending && pending.kind === 'clear') badges.push('<span class="cred-badge pending">待保存：清除手动</span>');
  if (meta) {
    const src = credentialSourceBadge(meta);
    badges.push(`<span class="cred-badge ${esc(src.cls)}">${esc(src.label)}</span>`);
    if (meta.manual_set && meta.source !== 'manual') badges.push('<span class="cred-badge manual">手动已保存</span>');
    if (meta.requires_auth && !meta.available) badges.push('<span class="cred-badge missing">不可用</span>');
    else if (!meta.requires_auth && meta.source !== 'anonymous') badges.push('<span class="cred-badge noauth">允许无认证</span>');
  } else if (!pending) {
    badges.push('<span class="cred-badge">未验证</span>');
  }
  const envBits = p.api_key_env
    ? `env: ${p.api_key_env} · ${meta ? (meta.env_available ? '可用' : '缺失') : '未验证'}`
    : '无环境变量引用';
  return `<div class="cred-badges">${badges.join('')}</div><div class="cred-meta">${esc(envBits)}</div>`;
}

function renderProviders() {
  const body = $('providers-body');
  if (!body || !App.state) return;
  updateProviderCatalogNote();
  const providers = App.state.providers;
  $('provider-count').textContent = `${providers.length}`;
  if (!providers.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">尚无 Provider。选择服务端已实现的协议，配置 endpoint 与凭据后才能运行。</div></td></tr>';
    renderModelSuggestions();
    return;
  }
  body.innerHTML = providers.map((p) => {
    const refs = App.state.draft.groups.filter((g) => g.provider_id === p.id).length;
    return `<tr>
      <td>
        <div>${esc(p.name || p.id)}${refs ? ` <span class="pill subtle">${refs} 配置</span>` : ''}</div>
        <div class="cred-meta">${esc(p.id)}</div>
      </td>
      <td class="protocol-cell">${providerProtocolTag(p)}</td>
      <td class="url-cell" title="${esc(p.base_url)}">${esc(p.base_url || '—')}</td>
      <td class="provider-credential-cell">${providerCredentialCellHtml(p)}</td>
      <td class="actions">
        <div class="row-actions">
          <button type="button" class="mini-btn" data-provider-edit="${esc(p.id)}" title="编辑" aria-label="${esc(`编辑 Provider ${p.name || p.id}`)}">${ICON_EDIT}</button>
          <button type="button" class="mini-btn danger" data-provider-delete="${esc(p.id)}" title="删除" aria-label="${esc(`删除 Provider ${p.name || p.id}`)}">${ICON_TRASH}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderModelSuggestions();
}

function renderProviderProtocolOptions(selected) {
  const sel = $('provider-type');
  if (!sel) return;
  const options = [];
  if (!App.providerProtocols.length) {
    options.push('<option value="">（协议目录不可用）</option>');
    sel.disabled = true;
  } else {
    sel.disabled = false;
    if (selected && !protocolById(selected)) {
      options.push(`<option value="${esc(selected)}" selected disabled>未知协议：${esc(selected)}（不可运行）</option>`);
    }
    options.push(...App.providerProtocols.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`));
  }
  sel.innerHTML = options.join('');
  const fallback = selected || (App.providerProtocols[0] ? App.providerProtocols[0].id : '');
  sel.value = fallback;
  if (!selected && App.providerProtocols[0]) sel.value = App.providerProtocols[0].id;
  updateProviderProtocolHint();
}

function updateProviderProtocolHint() {
  const sel = $('provider-type');
  if (!sel) return;
  const proto = protocolById(sel.value);
  const typeHint = $('provider-type-hint');
  const baseHint = $('provider-base-hint');
  const credNote = $('provider-credential-note');
  if (!proto) {
    typeHint.textContent = sel.value
      ? `协议「${sel.value}」未在服务端实现，无法运行；请选择已实现协议。`
      : '服务端没有可用协议目录，无法验证 Provider。';
    typeHint.className = 'provider-type-hint warn';
    baseHint.textContent = '实际请求 endpoint 由服务端按协议生成。';
    return;
  }
  typeHint.className = 'provider-type-hint';
  const roles = Array.isArray(proto.roles) && proto.roles.length ? ` · 角色 ${proto.roles.join(' / ')}` : '';
  typeHint.textContent = `已实现协议：${proto.name || proto.id}${roles}`;
  baseHint.textContent = proto.base_url_hint || '实际请求 endpoint 由服务端按协议生成。';
  credNote.textContent = `${proto.credential_hint ? proto.credential_hint + '。' : ''}优先级：手动密钥 → 环境变量 → 无认证（仅当协议允许）。手动密钥由后端加密保存在本机数据目录；备份数据库时需一并备份 credentials.key。密钥不会进入浏览器存储、草稿 JSON、历史请求、快照或导出。`;
}

function updateProviderCredentialUI() {
  const id = App.providerDialog.id;
  const p = id ? providerById(id) : null;
  const meta = id ? credentialMeta(id) : null;
  const pending = id ? pendingCredentialFor(id) : null;
  const clearKey = App.providerDialog.clearKey === true;
  const status = $('provider-credential-status');
  const hint = $('provider-secret-hint');
  const input = $('provider-api-key');
  const clearBtn = $('provider-clear-key');
  const undoBtn = $('provider-undo-credential');
  if (!status || !hint || !input || !clearBtn || !undoBtn) return;

  const envInput = $('provider-env');
  const envName = envInput ? envInput.value.trim() : (p && p.api_key_env ? p.api_key_env : '');
  const envUnchanged = !!p && envName === p.api_key_env;
  const envBits = envName
    ? `环境变量 ${envName}：${meta && envUnchanged ? (meta.env_available ? '可用' : '缺失') : '保存后验证'}`
    : '未配置环境变量回退';
  const authBits = meta ? (meta.requires_auth ? '协议需要认证' : '协议允许无认证') : '认证要求保存后验证';
  const fallback = meta && envUnchanged
    ? (meta.env_available ? '将回退到环境变量' : (envName ? '环境变量当前不可用' : '将按协议允许的无认证方式'))
    : '保存后由服务端确认凭据回退';

  let label = '';
  let cls = 'pill subtle';
  let hintText = '';
  let placeholder = '留空不设置手动密钥';
  let canClear = false;

  if (clearKey || (pending && pending.kind === 'clear')) {
    label = '待保存：清除手动密钥';
    cls = 'pill warn';
    hintText = `保存后将删除手动密钥；${fallback}。${envBits}。`;
    placeholder = '待清除手动密钥，留空不更换';
  } else if (pending && pending.kind === 'set') {
    label = '待保存：新手动密钥';
    cls = 'pill';
    hintText = `新手动密钥尚未保存；保存成功后仅后端加密存储，不会回显。${envBits}。`;
    placeholder = '已填写新手动密钥（不回显）';
    canClear = true;
  } else if (meta) {
    const src = credentialSourceBadge(meta);
    label = src.label;
    cls = meta.available || !meta.requires_auth ? 'pill subtle' : 'pill warn';
    canClear = meta.manual_set === true;
    if (meta.source === 'manual') {
      hintText = `已保存手动密钥，留空不更换；填写新值将替换。${meta.manual_set ? '当前生效优先级最高。' : ''}${envBits}。`;
      placeholder = '已保存手动密钥，留空不更换';
      canClear = true;
    } else {
      hintText = `${meta.manual_set ? '存在手动密钥但当前源为 ' + src.label + '。' : ''}${envBits}；${authBits}。留空不设置手动密钥。`;
      placeholder = meta.env_available ? '留空使用环境变量' : '留空不设置手动密钥';
    }
  } else if (id) {
    label = '凭据状态未验证';
    hintText = '保存后由服务端验证凭据可用性；保存前不会尝试调用 Provider。';
  } else {
    label = '新 Provider';
    hintText = '可选手动密钥；保存后由服务端验证。留空则按环境变量或无认证回退。';
  }

  status.textContent = label;
  status.className = cls;
  hint.textContent = hintText;
  input.placeholder = placeholder;
  clearBtn.hidden = clearKey || (pending && pending.kind === 'clear') || !canClear;
  undoBtn.hidden = !(clearKey || pending);
  updateProviderProtocolHint();
}

function openProviderDialog(id = null) {
  if (!App.state) return;
  const existing = id ? providerById(id) : null;
  if (id && !existing) return;
  App.providerDialog = { mode: existing ? 'edit' : 'create', id: existing ? existing.id : null, clearKey: false };
  $('provider-dialog-title').textContent = existing ? '编辑 Provider' : '添加 Provider';
  $('provider-name').value = existing ? existing.name : '';
  $('provider-base').value = existing ? existing.base_url : '';
  $('provider-env').value = existing ? existing.api_key_env : '';
  $('provider-api-key').value = '';
  $('provider-error').textContent = '';
  $('provider-base').removeAttribute('aria-invalid');
  $('provider-env').removeAttribute('aria-invalid');
  $('provider-type').removeAttribute('aria-invalid');
  renderProviderProtocolOptions(existing ? existing.protocol : '');
  updateProviderCredentialUI();
  $('provider-dialog').showModal();
  window.setTimeout(() => $('provider-name').focus(), 0);
}

async function submitProviderDialog(event) {
  event.preventDefault();
  if (!App.state || App.saving || App.mutating) return;
  const name = $('provider-name').value.trim();
  const protocol = $('provider-type').value;
  const baseUrl = $('provider-base').value.trim();
  const env = $('provider-env').value.trim();
  const keyInput = $('provider-api-key');
  const errEl = $('provider-error');
  errEl.textContent = '';
  $('provider-base').removeAttribute('aria-invalid');
  $('provider-env').removeAttribute('aria-invalid');
  $('provider-type').removeAttribute('aria-invalid');
  if (!name) {
    errEl.textContent = '名称不能为空。';
    $('provider-name').focus();
    return;
  }
  if (!protocol) {
    errEl.textContent = '请选择服务端已实现的协议。';
    $('provider-type').setAttribute('aria-invalid', 'true');
    $('provider-type').focus();
    return;
  }
  if (!isKnownProtocol(protocol)) {
    errEl.textContent = `协议「${protocol}」未在服务端实现，不能保存或运行。`;
    $('provider-type').setAttribute('aria-invalid', 'true');
    $('provider-type').focus();
    return;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    errEl.textContent = 'Base URL 必须以 http:// 或 https:// 开头。';
    $('provider-base').setAttribute('aria-invalid', 'true');
    $('provider-base').focus();
    return;
  }
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch {
    errEl.textContent = 'Base URL 不是有效的 URL。';
    $('provider-base').setAttribute('aria-invalid', 'true');
    $('provider-base').focus();
    return;
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    errEl.textContent = 'Base URL 必须是 HTTP(S) 地址，且不能包含凭据、查询参数或 fragment。';
    $('provider-base').setAttribute('aria-invalid', 'true');
    $('provider-base').focus();
    return;
  }
  if (env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
    errEl.textContent = 'API Key 环境变量名只能包含字母、数字和下划线，且不能以数字开头。';
    $('provider-env').setAttribute('aria-invalid', 'true');
    $('provider-env').focus();
    return;
  }
  const trimmedKey = keyInput.value.trim();
  if (keyInput.value !== '' && !trimmedKey) {
    errEl.textContent = '手动密钥不能只包含空白；留空表示不更换。';
    keyInput.setAttribute('aria-invalid', 'true');
    keyInput.focus();
    return;
  }

  let target;
  if (App.providerDialog.mode === 'edit') {
    target = providerById(App.providerDialog.id);
    if (!target) {
      errEl.textContent = '要编辑的 Provider 已不存在。';
      return;
    }
    target.name = name;
    target.protocol = protocol;
    target.base_url = baseUrl;
    target.api_key_env = env;
  } else {
    target = { id: newProviderId(), name, protocol, base_url: baseUrl, api_key_env: env, credential_ref: '' };
    App.state.providers.push(target);
    App.providerDialog.mode = 'edit';
    App.providerDialog.id = target.id;
  }

  if (App.providerDialog.clearKey) {
    App.credentialMutations.set(target.id, { kind: 'clear' });
  } else if (keyInput.value !== '') {
    App.credentialMutations.set(target.id, { kind: 'set', value: keyInput.value });
  }
  updateDirtyUI();
  if (!await saveState({ silent: true })) {
    errEl.textContent = '保存失败，更改尚未提交。请检查页面错误提示后重试。';
    return;
  }
  keyInput.value = '';
  App.providerDialog.clearKey = false;
  $('provider-dialog').close();
  renderProviders();
  renderGroupCards();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('Provider 配置已修改');
  toast('Provider 已保存', 'ok');
}

function deleteProvider(id) {
  const p = providerById(id);
  if (!p) return;
  const refs = App.state.draft.groups.filter((g) => g.provider_id === id);
  const extra = refs.length ? `\n\n草稿中引用它的 ${refs.length} 个对照配置也会被移除。` : '';
  const meta = credentialMeta(id);
  const pending = pendingCredentialFor(id);
  const persisted = !!p.credential_ref;
  let credentialNote = '';
  if (persisted && pending && pending.kind === 'clear') {
    credentialNote = '\n\n待保存的“清除手动密钥”会随删除一起提交，改用环境变量回退。';
  } else if (persisted && meta && meta.manual_set) {
    credentialNote = '\n\n该 Provider 已保存手动密钥；删除后加密凭据引用仍保留供历史批次复跑。若要移除，请先编辑并清除手动密钥，再删除。';
  }
  if (!window.confirm(`删除 Provider「${p.name || p.id}」？${extra}${credentialNote}\n\n已保存的历史批次与冻结快照不受影响。`)) return;
  App.state.providers = App.state.providers.filter((x) => x.id !== id);
  if (refs.length) {
    App.state.draft.groups = App.state.draft.groups.filter((g) => g.provider_id !== id);
    if (!groupById(App.activeGroupId)) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  }
  if (!persisted) {
    App.credentialMutations.delete(id);
  } else if (pending && pending.kind === 'set') {
    App.credentialMutations.delete(id);
  }
  delete App.credentials[id];
  renderProviders();
  renderGroupCards();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('Provider 已删除');
  toast('已从草稿删除 Provider，保存后生效', 'ok');
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function renderSettings() {
  if (!App.state) return;
  const s = App.state.settings;
  $('setting-default-runs').value = s.default_runs;
  $('setting-concurrency').value = s.concurrency;
  $('setting-timeout').value = s.timeout_seconds;
  const runConcurrency = $('run-concurrency');
  const runDefaults = $('run-default-runs');
  if (runConcurrency) runConcurrency.value = s.concurrency;
  if (runDefaults) runDefaults.value = s.default_runs;
  const err = $('settings-error');
  if (err) err.textContent = '';
  App.settingsError = [];
}

function applySettingsChange() {
  if (!App.state) return;
  const defaults = Number($('setting-default-runs').value);
  const concurrency = Number($('setting-concurrency').value);
  const timeout = Number($('setting-timeout').value);
  const next = {
    default_runs: Number.isInteger(defaults) ? defaults : App.state.settings.default_runs,
    concurrency: Number.isInteger(concurrency) ? concurrency : App.state.settings.concurrency,
    timeout_seconds: Number.isInteger(timeout) ? timeout : App.state.settings.timeout_seconds
  };
  const errors = validateSettings(next);
  App.settingsError = errors;
  $('settings-error').textContent = errors.join(' ');
  $('setting-default-runs').setAttribute('aria-invalid', errors.some((e) => e.includes('默认')) ? 'true' : 'false');
  $('setting-concurrency').setAttribute('aria-invalid', errors.some((e) => e.includes('并发')) ? 'true' : 'false');
  $('setting-timeout').setAttribute('aria-invalid', errors.some((e) => e.includes('超时')) ? 'true' : 'false');
  if (!errors.length) {
    App.state.settings = next;
    renderSettings();
    updateDirtyUI();
    refreshRunPlan();
    markPreviewStale('设置已修改');
    if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview();
  }
}

function renderModelSuggestions() {
  const datalist = $('model-suggestions');
  if (!datalist || !App.state) return;
  const models = new Set();
  for (const g of App.state.draft.groups) if (g.model) models.add(g.model);
  datalist.innerHTML = [...models].sort().map((m) => `<option value="${esc(m)}"></option>`).join('');
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function setView(view, { force = false } = {}) {
  if (!['workbench', 'cases', 'case-editor', 'case-io', 'group-editor', 'history', 'providers', 'settings'].includes(view)) return;
  if (App.mutating && !force) return;
  if (view === App.activeView) return;
  if (!force && App.activeView === 'case-editor' && view !== 'case-editor' && typeof caseEditorDirty === 'function' && caseEditorDirty()) {
    if (!window.confirm('Case 编辑器中还有未保存的更改。放弃并离开？')) return;
    App.caseEditor = null;
  }
  if (!force && App.activeView === 'group-editor' && view !== 'group-editor' && typeof groupEditorDirty === 'function' && groupEditorDirty()) {
    if (!window.confirm('对照配置编辑器中还有未保存的更改。放弃并离开？')) return;
    App.groupEditor = null;
  }
  App.activeView = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${view}`;
  });
  const navView = view === 'case-editor' || view === 'case-io' ? 'cases' : (view === 'group-editor' ? 'workbench' : view);
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === navView;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  renderCollectionNav();
  renderShell();
  if (view === 'workbench') {
    renderTemplateOptions();
    renderTemplateEditor();
    renderGroupCards();
    renderWorkbenchCase();
    refreshRunPlan();
  } else if (view === 'cases') {
    renderLibrary();
  } else if (view === 'case-editor') {
    renderCaseEditor();
  } else if (view === 'case-io') {
    renderIO();
  } else if (view === 'group-editor') {
    renderGroupEditor();
  } else if (view === 'history') {
    renderHistoryList();
    if (!App.runsLoaded) refreshRuns();
  } else if (view === 'providers') {
    renderProviders();
  } else if (view === 'settings') {
    renderSettings();
  }
  if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  if (view === 'workbench' && App.rangeDraft && typeof scheduleStagedPreview === 'function') scheduleStagedPreview(0);
}

/* ------------------------------------------------------------------ */
/* Bootstrap and events                                                */
/* ------------------------------------------------------------------ */

async function loadProtocols() {
  try {
    const list = await apiGet('/api/protocols');
    App.providerProtocols = Array.isArray(list) ? list.filter((p) => p && p.id) : [];
    App.providerProtocolsLoaded = true;
    App.providerCatalogError = App.providerProtocols.length ? '' : '服务端未返回任何已实现协议。';
  } catch (err) {
    App.providerProtocols = [];
    App.providerProtocolsLoaded = false;
    App.providerCatalogError = err.message;
  }
  renderProviders();
  if (App.activeView === 'providers') updateProviderCatalogNote();
}

async function bootstrap() {
  App.loading = true;
  updateDirtyUI();
  try {
    await loadProtocols();
    await loadState();
    setConnection(true);
    renderAll();
    await refreshRuns({ quiet: true });
    await resumeActiveRun();
    refreshPreview({ silent: true });
    refreshSelectionPreview({ silent: true });
    hideBanner();
  } catch (err) {
    setConnection(false);
    showBanner(`初始化失败：${err.message}`, 'error', bootstrap, '重试连接');
    toast(`初始化失败：${err.message}`, 'error', 6000);
  } finally {
    App.loading = false;
    updateDirtyUI();
    refreshRunPlan();
  }
}

function bindStaticEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('save-btn').addEventListener('click', () => saveState());
  $('run-btn').addEventListener('click', startRun);
  $('draft-name').addEventListener('input', (e) => {
    App.state.draft.name = e.target.value;
    renderShell();
    updateDirtyUI();
    markPreviewStale('草稿名称已修改');
  });
  $('range-open-btn').addEventListener('click', () => {
    App.rangeOpen = true;
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  });
  $('range-close').addEventListener('click', () => {
    App.rangeOpen = false;
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  });
  $('range-reopen').addEventListener('click', () => {
    App.rangeOpen = true;
    if (typeof renderSelectionPanel === 'function') renderSelectionPanel();
  });

  ['run-concurrency', 'run-default-runs'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const concurrency = Number($('run-concurrency').value);
      const defaults = Number($('run-default-runs').value);
      const next = {
        ...App.state.settings,
        concurrency: Number.isInteger(concurrency) ? concurrency : App.state.settings.concurrency,
        default_runs: Number.isInteger(defaults) ? defaults : App.state.settings.default_runs
      };
      const errors = validateSettings(next);
      if (errors.length) {
        toast(errors[0], 'error');
        renderSettings();
        return;
      }
      App.state.settings = next;
      renderSettings();
      updateDirtyUI();
      refreshRunPlan();
      markPreviewStale('运行设置已修改');
      if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview();
    });
  });

  $('template-select').addEventListener('change', (e) => {
    App.activeTemplateId = e.target.value || null;
    App.activeMessageIndex = 0;
    renderTemplateEditor();
    renderTemplateMismatch();
    renderShell();
  });
  $('template-name').addEventListener('input', (e) => {
    const tpl = activeTemplate();
    if (!tpl) return;
    tpl.name = e.target.value;
    renderTemplateOptions();
    renderTemplateMismatch();
    renderGroupCards();
    updateDirtyUI();
    refreshRunPlan();
    markPreviewStale('模板名称已修改');
  });
  $('new-template-btn').addEventListener('click', openTemplateDialog);
  $('dup-template-btn').addEventListener('click', duplicateTemplate);
  $('del-template-btn').addEventListener('click', deleteTemplate);

  $('message-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-message-index]');
    if (!tab) return;
    App.activeMessageIndex = Number(tab.dataset.messageIndex);
    renderTemplateEditor();
  });
  $('message-content').addEventListener('input', handleMessageInput);
  ['input', 'click', 'keyup', 'select'].forEach((evt) => {
    $('message-content').addEventListener(evt, () => updateLineInfo($('message-content'), $('message-lineinfo')));
  });
  $('message-content').addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = `${ta.value.slice(0, start)}  ${ta.value.slice(end)}`;
      ta.setSelectionRange(start + 2, start + 2);
      handleMessageInput();
    }
  });
  $('message-role').addEventListener('change', (e) => {
    const msg = activeMessage();
    if (!msg) return;
    msg.role = e.target.value;
    renderTemplateEditor();
    updateDirtyUI();
    markPreviewStale('消息角色已修改');
  });
  $('add-message-btn').addEventListener('click', addMessage);
  $('del-message-btn').addEventListener('click', deleteMessage);

  $('insert-var-menu').addEventListener('toggle', () => {
    if ($('insert-var-menu').open) renderInsertVarList();
  });
  $('insert-var-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-var-insert]');
    if (!btn) return;
    insertVariableToken(btn.dataset.varInsert);
    $('insert-var-menu').open = false;
  });

  $('add-group-btn').addEventListener('click', () => {
    if (typeof openGroupEditor === 'function') openGroupEditor(null);
  });
  $('group-cards').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-group-enabled]');
    if (!cb) return;
    const g = groupById(cb.dataset.groupEnabled);
    if (!g) return;
    g.enabled = cb.checked;
    renderGroupCards();
    renderWorkbenchCase();
    updateDirtyUI();
    refreshRunPlan();
    markPreviewStale('配置启用状态已修改');
    if (typeof scheduleSelectionPreview === 'function') scheduleSelectionPreview();
  });
  $('group-cards').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-group-edit]');
    if (edit) { setActiveGroup(edit.dataset.groupEdit); if (typeof openGroupEditor === 'function') openGroupEditor(edit.dataset.groupEdit); return; }
    const select = e.target.closest('[data-group-select]');
    if (select) setActiveGroup(select.dataset.groupSelect);
  });

  $('refresh-preview-btn').addEventListener('click', () => refreshPreview());
  $('copy-preview-btn').addEventListener('click', copyPreview);
  $('template-mismatch').addEventListener('click', focusBoundTemplate);

  $('filter-group').addEventListener('change', (e) => {
    App.outputFilter.group = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  $('filter-case').addEventListener('change', (e) => {
    App.outputFilter.case = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  $('filter-status').addEventListener('change', (e) => {
    App.outputFilter.status = e.target.value;
    App.outputScrollTop = 0;
    renderOutput();
  });
  $('reload-run-btn').addEventListener('click', () => {
    if (App.currentRunId) loadRunIntoOutput(App.currentRunId);
  });
  $('stop-btn').addEventListener('click', stopRun);

  document.querySelectorAll('[data-output-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setOutputTab(btn.dataset.outputTab));
  });

  $('history-refresh-btn').addEventListener('click', async () => {
    await refreshRuns();
    if (App.historySelectedId) loadHistoryDetail(App.historySelectedId);
    toast('历史已刷新', 'ok', 1600);
  });
  $('history-run-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-history-open]');
    if (open) loadHistoryDetail(open.dataset.historyOpen);
  });
  $('history-run-list').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-compare-id]');
    if (!cb) return;
    const id = cb.dataset.compareId;
    if (cb.checked) {
      if (App.compareIds.size >= 6) {
        cb.checked = false;
        toast('最多同时对比 6 个批次', 'info');
        return;
      }
      App.compareIds.add(id);
    } else {
      App.compareIds.delete(id);
    }
    updateCompareButton();
  });
  $('compare-btn').addEventListener('click', showCompare);
  $('compare-back-btn').addEventListener('click', () => {
    $('compare-view').hidden = true;
    $('history-list-view').hidden = false;
    renderHistoryList();
  });
  $('history-detail').addEventListener('click', (e) => {
    const exportBtn = e.target.closest('[data-run-export]');
    if (exportBtn) { exportRun(exportBtn.dataset.runExport); return; }
    const replayBtn = e.target.closest('[data-run-replay]');
    if (replayBtn) { replayRun(replayBtn.dataset.runReplay); return; }
    const outputBtn = e.target.closest('[data-run-output]');
    if (outputBtn) { openRunInOutput(outputBtn.dataset.runOutput); return; }
    const refreshBtn = e.target.closest('[data-run-refresh]');
    if (refreshBtn) { loadHistoryDetail(refreshBtn.dataset.runRefresh); }
  });

  $('add-provider-btn').addEventListener('click', () => openProviderDialog());
  $('providers-body').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-provider-edit]');
    if (edit) { openProviderDialog(edit.dataset.providerEdit); return; }
    const del = e.target.closest('[data-provider-delete]');
    if (del) deleteProvider(del.dataset.providerDelete);
  });

  $('settings-save-btn').addEventListener('click', () => {
    const errors = validateSettings(App.state.settings);
    if (errors.length) {
      $('settings-error').textContent = errors.join(' ');
      toast('设置存在错误，未保存', 'error');
      return;
    }
    saveState();
  });
  ['setting-default-runs', 'setting-concurrency', 'setting-timeout'].forEach((id) => {
    $(id).addEventListener('change', applySettingsChange);
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dlg = $(btn.dataset.closeDialog);
      if (dlg) dlg.close();
    });
  });
  document.querySelectorAll('dialog.modal').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  });

  $('provider-form').addEventListener('submit', submitProviderDialog);
  $('provider-type').addEventListener('change', () => {
    updateProviderProtocolHint();
    updateProviderCredentialUI();
  });
  $('provider-env').addEventListener('input', () => updateProviderCredentialUI());
  $('provider-api-key').addEventListener('input', () => {
    markEdit();
    if (App.providerDialog.clearKey && $('provider-api-key').value !== '') {
      App.providerDialog.clearKey = false;
      updateProviderCredentialUI();
    }
  });
  $('provider-clear-key').addEventListener('click', () => {
    markEdit();
    App.providerDialog.clearKey = true;
    const key = $('provider-api-key');
    if (key) key.value = '';
    updateProviderCredentialUI();
  });
  $('provider-undo-credential').addEventListener('click', () => {
    markEdit();
    if (App.providerDialog.clearKey) {
      App.providerDialog.clearKey = false;
    } else if (App.providerDialog.id) {
      discardCredentialMutation(App.providerDialog.id);
    }
    updateProviderCredentialUI();
    refreshRunPlan();
  });
  $('provider-dialog').addEventListener('close', () => {
    const key = $('provider-api-key');
    if (key) key.value = '';
    App.providerDialog.clearKey = false;
  });
  $('template-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('template-new-name').value.trim();
    if (!name) {
      $('template-error').textContent = '模板名称不能为空。';
      $('template-new-name').focus();
      return;
    }
    createTemplate(name);
    $('template-dialog').close();
    toast('已新建模板到草稿，保存后生效', 'ok');
  });

  $('banner-close-btn').addEventListener('click', hideBanner);
  $('banner-reload-btn').addEventListener('click', () => {
    if (typeof App.bannerAction === 'function') App.bannerAction();
  });

  document.addEventListener('click', (e) => {
    const details = $('insert-var-menu');
    if (details && details.open && !details.contains(e.target)) details.open = false;
  });

  document.addEventListener('input', () => markEdit(), true);
  document.addEventListener('change', () => markEdit(), true);

  window.addEventListener('beforeunload', (e) => {
    const editorDirty = (typeof caseEditorDirty === 'function' && caseEditorDirty())
      || (typeof groupEditorDirty === 'function' && groupEditorDirty());
    if (hasUnsavedWork() || editorDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const menu = $('insert-var-menu');
      if (menu && menu.open) menu.open = false;
    }
  });

  if (typeof bindCaseEvents === 'function') bindCaseEvents();
}

async function init() {
  bindStaticEvents();
  setView('workbench', { force: true });
  await bootstrap();
}

if (document.readyState === 'complete') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
