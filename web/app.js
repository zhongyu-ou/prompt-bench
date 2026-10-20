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

const VAR_HELPERS = [
  { key: 'PriorText', hint: '前文 / 上下文文本', value: '' },
  { key: 'CurrentText', hint: '当前待处理文本', value: '' },
  { key: 'SourceLanguage', hint: '源语言标识', value: '' },
  { key: 'TargetLanguageNameMap', hint: '目标语言 → 名称映射', value: {} },
  { key: 'ReplacementMap', hint: '替换映射', value: {} }
];

const ICON_EDIT = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.8-3.4 8.9-8.9a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1l-8.9 8.9L4 16z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l.7 10h6.6l.7-10M8.4 8v5M11.6 8v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

const App = {
  state: null,
  version: 0,
  savedJson: '',
  savedAt: null,
  saving: false,
  loading: false,
  activeView: 'workbench',
  activeCaseId: null,
  activeTemplateId: null,
  activeMessageIndex: 0,
  activeGroupId: null,
  editorTab: 'template',
  varTexts: new Map(),
  varErrors: new Map(),
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
  caseDialog: { mode: 'create', id: null },
  groupDialog: { mode: 'create', id: null, params: {} },
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
  lastFilterSignature: ''
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

function selectedCaseIds() {
  if (!App.state) return [];
  const seen = new Set();
  return App.state.draft.case_ids.filter((id) => {
    if (seen.has(id) || !caseById(id)) return false;
    seen.add(id);
    return true;
  });
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
  return isDirty() || hasVarErrors() || hasPendingCredentials();
}

function discardCredentialMutation(id) {
  App.credentialMutations.delete(id);
  updateDirtyUI();
  renderProviders();
}

function hasVarErrors() {
  return App.varErrors.size > 0;
}

function isBusyVisual() {
  return App.saving || App.loading;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
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
  return payload;
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
  s.templates = Array.isArray(s.templates) ? s.templates : [];
  s.providers = Array.isArray(s.providers) ? s.providers : [];
  s.settings = s.settings && typeof s.settings === 'object' ? s.settings : {};
  s.settings.default_runs = clampInt(s.settings.default_runs, 1, 1000, 20);
  s.settings.concurrency = clampInt(s.settings.concurrency, 1, 20, 20);
  s.settings.timeout_seconds = clampInt(s.settings.timeout_seconds, 1, 3600, 120);
  s.draft = s.draft && typeof s.draft === 'object' ? s.draft : {};
  s.draft.name = typeof s.draft.name === 'string' ? s.draft.name : '';
  s.draft.case_ids = Array.isArray(s.draft.case_ids) ? s.draft.case_ids : [];
  s.draft.groups = Array.isArray(s.draft.groups) ? s.draft.groups : [];
  for (const c of s.cases) {
    if (!c.id) c.id = `case_${Math.random().toString(36).slice(2, 8)}`;
    if (!c.name) c.name = c.id;
    c.variables = c.variables && typeof c.variables === 'object' && !Array.isArray(c.variables) ? c.variables : {};
    if (typeof c.description !== 'string') c.description = '';
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
  }
  return s;
}

async function loadState() {
  App.loading = true;
  updateDirtyUI();
  try {
    const payload = await apiGet('/api/state');
    const credentials = payload && typeof payload === 'object' ? payload.credentials : null;
    App.credentials = normalizeCredentials(credentials);
    if (payload && typeof payload === 'object') delete payload.credentials;
    App.state = normalizeState(payload);
    App.version = App.state.version;
    App.savedJson = stableStringify(App.state);
    App.savedAt = new Date();
    App.varTexts.clear();
    App.varErrors.clear();
    for (const c of App.state.cases) App.varTexts.set(c.id, pretty(c.variables));
    App.preview = null;
    App.previewStale = true;
    ensureSelections();
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

function renderShell() {
  if (!App.state) return;
  const draft = App.state.draft;
  const c = activeCase();
  $('crumb').textContent = `${draft.name || '未命名草稿'} / ${c ? c.id : '无 case'}`;
  $('state-version').textContent = `v${App.version}`;
  $('state-version').title = `服务端状态版本 ${App.version}`;
  const nameInput = $('draft-name');
  if (document.activeElement !== nameInput && nameInput.value !== draft.name) nameInput.value = draft.name;
  const meta = $('draft-meta');
  if (meta) meta.textContent = `${App.state.cases.length} 个 case · ${draft.groups.length} 个对照配置`;
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
  } else if (dirty) {
    el.textContent = '有未保存更改';
    el.classList.add('dirty');
  } else {
    el.textContent = App.savedAt ? `已保存 ${fmtClock(App.savedAt)}` : '已保存';
  }
  const saveBtn = $('save-btn');
  if (saveBtn) saveBtn.disabled = App.saving;
  const globalSave = $('global-save-btn');
  if (globalSave) {
    globalSave.disabled = App.saving;
    globalSave.textContent = dirty ? '保存草稿 ●' : '保存草稿';
    globalSave.title = dirty ? '有未保存更改' : '草稿已保存';
  }
  if (App.state) {
    document.title = `${dirty ? '● ' : ''}Promptbench · ${App.state.draft.name || 'Prompt 调试'}`;
  }
}

function renderAll() {
  ensureSelections();
  renderShell();
  renderCaseList();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroups();
  renderRightConfig();
  renderModelSuggestions();
  renderProviders();
  renderSettings();
  renderRecentRuns();
  renderHistoryList();
  renderOutput();
  renderPreviewState();
  updateDirtyUI();
  refreshRunPlan();
}

/* ------------------------------------------------------------------ */
/* Sidebar: cases and recent runs                                      */
/* ------------------------------------------------------------------ */

function renderCaseList() {
  const list = $('case-list');
  if (!list || !App.state) return;
  const selected = new Set(App.state.draft.case_ids);
  const cases = App.state.cases;
  $('case-count').textContent = `${selectedCaseIds().length} / ${cases.length}`;
  if (!cases.length) {
    list.innerHTML = '<div class="side-empty">尚无 case。点击“新建 case”开始。</div>';
    return;
  }
  list.innerHTML = cases.map((c) => {
    const isActive = c.id === App.activeCaseId;
    const isSelected = selected.has(c.id);
    const subtitle = c.description || c.name || '未命名';
    return `
      <div class="case-item ${isActive ? 'active' : ''}" data-case-id="${esc(c.id)}">
        <label class="case-check" title="加入本次运行选择">
          <input type="checkbox" data-case-select="${esc(c.id)}" ${isSelected ? 'checked' : ''} aria-label="${esc(`选择 ${c.name || c.id} 参与本次运行`)}">
        </label>
        <button type="button" class="case-main" data-case-activate="${esc(c.id)}" aria-pressed="${isActive ? 'true' : 'false'}">
          <span class="case-id">${esc(c.id)}</span>
          <span class="case-name">${esc(subtitle)}</span>
        </button>
        <button type="button" class="case-menu" data-case-menu="${esc(c.id)}" title="编辑 / 复制 / 删除" aria-label="${esc(`编辑或删除 case ${c.id}`)}">···</button>
      </div>`;
  }).join('');
}

function renderRecentRuns() {
  const el = $('recent-runs');
  if (!el) return;
  if (!App.runs.length) {
    el.innerHTML = App.runsLoaded
      ? '<div class="side-empty">尚无运行记录。</div>'
      : '<div class="side-empty">载入中…</div>';
    return;
  }
  el.innerHTML = App.runs.slice(0, 6).map((b) => `
    <button type="button" class="recent-item ${b.id === App.currentRunId ? 'active' : ''}" data-run-open="${esc(b.id)}">
      <span class="recent-name">${esc(b.name || b.id)}</span>
      <span class="recent-meta">#${esc(b.id)} · ${esc(String(b.total ?? 0))} calls · ${esc(statusLabel(b.status))}</span>
    </button>
  `).join('');
}

/* ------------------------------------------------------------------ */
/* Editor: templates / messages / variables                            */
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
  App.editorTab = 'template';
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

  $('tab-template').textContent = tpl ? `${tabTitle} · 消息` : '模板消息';
  $('tab-variables').textContent = 'case.variables.json';

  if (!tpl) {
    tabs.innerHTML = '<span class="message-tabs-empty">尚无模板。点击“新建模板”开始。</span>';
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = '请先新建模板。';
    role.disabled = true;
    $('add-message-btn').disabled = true;
    $('del-message-btn').disabled = true;
    $('insert-var-menu').hidden = true;
    setEditorTabUI();
    updateLineInfo(ta, $('message-lineinfo'));
    syncVariablesEditor();
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
  setEditorTabUI();
  updateLineInfo(ta, $('message-lineinfo'));
  syncVariablesEditor();
  updateEditorContextLabel();
  renderTemplateMismatch();
}

function setEditorTabUI() {
  const isTemplate = App.editorTab === 'template';
  const tabTemplate = $('tab-template');
  const tabVariables = $('tab-variables');
  if (!tabTemplate || !tabVariables) return;
  tabTemplate.setAttribute('aria-selected', isTemplate ? 'true' : 'false');
  tabVariables.setAttribute('aria-selected', isTemplate ? 'false' : 'true');
  $('editor-template-panel').hidden = !isTemplate;
  $('editor-variables-panel').hidden = isTemplate;
  const menu = $('insert-var-menu');
  if (menu) menu.hidden = !isTemplate || !activeTemplate();
  updateEditorContextLabel();
}

function updateEditorContextLabel() {
  const el = $('editor-context-label');
  if (!el) return;
  if (App.editorTab === 'variables') {
    const c = activeCase();
    el.textContent = c ? `变量 · ${c.id}` : '尚未选择案例';
  } else {
    const tpl = activeTemplate();
    el.textContent = tpl ? `${tpl.messages.length} 条消息 · 原始内容原样发送给后端渲染` : '';
  }
}

function setActiveCase(id) {
  if (!caseById(id)) return;
  App.activeCaseId = id;
  if (App.editorTab === 'variables') syncVariablesEditor();
  else syncVariablesEditor();
  renderCaseList();
  renderTemplateEditor();
  renderInsertVarList();
  renderShell();
  markPreviewStale('已切换案例');
}

function toggleCaseSelection(id, checked) {
  if (!App.state || !caseById(id)) return;
  const ids = App.state.draft.case_ids;
  if (checked) {
    if (!ids.includes(id)) ids.push(id);
  } else {
    App.state.draft.case_ids = ids.filter((x) => x !== id);
  }
  renderCaseList();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('运行选择已变更');
}

function syncVariablesEditor() {
  const ta = $('variables-json');
  if (!ta) return;
  const c = activeCase();
  if (!c) {
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = '请先选择或新建 case。';
    showVariablesError('');
    updateLineInfo(ta, $('var-lineinfo'));
    return;
  }
  ta.disabled = false;
  ta.placeholder = '{\n  "CurrentText": "…"\n}';
  const text = App.varTexts.has(c.id) ? App.varTexts.get(c.id) : pretty(c.variables);
  if (ta.value !== text && document.activeElement !== ta) ta.value = text;
  else if (ta.value !== text && document.activeElement === ta) {
    // Keep focus; the input handler is the source of truth while typing.
  }
  showVariablesError(App.varErrors.get(c.id) || '');
  updateLineInfo(ta, $('var-lineinfo'));
}

function showVariablesError(message) {
  const err = $('variables-error');
  const ta = $('variables-json');
  if (err) err.textContent = message || '';
  if (ta) {
    if (message) ta.setAttribute('aria-invalid', 'true');
    else ta.removeAttribute('aria-invalid');
  }
}

function handleVariablesInput() {
  const c = activeCase();
  const ta = $('variables-json');
  if (!c || !ta) return;
  const text = ta.value;
  App.varTexts.set(c.id, text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    App.varErrors.set(c.id, `JSON 解析失败：${err.message}`);
    showVariablesError(App.varErrors.get(c.id));
    updateDirtyUI();
    updateLineInfo(ta, $('var-lineinfo'));
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    App.varErrors.set(c.id, '变量必须是 JSON 对象（{ ... }），不能是数组或基本类型。');
    showVariablesError(App.varErrors.get(c.id));
    updateDirtyUI();
    updateLineInfo(ta, $('var-lineinfo'));
    return;
  }
  App.varErrors.delete(c.id);
  c.variables = parsed;
  showVariablesError('');
  updateDirtyUI();
  updateLineInfo(ta, $('var-lineinfo'));
  renderInsertVarList();
  markPreviewStale('变量已修改');
  refreshRunPlan();
}

function formatVariables() {
  const c = activeCase();
  const ta = $('variables-json');
  if (!c || !ta) return;
  try {
    const parsed = JSON.parse(ta.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    const text = pretty(parsed);
    ta.value = text;
    App.varTexts.set(c.id, text);
    App.varErrors.delete(c.id);
    c.variables = parsed;
    showVariablesError('');
    updateLineInfo(ta, $('var-lineinfo'));
    updateDirtyUI();
    toast('变量 JSON 已格式化', 'ok', 1800);
  } catch (err) {
    App.varErrors.set(c.id, `JSON 解析失败：${err.message}`);
    showVariablesError(App.varErrors.get(c.id));
    updateDirtyUI();
    toast(`无法格式化：${err.message}`, 'error');
  }
}

function renderVariableChips() {
  const host = $('variable-chips');
  if (!host) return;
  host.innerHTML = VAR_HELPERS.map((h) => `
    <button type="button" class="chip" data-var-add="${esc(h.key)}" title="${esc(`添加 ${h.key}：${h.hint}`)}">${esc(h.key)}</button>
  `).join('');
}

function addVariableHelper(key) {
  const c = activeCase();
  const ta = $('variables-json');
  if (!c || !ta) {
    toast('请先选择 case', 'error');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (err) {
    showVariablesError(`JSON 解析失败：${err.message}`);
    toast('请先修正变量 JSON 再添加字段', 'error');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    showVariablesError('变量必须是 JSON 对象。');
    return;
  }
  if (hasOwn(parsed, key)) {
    toast(`字段 ${key} 已存在`, 'info', 2000);
    return;
  }
  const helper = VAR_HELPERS.find((h) => h.key === key);
  parsed[key] = helper ? clone(helper.value) : '';
  const text = pretty(parsed);
  ta.value = text;
  App.varTexts.set(c.id, text);
  App.varErrors.delete(c.id);
  c.variables = parsed;
  showVariablesError('');
  updateLineInfo(ta, $('var-lineinfo'));
  updateDirtyUI();
  renderInsertVarList();
  markPreviewStale('变量已修改');
  refreshRunPlan();
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
    list.innerHTML = '<div class="menu-empty">当前 case 没有可用变量，请在变量 JSON 中添加。</div>';
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
  App.editorTab = 'template';
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroups();
  renderRightConfig();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
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
  renderGroups();
  renderRightConfig();
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
  renderGroups();
  renderRightConfig();
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
/* Case CRUD                                                           */
/* ------------------------------------------------------------------ */

function openCaseDialog(mode, id = null) {
  if (!App.state) return;
  const source = id ? caseById(id) : null;
  if (mode !== 'create' && !source) return;
  App.caseDialog = { mode, id };
  const title = $('case-dialog-title');
  const idInput = $('case-id');
  const nameInput = $('case-name');
  const descInput = $('case-desc');
  const varsInput = $('case-variables');
  const selectRow = $('case-select-row');
  const addSelection = $('case-add-selection');
  const dupBtn = $('case-duplicate-btn');
  const delBtn = $('case-delete-btn');
  const submit = $('case-submit');

  $('case-error').textContent = '';
  idInput.removeAttribute('aria-invalid');
  nameInput.removeAttribute('aria-invalid');
  varsInput.removeAttribute('aria-invalid');

  if (mode === 'create') {
    const existing = new Set(App.state.cases.map((c) => c.id));
    let n = App.state.cases.length + 1;
    while (existing.has(`case_${n}`)) n += 1;
    idInput.value = `case_${n}`;
    idInput.disabled = false;
    nameInput.value = '';
    descInput.value = '';
    varsInput.value = '{\n  "CurrentText": ""\n}';
    addSelection.checked = true;
    selectRow.hidden = false;
    dupBtn.hidden = true;
    delBtn.hidden = true;
    title.textContent = '新建 case';
    submit.textContent = '创建 case';
  } else {
    const isDuplicate = mode === 'duplicate';
    let nextId = source.id;
    if (isDuplicate) {
      const existing = new Set(App.state.cases.map((c) => c.id));
      nextId = `${source.id}_copy`;
      let n = 2;
      while (existing.has(nextId)) {
        nextId = `${source.id}_copy${n}`;
        n += 1;
      }
    }
    idInput.value = nextId;
    idInput.disabled = !isDuplicate;
    nameInput.value = isDuplicate ? `${source.name || source.id} 副本` : (source.name || '');
    descInput.value = source.description || '';
    varsInput.value = App.varTexts.has(source.id)
      ? App.varTexts.get(source.id)
      : pretty(source.variables);
    addSelection.checked = isDuplicate ? true : App.state.draft.case_ids.includes(source.id);
    selectRow.hidden = false;
    dupBtn.hidden = true;
    delBtn.hidden = true;
    title.textContent = isDuplicate ? '复制 case' : '编辑 case';
    submit.textContent = isDuplicate ? '复制 case' : '保存 case';
  }
  $('case-dialog').showModal();
  window.setTimeout(() => {
    if (mode === 'create') { nameInput.focus(); } else { nameInput.focus(); nameInput.select(); }
  }, 0);
}

function submitCaseDialog(event) {
  event.preventDefault();
  if (!App.state) return;
  const mode = App.caseDialog.mode;
  const sourceId = App.caseDialog.id;
  const id = $('case-id').value.trim();
  const name = $('case-name').value.trim();
  const desc = $('case-desc').value.trim();
  const varsText = $('case-variables').value;
  const errEl = $('case-error');
  const idInput = $('case-id');
  const nameInput = $('case-name');
  const varsInput = $('case-variables');
  errEl.textContent = '';
  idInput.removeAttribute('aria-invalid');
  nameInput.removeAttribute('aria-invalid');
  varsInput.removeAttribute('aria-invalid');

  if (!id) {
    errEl.textContent = 'Case ID 不能为空。';
    idInput.setAttribute('aria-invalid', 'true');
    idInput.focus();
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    errEl.textContent = 'Case ID 只能包含字母、数字、点、下划线和短横线，且不能以符号开头。';
    idInput.setAttribute('aria-invalid', 'true');
    idInput.focus();
    return;
  }
  if (!name) {
    errEl.textContent = '名称不能为空。';
    nameInput.setAttribute('aria-invalid', 'true');
    nameInput.focus();
    return;
  }
  let variables;
  try {
    variables = JSON.parse(varsText);
  } catch (err) {
    errEl.textContent = `变量 JSON 解析失败：${err.message}`;
    varsInput.setAttribute('aria-invalid', 'true');
    varsInput.focus();
    return;
  }
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    errEl.textContent = '变量必须是 JSON 对象。';
    varsInput.setAttribute('aria-invalid', 'true');
    varsInput.focus();
    return;
  }
  if (mode !== 'edit' && caseById(id)) {
    errEl.textContent = `Case ID「${id}」已存在。`;
    idInput.setAttribute('aria-invalid', 'true');
    idInput.focus();
    return;
  }

  if (mode === 'edit') {
    const target = caseById(sourceId);
    if (!target) {
      errEl.textContent = '要编辑的 case 已不存在。';
      return;
    }
    target.name = name;
    target.description = desc;
    target.variables = variables;
    App.varTexts.set(target.id, pretty(variables));
    App.varErrors.delete(target.id);
    App.activeCaseId = target.id;
  } else {
    App.state.cases.push({ id, name, description: desc, variables });
    App.varTexts.set(id, pretty(variables));
    App.varErrors.delete(id);
    App.activeCaseId = id;
    if ($('case-add-selection').checked && !App.state.draft.case_ids.includes(id)) {
      App.state.draft.case_ids.push(id);
    }
  }
  $('case-dialog').close();
  renderCaseList();
  renderTemplateEditor();
  renderInsertVarList();
  syncVariablesEditor();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('case 已修改');
}

function deleteCaseFromDialog() {
  const c = caseById(App.caseDialog.id);
  if (!c) return;
  if (!window.confirm(`删除 case「${c.name || c.id}」？\n\n会同时从本次运行选择中移除；历史批次不受影响。`)) return;
  App.state.cases = App.state.cases.filter((x) => x.id !== c.id);
  App.state.draft.case_ids = App.state.draft.case_ids.filter((id) => id !== c.id);
  App.varTexts.delete(c.id);
  App.varErrors.delete(c.id);
  if (App.activeCaseId === c.id) App.activeCaseId = App.state.cases[0]?.id || null;
  $('case-dialog').close();
  renderCaseList();
  renderTemplateEditor();
  syncVariablesEditor();
  renderInsertVarList();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('case 已删除');
}

/* ------------------------------------------------------------------ */
/* Groups table                                                        */
/* ------------------------------------------------------------------ */

function paramCell(params, key) {
  if (!hasOwn(params, key)) return '<span class="param-omit">未发送</span>';
  const value = params[key];
  if (value === null) return '<span class="param-null">null</span>';
  if (typeof value === 'string') return esc(value);
  return esc(JSON.stringify(value));
}

function templateName(id) {
  return templateById(id)?.name || (id ? `缺失:${id}` : '未选择');
}

function providerName(id) {
  return providerById(id)?.name || (id ? `缺失:${id}` : '未选择');
}

function renderGroups() {
  const body = $('groups-body');
  if (!body || !App.state) return;
  const groups = App.state.draft.groups;
  const enabled = groups.filter((g) => g.enabled).length;
  $('group-enabled-count').textContent = `${enabled} 个已启用`;
  if (!groups.length) {
    body.innerHTML = '<tr><td colspan="9"><div class="empty-state">尚无对照组配置。点击“＋ 添加配置”显式添加模板 / Provider / 模型组合。</div></td></tr>';
    return;
  }
  body.innerHTML = groups.map((g) => {
    const tpl = templateById(g.template_id);
    const prov = providerById(g.provider_id);
    const missing = !tpl || !prov || !String(g.model || '').trim() || !isKnownProtocol(prov.protocol);
    return `
      <tr data-group-id="${esc(g.id)}" class="${g.id === App.activeGroupId ? 'active-row' : ''}">
        <td><input type="checkbox" data-group-enabled="${esc(g.id)}" ${g.enabled ? 'checked' : ''} aria-label="${esc(`启用对照配置 ${g.name || g.id}`)}"></td>
        <td><span class="row-name" title="${esc(g.name)}">${esc(g.name || g.id)}</span>${missing ? ' <span class="pill warn">待补全</span>' : ''}</td>
        <td>${tpl ? esc(tpl.name || tpl.id) : '<span class="status-tag failed">模板缺失</span>'}</td>
        <td class="cell-mono" title="${esc(g.model)}">${g.model ? esc(g.model) : '<span class="param-omit">未填写</span>'}</td>
        <td>${prov ? `<div>${esc(prov.name || prov.id)}</div><div class="cred-meta">${providerProtocolTag(prov)}</div>` : '<span class="status-tag failed">Provider 缺失</span>'}</td>
        <td class="param-cell">${paramCell(g.parameters, 'temperature')}</td>
        <td class="param-cell">${paramCell(g.parameters, 'reasoning_effort')}</td>
        <td class="num">${esc(String(g.runs))}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="mini-btn" data-group-edit="${esc(g.id)}" title="编辑配置" aria-label="${esc(`编辑 ${g.name || g.id}`)}">${ICON_EDIT}</button>
            <button type="button" class="mini-btn danger" data-group-delete="${esc(g.id)}" title="删除配置" aria-label="${esc(`删除 ${g.name || g.id}`)}">${ICON_TRASH}</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function setActiveGroup(id, { renderRight = true } = {}) {
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
  renderGroups();
  if (renderRight) renderRightConfig();
  if (!bound) renderTemplateMismatch();
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
    runs: App.state.settings.default_runs || 20
  };
}

function deleteGroup(id) {
  const g = groupById(id);
  if (!g) return;
  if (!window.confirm(`删除对照配置「${g.name || g.id}」？历史批次不受影响。`)) return;
  App.state.draft.groups = App.state.draft.groups.filter((x) => x.id !== id);
  if (App.activeGroupId === id) App.activeGroupId = App.state.draft.groups[0]?.id || null;
  renderGroups();
  renderRightConfig();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('对照配置已删除');
}

/* ------------------------------------------------------------------ */
/* Right run configuration                                             */
/* ------------------------------------------------------------------ */

function paramTempState(params) {
  if (!hasOwn(params, 'temperature')) return { mode: 'omit', value: '' };
  if (params.temperature === null) return { mode: 'null', value: '' };
  return { mode: 'value', value: String(params.temperature) };
}

function paramReasoningState(params) {
  if (!hasOwn(params, 'reasoning_effort')) return { mode: 'omit', value: '' };
  const value = params.reasoning_effort;
  if (value === null) return { mode: 'null', value: '' };
  if (['none', 'low', 'medium', 'high'].includes(value)) return { mode: value, value: '' };
  return { mode: 'custom', value: typeof value === 'string' ? value : JSON.stringify(value) };
}

function applyParamControls(prefix, params) {
  const temp = paramTempState(params);
  const tempMode = $(`${prefix}-temp-mode`);
  const tempValue = $(`${prefix}-temp-value`);
  if (tempMode) tempMode.value = temp.mode;
  if (tempValue) {
    tempValue.value = temp.value;
    tempValue.hidden = temp.mode !== 'value';
    tempValue.disabled = temp.mode !== 'value';
  }
  const reasoning = paramReasoningState(params);
  const rMode = $(`${prefix}-reasoning-mode`);
  if (rMode) rMode.value = reasoning.mode;
}

function renderRightConfig() {
  if (!App.state) return;
  const groups = App.state.draft.groups;
  const groupSelect = $('cfg-group-select');
  groupSelect.innerHTML = groups.length
    ? groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name || g.id)}${g.enabled ? '' : '（已禁用）'}</option>`).join('')
    : '<option value="">（无配置）</option>';
  if (App.activeGroupId && !groupById(App.activeGroupId)) App.activeGroupId = groups[0]?.id || null;
  groupSelect.value = App.activeGroupId || '';
  const g = activeGroup();
  const controls = ['cfg-provider', 'cfg-model', 'cfg-temp-mode', 'cfg-temp-value', 'cfg-reasoning-mode'];
  for (const id of controls) $(id).disabled = !g;
  $('edit-group-btn').disabled = !g;

  const providerSelect = $('cfg-provider');
  providerSelect.innerHTML = App.state.providers.length
    ? App.state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} · ${esc(protocolLabel(p.protocol || '未设置协议'))}</option>`).join('')
    : '<option value="">（无 Provider）</option>';
  if (!g) {
    providerSelect.value = '';
    $('cfg-model').value = '';
    $('cfg-provider-hint').textContent = '尚无对照配置。请在下方表格添加配置。';
    $('cfg-provider-hint').className = 'provider-hint warn';
    applyParamControls('cfg', {});
    $('cfg-temp-value').disabled = true;
    return;
  }
  providerSelect.value = g.provider_id || '';
  if (document.activeElement !== $('cfg-model')) $('cfg-model').value = g.model || '';
  applyParamControls('cfg', g.parameters);
  renderRightProviderHint();
}

function renderRightProviderHint() {
  const g = activeGroup();
  const hint = $('cfg-provider-hint');
  if (!hint) return;
  if (!g) {
    hint.textContent = '尚无对照配置。';
    hint.className = 'provider-hint warn';
    hint.title = '';
    return;
  }
  const tpl = templateById(g.template_id);
  const prov = providerById(g.provider_id);
  const bits = [];
  let warn = false;
  if (!tpl) { bits.push('模板缺失'); warn = true; }
  if (!prov) {
    bits.push('Provider 缺失');
    warn = true;
  } else {
    const protocol = protocolLabel(prov.protocol || '未设置协议');
    bits.push(protocol);
    if (!App.providerProtocolsLoaded || !isKnownProtocol(prov.protocol)) warn = true;
    const pending = pendingCredentialFor(prov.id);
    const meta = credentialMeta(prov.id);
    if (pending && pending.kind === 'set') bits.push('手动密钥待保存');
    else if (pending && pending.kind === 'clear') {
      bits.push(meta && meta.env_available ? '待清除 · 回退环境变量' : '待清除 · 环境变量缺失');
      if (meta && meta.requires_auth && !meta.env_available) warn = true;
    } else if (meta) {
      const src = credentialSourceBadge(meta);
      bits.push(src.label);
      if (meta.requires_auth && !meta.available) warn = true;
    } else {
      bits.push('凭据未验证');
      warn = true;
    }
    if (prov.api_key_env) bits.push(`env ${prov.api_key_env}`);
    hint.title = [prov.name || prov.id, prov.base_url || '', protocol].filter(Boolean).join(' · ');
  }
  if (!String(g.model || '').trim()) { bits.push('模型 ID 为空'); warn = true; }
  hint.textContent = bits.join(' · ');
  hint.className = `provider-hint${warn ? ' warn' : ''}`;
}

function setParam(params, key, mode, rawValue) {
  if (mode === 'omit') {
    delete params[key];
    return true;
  }
  if (mode === 'null') {
    params[key] = null;
    return true;
  }
  if (key === 'temperature') {
    const n = Number(rawValue);
    if (rawValue === '' || !Number.isFinite(n)) return false;
    params[key] = n;
    return true;
  }
  if (mode === 'custom') {
    if (!rawValue) return false;
    params[key] = rawValue;
    return true;
  }
  params[key] = mode;
  return true;
}

function handleRightTempModeChange() {
  const g = activeGroup();
  if (!g) return;
  const mode = $('cfg-temp-mode').value;
  const valueInput = $('cfg-temp-value');
  valueInput.hidden = mode !== 'value';
  valueInput.disabled = mode !== 'value';
  if (mode === 'value') {
    if (!valueInput.value) valueInput.value = hasOwn(g.parameters, 'temperature') && typeof g.parameters.temperature === 'number' ? String(g.parameters.temperature) : '0.1';
    const n = Number(valueInput.value);
    if (Number.isFinite(n)) g.parameters.temperature = n;
  } else if (mode === 'null') {
    g.parameters.temperature = null;
  } else {
    delete g.parameters.temperature;
  }
  afterGroupParameterEdit();
}

function handleRightTempValueChange() {
  const g = activeGroup();
  if (!g) return;
  const input = $('cfg-temp-value');
  const n = Number(input.value);
  if (input.value === '' || !Number.isFinite(n)) {
    input.value = hasOwn(g.parameters, 'temperature') && typeof g.parameters.temperature === 'number' ? String(g.parameters.temperature) : '';
    toast('温度必须是数值；未修改参数。', 'error');
    return;
  }
  g.parameters.temperature = n;
  afterGroupParameterEdit();
}

function handleRightReasoningModeChange() {
  const g = activeGroup();
  if (!g) return;
  const mode = $('cfg-reasoning-mode').value;
  if (mode === 'custom') {
    applyParamControls('cfg', g.parameters);
    toast('非标准思考强度只在高级 JSON 中编辑；已打开完整参数。', 'info', 3000);
    openGroupDialog(g.id);
    return;
  }
  if (mode === 'omit') delete g.parameters.reasoning_effort;
  else if (mode === 'null') g.parameters.reasoning_effort = null;
  else g.parameters.reasoning_effort = mode;
  afterGroupParameterEdit();
}

function afterGroupParameterEdit() {
  renderGroups();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('请求参数已修改');
}

function handleGroupModelInput() {
  const g = activeGroup();
  if (!g) return;
  g.model = $('cfg-model').value;
  renderGroups();
  renderRightProviderHint();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('模型已修改');
}

/* ------------------------------------------------------------------ */
/* Group dialog (advanced parameters)                                   */
/* ------------------------------------------------------------------ */

function openGroupDialog(id = null) {
  if (!App.state) return;
  const existing = id ? groupById(id) : null;
  const working = existing ? clone(existing) : nextGroupDefaults();
  if (id && !existing) return;
  App.groupDialog = { mode: existing ? 'edit' : 'create', id: working.id, params: clone(working.parameters || {}) };
  $('group-dialog-title').textContent = existing ? '编辑对照配置' : '添加对照配置';
  $('group-name').value = working.name;
  $('group-enabled').checked = working.enabled;
  $('group-runs').value = working.runs;
  $('group-model').value = working.model || '';
  const tplSelect = $('group-template');
  tplSelect.innerHTML = App.state.templates.length
    ? App.state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name || t.id)}</option>`).join('')
    : '<option value="">（无模板）</option>';
  tplSelect.value = working.template_id || '';
  const provSelect = $('group-provider');
  provSelect.innerHTML = App.state.providers.length
    ? App.state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} · ${esc(protocolLabel(p.protocol || '未设置协议'))}</option>`).join('')
    : '<option value="">（无 Provider）</option>';
  provSelect.value = working.provider_id || '';
  $('group-params').value = pretty(App.groupDialog.params);
  applyParamControls('group', App.groupDialog.params);
  $('group-error').textContent = '';
  $('group-params').removeAttribute('aria-invalid');
  $('group-dialog').showModal();
  window.setTimeout(() => $('group-name').focus(), 0);
}

function syncGroupParamsTextarea() {
  const ta = $('group-params');
  if (!ta) return;
  if (document.activeElement === ta || ta.getAttribute('aria-invalid') === 'true') return;
  ta.value = pretty(App.groupDialog.params);
}

function handleGroupParamQuickChange(field) {
  const params = App.groupDialog.params;
  if (field === 'temp') {
    const mode = $('group-temp-mode').value;
    const valueInput = $('group-temp-value');
    valueInput.hidden = mode !== 'value';
    valueInput.disabled = mode !== 'value';
    let raw = valueInput.value;
    if (mode === 'value' && !raw) {
      raw = hasOwn(params, 'temperature') && typeof params.temperature === 'number' ? String(params.temperature) : '0.1';
      valueInput.value = raw;
    }
    if (!setParam(params, 'temperature', mode, raw)) return;
  } else {
    const mode = $('group-reasoning-mode').value;
    if (mode === 'custom') {
      applyParamControls('group', params);
      return;
    }
    if (!setParam(params, 'reasoning_effort', mode, '')) return;
  }
  syncGroupParamsTextarea();
}

function parseGroupParamsText() {
  const ta = $('group-params');
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (err) {
    throw new Error(`高级参数 JSON 解析失败：${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('高级参数必须是 JSON 对象。');
  }
  for (const reserved of ['model', 'messages', 'stream']) {
    if (hasOwn(parsed, reserved)) throw new Error(`参数中不允许保留字段「${reserved}」。`);
  }
  for (const key of Object.keys(parsed)) {
    const lower = key.toLowerCase();
    if (['authorization', 'api_key', 'api-key', 'apikey', 'headers', 'extra_headers'].includes(lower)) {
      throw new Error(`参数「${key}」可能包含凭据；请改用 Provider 的环境变量引用。`);
    }
  }
  return parsed;
}

function submitGroupDialog(event) {
  event.preventDefault();
  if (!App.state) return;
  const errEl = $('group-error');
  errEl.textContent = '';
  $('group-params').removeAttribute('aria-invalid');
  const name = $('group-name').value.trim();
  const model = $('group-model').value.trim();
  const templateId = $('group-template').value;
  const providerId = $('group-provider').value;
  const runs = Number($('group-runs').value);
  if (!name) {
    errEl.textContent = '配置名称不能为空。';
    $('group-name').focus();
    return;
  }
  if (!templateId || !templateById(templateId)) {
    errEl.textContent = '请选择存在的模板。';
    $('group-template').focus();
    return;
  }
  if (!providerId || !providerById(providerId)) {
    errEl.textContent = '请选择存在的 Provider。';
    $('group-provider').focus();
    return;
  }
  if (!model) {
    errEl.textContent = '模型 ID 不能为空（可自由输入，不受硬编码允许列表限制）。';
    $('group-model').focus();
    return;
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000) {
    errEl.textContent = '每 case 次数必须为 1–1000 的整数。';
    $('group-runs').focus();
    return;
  }
  let params;
  try {
    params = parseGroupParamsText();
  } catch (err) {
    errEl.textContent = err.message;
    $('group-params').setAttribute('aria-invalid', 'true');
    $('group-params').focus();
    return;
  }
  if ($('group-temp-mode').value === 'value') {
    const n = Number($('group-temp-value').value);
    if ($('group-temp-value').value === '' || !Number.isFinite(n)) {
      errEl.textContent = '温度模式为“数值”时必须填写有效数字；若不应发送，请选择“未发送”。';
      $('group-temp-value').focus();
      return;
    }
    params.temperature = n;
  }
  const group = {
    id: App.groupDialog.id,
    name,
    enabled: $('group-enabled').checked,
    template_id: templateId,
    provider_id: providerId,
    model,
    parameters: params,
    runs
  };
  const idx = App.state.draft.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) App.state.draft.groups[idx] = group;
  else App.state.draft.groups.push(group);
  App.activeGroupId = group.id;
  const boundTemplate = templateById(group.template_id);
  if (boundTemplate) {
    App.activeTemplateId = boundTemplate.id;
    App.activeMessageIndex = 0;
  }
  $('group-dialog').close();
  renderTemplateOptions();
  renderTemplateEditor();
  renderGroups();
  renderRightConfig();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('对照配置已修改');
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
          const src = credentialSourceBadge(meta).label;
          errors.push(`Provider「${prov.name || prov.id}」缺少可用凭据（${src}），协议要求认证。`);
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
  }
  if (!cases.length) errors.push('未选择任何 case（在左侧勾选参与运行的 case）。');
  const rawCaseIds = App.state.draft.case_ids;
  if (new Set(rawCaseIds).size !== rawCaseIds.length) errors.push('草稿中的 case 选择包含重复 ID。');
  const dangling = rawCaseIds.filter((id) => !caseById(id));
  if (dangling.length) errors.push(`草稿引用了不存在的 case：${dangling.join(', ')}。请删除或重新载入。`);
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
      ? `${plan.cases.length} 个 case × ${plan.runsPerCase} 次 = ${plan.total} 次请求 · 并发 ≤ ${plan.concurrency}`
      : '选择案例并启用配置后开始运行';
  }
  const btn = $('run-btn');
  const label = $('run-btn-label');
  if (!btn || !label) return;
  const active = hasKnownActiveBatch();
  const stopping = App.currentDetail?.batch?.status === 'stopping';
  const disabled = active || App.saving || App.loading || plan.errors.length > 0 || plan.total <= 0;
  btn.disabled = disabled;
  btn.classList.toggle('busy', active);
  label.textContent = active
    ? (stopping ? '停止中…' : '批次运行中')
    : (plan.total > 0 ? `运行 ${plan.total} 次` : '运行');
  btn.title = plan.errors.length
    ? `无法运行：${plan.errors[0]}`
    : (active ? '已有批次运行中；可在运行输出面板查看或停止' : '保存草稿并以当前选择启动批次');
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
    lines.push('<div class="validation-line warn">○ 尚未选择可运行的 case 或配置。</div>');
  }
  el.innerHTML = lines.join('');
}

/* ------------------------------------------------------------------ */
/* Save / reload                                                       */
/* ------------------------------------------------------------------ */

async function saveState({ silent = false } = {}) {
  if (!App.state) return false;
  if (App.saving) return false;
  if (App.settingsError.length) {
    showBanner(`设置存在错误，未保存：${App.settingsError[0]}`, 'error');
    return false;
  }
  if (hasVarErrors()) {
    const id = [...App.varErrors.keys()][0];
    App.activeCaseId = caseById(id) ? id : App.activeCaseId;
    App.editorTab = 'variables';
    renderCaseList();
    setEditorTabUI();
    syncVariablesEditor();
    showBanner('变量 JSON 存在解析错误，未保存。请修正编辑器中的 JSON。', 'error');
    const ta = $('variables-json');
    if (ta) ta.focus();
    return false;
  }
  if (!isDirty() && !hasPendingCredentials()) {
    if (!silent) toast('没有需要保存的更改', 'info', 1800);
    return true;
  }
  App.saving = true;
  updateDirtyUI();
  refreshRunPlan();
  const submitted = clone(App.state);
  submitted.version = App.version;
  delete submitted.credentials;
  const submittedMutations = new Map();
  for (const [id, mutation] of App.credentialMutations) submittedMutations.set(id, { ...mutation });
  const credentialUpdates = {};
  for (const [id, mutation] of submittedMutations) {
    if (mutation.kind === 'set') {
      if (submitted.providers.some((p) => p.id === id)) credentialUpdates[id] = { action: 'set', key: mutation.value };
    } else if (mutation.kind === 'clear') {
      credentialUpdates[id] = { action: 'clear' };
    }
  }
  const body = clone(submitted);
  if (Object.keys(credentialUpdates).length) body.credential_updates = credentialUpdates;
  try {
    const res = await apiPut('/api/state', body);
    const nextVersion = res && Number.isFinite(Number(res.version)) ? Number(res.version) : App.version + 1;
    App.version = nextVersion;
    App.state.version = nextVersion;
    if (res && Object.prototype.hasOwnProperty.call(res, 'credentials')) {
      App.credentials = normalizeCredentials(res.credentials);
    }
    let savedSnapshot;
    if (res && Array.isArray(res.providers) && Array.isArray(res.cases)) {
      const serverState = clone(res);
      delete serverState.credentials;
      delete serverState.credential_updates;
      savedSnapshot = normalizeState(serverState);
      savedSnapshot.version = nextVersion;
      for (const sp of savedSnapshot.providers) {
        const lp = providerById(sp.id);
        if (!lp) continue;
        if (sp.credential_ref) lp.credential_ref = sp.credential_ref;
        if (!lp.protocol && sp.protocol) lp.protocol = sp.protocol;
      }
    } else {
      savedSnapshot = clone(submitted);
      savedSnapshot.version = nextVersion;
    }
    App.savedJson = stableStringify(savedSnapshot);
    for (const [id, mutation] of submittedMutations) {
      const current = App.credentialMutations.get(id);
      if (current && sameValue(current, mutation)) App.credentialMutations.delete(id);
    }
    App.savedAt = new Date();
    hideBanner();
    clearEditorRenderError();
    renderProviders();
    renderRightProviderHint();
    if (!silent) {
      toast(submittedMutations.size
        ? '草稿与手动凭据已保存（凭据由后端加密存储）。运行中的批次继续使用其冻结快照。'
        : '草稿已保存。运行中的批次继续使用其冻结快照。', 'ok');
    }
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
  if (hasVarErrors()) {
    showBanner('变量 JSON 存在解析错误，未执行。请先修正编辑器。', 'error');
    showVariablesError(App.varErrors.get(App.activeCaseId) || '');
    return false;
  }
  if (!isDirty() && !hasPendingCredentials()) return true;
  const ok = await saveState({ silent: true });
  if (!ok) return false;
  if (isDirty() || hasVarErrors() || hasPendingCredentials()) {
    markPreviewStale('保存期间草稿或凭据又有编辑');
    showBanner('保存期间草稿又被编辑，本次操作未执行。请确认当前内容后再次点击。', 'warn');
    toast('保存期间草稿有新的编辑，已取消本次预览/运行', 'error', 5000);
    refreshRunPlan();
    return false;
  }
  return true;
}

async function reloadFromServer() {
  if (hasUnsavedWork() && !window.confirm('重新载入会丢弃本地未保存更改（包括编辑器内容、待保存的手动密钥）。继续？')) return;
  App.credentialMutations.clear();
  try {
    await loadState();
    App.preview = null;
    App.previewStale = true;
    App.historyDetail = null;
    hideBanner();
    renderAll();
    renderPreviewState();
    await refreshRuns({ quiet: true });
    refreshPreview({ silent: true });
    toast('已重新载入服务端状态', 'ok');
  } catch (err) {
    showBanner(`重新载入失败：${err.message}`, 'error', reloadFromServer);
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
    // Re-read selection after the await: it may have changed while saving.
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
      showEditorRenderError(`预览未执行：服务端状态版本已变化（409）。请重新载入后再预览，避免展示过期请求。`);
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
  if (!App.state || App.saving || App.loading) return;
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
      case_ids: plan.cases,
      groups: plan.enabledGroups.map(clone),
      concurrency: clampInt(App.state.settings.concurrency, 1, 20, 20),
      state_version: App.version
    };
    const batch = await apiPost('/api/runs', body);
    App.currentRunId = batch.id;
    App.currentDetail = null;
    App.expandedResults.clear();
    setView('workbench');
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
        const finished = (summary.completed || 0) + (summary.failed || 0) + (summary.cancelled || 0) + (summary.interrupted || 0);
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
    renderRecentRuns();
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
  const metaBits = [
    `#${r.iteration}`,
    r.response_model ? `响应模型 ${r.response_model}` : '',
    r.http_status ? `HTTP ${r.http_status}` : '',
    r.prompt_hash ? `hash ${r.prompt_hash.slice(0, 16)}…` : ''
  ].filter(Boolean);
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
          <div class="snapshot-chip"><div class="name">冻结请求</div><div class="meta">${requests.length} 个渲染请求</div></div>
        </div>
      </div>
      <div class="snapshot-section">
        <h3>Case 与变量</h3>
        ${snapshotChips(cases, (c) => `<div class="snapshot-chip"><div class="name">${esc(c.name || c.id)}</div><div class="meta">${esc(c.id)} · ${esc(String(Object.keys(c.variables || {}).length))} 个变量</div></div>`)}
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
        ${snapshotChips(groups, (g) => `<div class="snapshot-chip"><div class="name">${esc(g.name || g.id)}${g.enabled === false ? '（已禁用）' : ''}</div><div class="meta">${esc(g.model || '—')} · ${esc(String(g.runs))} 次<br>${esc(pretty(g.parameters || {}))}</div></div>`)}
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
    setView('workbench');
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
  setView('workbench');
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
  if (undoBtn.hidden && clearBtn.hidden) {
    // keep both unavailable
  }
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

function submitProviderDialog(event) {
  event.preventDefault();
  if (!App.state) return;
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
  }

  if (App.providerDialog.clearKey) {
    App.credentialMutations.set(target.id, { kind: 'clear' });
  } else if (keyInput.value !== '') {
    App.credentialMutations.set(target.id, { kind: 'set', value: keyInput.value });
  }
  keyInput.value = '';
  App.providerDialog.clearKey = false;
  $('provider-dialog').close();
  renderProviders();
  renderRightConfig();
  renderGroups();
  renderModelSuggestions();
  updateDirtyUI();
  refreshRunPlan();
  markPreviewStale('Provider 配置已修改');
  if (pendingCredentialFor(target.id)) toast('Provider 已更新；手动凭据更改将在保存草稿时提交', 'ok');
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
  // A pending clear for a persisted provider is intentionally kept for the same atomic save.
  delete App.credentials[id];
  renderProviders();
  renderGroups();
  renderRightConfig();
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
    updateDirtyUI();
    refreshRunPlan();
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

function setView(view) {
  if (!['workbench', 'history', 'providers', 'settings'].includes(view)) return;
  App.activeView = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${view}`;
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  const caseSection = $('case-section');
  if (caseSection) caseSection.hidden = false;
  if (view === 'workbench') {
    renderCaseList();
    renderTemplateEditor();
    renderGroups();
    renderRightConfig();
    refreshRunPlan();
  } else if (view === 'history') {
    renderHistoryList();
    if (!App.runsLoaded) refreshRuns();
  } else if (view === 'providers') {
    renderProviders();
  } else if (view === 'settings') {
    renderSettings();
  }
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

  $('new-case-btn').addEventListener('click', () => openCaseDialog('create'));
  $('refresh-runs-btn').addEventListener('click', () => refreshRuns());
  $('history-refresh-btn').addEventListener('click', async () => {
    await refreshRuns();
    if (App.historySelectedId) loadHistoryDetail(App.historySelectedId);
    toast('历史已刷新', 'ok', 1600);
  });

  $('save-btn').addEventListener('click', () => saveState());
  $('global-save-btn').addEventListener('click', () => saveState());
  $('run-btn').addEventListener('click', startRun);
  $('draft-name').addEventListener('input', (e) => {
    App.state.draft.name = e.target.value;
    renderShell();
    updateDirtyUI();
    markPreviewStale('草稿名称已修改');
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
    renderGroups();
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
    $('variables-json').addEventListener(evt, () => updateLineInfo($('variables-json'), $('var-lineinfo')));
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

  document.querySelectorAll('[data-editor-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      App.editorTab = btn.dataset.editorTab;
      setEditorTabUI();
      if (App.editorTab === 'variables') syncVariablesEditor();
      renderTemplateEditor();
    });
  });

  $('variables-json').addEventListener('input', handleVariablesInput);
  $('format-vars-btn').addEventListener('click', formatVariables);
  $('variable-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-var-add]');
    if (btn) addVariableHelper(btn.dataset.varAdd);
  });
  $('insert-var-menu').addEventListener('toggle', () => {
    if ($('insert-var-menu').open) renderInsertVarList();
  });
  $('insert-var-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-var-insert]');
    if (!btn) return;
    insertVariableToken(btn.dataset.varInsert);
    $('insert-var-menu').open = false;
  });

  $('case-list').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-case-select]');
    if (cb) toggleCaseSelection(cb.dataset.caseSelect, cb.checked);
  });
  $('case-list').addEventListener('click', (e) => {
    const activate = e.target.closest('[data-case-activate]');
    if (activate) { setActiveCase(activate.dataset.caseActivate); return; }
    const menu = e.target.closest('[data-case-menu]');
    if (menu) openCaseDialog('edit', menu.dataset.caseMenu);
  });

  $('add-group-btn').addEventListener('click', () => openGroupDialog());
  $('groups-body').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-group-enabled]');
    if (!cb) return;
    const g = groupById(cb.dataset.groupEnabled);
    if (!g) return;
    g.enabled = cb.checked;
    renderGroups();
    renderRightConfig();
    updateDirtyUI();
    refreshRunPlan();
    markPreviewStale('配置启用状态已修改');
  });
  $('groups-body').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-group-edit]');
    if (edit) { setActiveGroup(edit.dataset.groupEdit); openGroupDialog(edit.dataset.groupEdit); return; }
    const del = e.target.closest('[data-group-delete]');
    if (del) { deleteGroup(del.dataset.groupDelete); return; }
    const row = e.target.closest('tr[data-group-id]');
    if (row && !e.target.closest('input,button')) setActiveGroup(row.dataset.groupId);
  });

  $('cfg-toggle').addEventListener('click', () => {
    const body = $('cfg-body');
    const expanded = $('cfg-toggle').getAttribute('aria-expanded') === 'true';
    $('cfg-toggle').setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.hidden = expanded;
  });
  $('cfg-group-select').addEventListener('change', (e) => {
    if (e.target.value) setActiveGroup(e.target.value);
  });
  $('cfg-provider').addEventListener('change', (e) => {
    const g = activeGroup();
    if (!g) return;
    g.provider_id = e.target.value;
    renderRightProviderHint();
    renderGroups();
    updateDirtyUI();
    refreshRunPlan();
    markPreviewStale('Provider 已修改');
  });
  $('cfg-model').addEventListener('input', handleGroupModelInput);
  $('cfg-temp-mode').addEventListener('change', handleRightTempModeChange);
  $('cfg-temp-value').addEventListener('change', handleRightTempValueChange);
  $('cfg-reasoning-mode').addEventListener('change', handleRightReasoningModeChange);
  $('edit-group-btn').addEventListener('click', () => {
    if (App.activeGroupId) openGroupDialog(App.activeGroupId);
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

  $('recent-runs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-run-open]');
    if (!btn) return;
    setView('history');
    loadHistoryDetail(btn.dataset.runOpen);
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

  $('case-form').addEventListener('submit', submitCaseDialog);
  $('case-duplicate-btn').addEventListener('click', () => {
    const id = App.caseDialog.id;
    $('case-dialog').close();
    if (id) openCaseDialog('duplicate', id);
  });
  $('case-delete-btn').addEventListener('click', deleteCaseFromDialog);

  $('group-form').addEventListener('submit', submitGroupDialog);
  $('group-temp-mode').addEventListener('change', () => handleGroupParamQuickChange('temp'));
  $('group-temp-value').addEventListener('change', () => handleGroupParamQuickChange('temp'));
  $('group-reasoning-mode').addEventListener('change', () => handleGroupParamQuickChange('reasoning'));
  $('group-params').addEventListener('input', () => {
    try {
      App.groupDialog.params = parseGroupParamsText();
      App.groupDialog.params = clone(App.groupDialog.params);
      applyParamControls('group', App.groupDialog.params);
      $('group-error').textContent = '';
      $('group-params').removeAttribute('aria-invalid');
    } catch (err) {
      $('group-error').textContent = err.message;
      $('group-params').setAttribute('aria-invalid', 'true');
    }
  });

  $('provider-form').addEventListener('submit', submitProviderDialog);
  $('provider-type').addEventListener('change', () => {
    updateProviderProtocolHint();
    updateProviderCredentialUI();
  });
  $('provider-env').addEventListener('input', () => updateProviderCredentialUI());
  $('provider-api-key').addEventListener('input', () => {
    if (App.providerDialog.clearKey && $('provider-api-key').value !== '') {
      App.providerDialog.clearKey = false;
      updateProviderCredentialUI();
    }
  });
  $('provider-clear-key').addEventListener('click', () => {
    App.providerDialog.clearKey = true;
    const key = $('provider-api-key');
    if (key) key.value = '';
    updateProviderCredentialUI();
  });
  $('provider-undo-credential').addEventListener('click', () => {
    if (App.providerDialog.clearKey) {
      App.providerDialog.clearKey = false;
    } else if (App.providerDialog.id) {
      discardCredentialMutation(App.providerDialog.id);
    }
    updateProviderCredentialUI();
    renderRightProviderHint();
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

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedWork()) {
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
}

async function init() {
  renderVariableChips();
  bindStaticEvents();
  setView('workbench');
  await bootstrap();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
