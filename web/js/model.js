import { App } from './state.js';
import { clampInt, stableStringify } from './utils.js';

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

function markEdit() {
  App.editGeneration += 1;
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
      m.role = typeof m.role === 'string' && m.role ? m.role : 'user';
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

function ensureSelections() {
  if (!App.state) return;
  const cases = App.state.cases;
  const templates = App.state.templates;
  const groups = App.state.draft.groups;
  if (!caseById(App.activeCaseId)) App.activeCaseId = cases.length ? cases[0].id : null;
  if (!groupById(App.activeGroupId)) App.activeGroupId = groups.length ? groups[0].id : null;
  const boundGroup = activeGroup();
  const boundTemplate = boundGroup ? templateById(boundGroup.template_id) : null;
  if (!templateById(App.activeTemplateId)) App.activeTemplateId = boundTemplate?.id || templates[0]?.id || null;
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

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function caseEditorDirty() {
  const ed = App.caseEditor;
  if (!ed) return false;
  return ed.jsonText !== ed.baseline.raw
    || ed.editedFields.size > 0
    || ed.editedExtras.size > 0
    || ed.removedExtras.size > 0
    || !setEqual(ed.collectionIds, ed.baselineCollections);
}

function groupEditorDirty() {
  return !!App.groupEditor && stableStringify(App.groupEditor.working) !== App.groupEditor.baseline;
}

export { activeCase, activeGroup, activeMessage, activeTemplate, caseById, caseEditorDirty, collectionById, collectionsForCase, credentialMeta, ensureSelections, groupById, groupEditorDirty, groupRouteSummary, hasPendingCredentials, hasUnsavedWork, isDirty, isKnownProtocol, markEdit, newProviderId, normalizeCredentials, normalizeState, pendingCredentialFor, protocolById, protocolLabel, providerById, resolveGroupTargets, resolveSelection, selectedCaseIds, setEqual, templateById };
