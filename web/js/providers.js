import { $, esc } from './utils.js';
import { App } from './state.js';
import { credentialMeta, groupById, isKnownProtocol, markEdit, newProviderId, pendingCredentialFor, protocolById, providerById } from './model.js';
import { renderGroupCards, renderModelSuggestions } from './workbench-view.js';
import { providerProtocolTag } from './snapshot.js';
import { ICON_EDIT, ICON_TRASH } from './constants.js';
import { updateDirtyUI } from './shell-view.js';
import { saveState } from './persistence.js';
import { refreshRunPlan } from './run-plan.js';
import { markPreviewStale } from './preview-state.js';
import { toast } from './feedback.js';
import { apiGet } from './api.js';

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

function discardCredentialMutation(id) {
  App.credentialMutations.delete(id);
  updateDirtyUI();
  renderProviders();
  renderGroupCards();
}

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

export function bindProviderEvents() {
  $('add-provider-btn').addEventListener('click', () => openProviderDialog());
  $('providers-body').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-provider-edit]');
    if (edit) { openProviderDialog(edit.dataset.providerEdit); return; }
    const del = e.target.closest('[data-provider-delete]');
    if (del) deleteProvider(del.dataset.providerDelete);
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
}

export { loadProtocols, renderProviders };
