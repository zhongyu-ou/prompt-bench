import { App } from './state.js';
import { $, clone, esc, stableStringify, uniqueId } from './utils.js';
import { activeTemplate, markEdit, hasUnsavedWork } from './model.js';
import { apiPost } from './api.js';
import { ensureSaved, saveState } from './persistence.js';
import { toast } from './feedback.js';
import { refreshRunPlan } from './run-plan.js';

export function renderContractBinding() {
  const select = $('template-contract');
  if (!select || !App.state) return;
  const template = activeTemplate();
  select.innerHTML = '<option value="">未绑定（沿用模板变量）</option>' + App.state.input_contracts.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('');
  select.value = template?.input_contract_id || '';
  select.disabled = !template;
}

function editorValue() {
  const fields = JSON.parse($('contract-fields').value);
  if (!fields || Array.isArray(fields) || typeof fields !== 'object') throw new Error('字段定义必须为 JSON 对象。');
  return { id: App.contractEditor.id, name: $('contract-name').value, description: $('contract-description').value, fields };
}

function fingerprint() {
  return JSON.stringify([App.version, App.editGeneration, $('contract-name').value, $('contract-description').value, $('contract-fields').value]);
}

export function contractEditorDirty() {
  if (!$('contract-dialog')?.open || !App.contractEditor) return false;
  try { return stableStringify(editorValue()) !== App.contractEditor.baseline; } catch { return true; }
}

function invalidate() {
  if (!App.contractEditor) return;
  App.contractEditor.localEdits += 1;
  App.contractEditor.reviewed = '';
  $('contract-save').disabled = true;
  $('contract-impact').textContent = '字段已更改，请重新检查受影响模板与当前 Cases。';
}

function openEditor(id, copy = false) {
  const source = App.state.input_contracts.find((c) => c.id === id);
  const value = source ? clone(source) : { name: '', description: '', fields: {} };
  if (!source || copy) value.id = uniqueId('contract_', new Set(App.state.input_contracts.map((c) => c.id)));
  if (copy) value.name += '（副本）';
  App.contractEditor = { id: value.id, baseline: stableStringify(value), reviewed: '', busy: false, localEdits: 0 };
  $('contract-select').innerHTML = '<option value="">新契约</option>' + App.state.input_contracts.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('');
  $('contract-select').value = !copy && source ? source.id : '';
  $('contract-name').value = value.name;
  $('contract-description').value = value.description || '';
  $('contract-fields').value = JSON.stringify(value.fields, null, 2);
  $('contract-error').textContent = '';
  $('contract-impact').textContent = '保存前必须检查所有引用模板与当前 Cases；检查不会改写任何 Case。';
  $('contract-save').disabled = true;
  $('contract-delete').disabled = !source || copy || App.state.templates.some((t) => t.input_contract_id === value.id);
}

function discardAllowed() {
  if (!App.contractEditor || App.contractEditor.busy) return !App.contractEditor?.busy;
  try { if (stableStringify(editorValue()) === App.contractEditor.baseline) return true; } catch {}
  return window.confirm('输入契约有未保存的更改。放弃？');
}

async function reviewImpact() {
  const editor = App.contractEditor;
  if (!editor || editor.busy) return;
  editor.busy = true;
  $('contract-error').textContent = '';
  try {
    editorValue(); // Surface invalid JSON before attempting to save other draft edits.
    // Impact is checked against the current saved template bindings and current Cases.
    // Save other draft edits first, without changing the separately edited contract.
    if (hasUnsavedWork() && !await ensureSaved()) return;
    const contract = editorValue();
    const token = fingerprint();
    const impact = await apiPost('/api/input-contracts/impact', { state_version: App.version, contract });
    if (App.contractEditor !== editor || token !== fingerprint()) return;
    const templates = impact.template_ids.map((id) => App.state.templates.find((t) => t.id === id)?.name || id);
    const cases = impact.cases || [];
    $('contract-impact').innerHTML = `<h3>保存影响（尚未保存）</h3><p>引用模板：${esc(templates.join('、') || '无')}；检查当前 Cases ${cases.length} 条。</p><div class="contract-impact-cases">${cases.map((c) => `<div><strong class="mono">${esc(c.case_id)}</strong>：修改前 ${c.before_errors?.length || 0} 项错误 → 修改后 ${c.after_errors?.length || 0} 项错误${(c.after_errors || []).map((e) => `<div class="field-error">${esc(e.path)}：${esc(e.message)}</div>`).join('')}</div>`).join('')}</div><p>确认后共享更新所有引用模板的未来使用；历史不变，不修改 Cases。</p>`;
    editor.reviewed = token;
    $('contract-save').disabled = false;
  } catch (error) {
    $('contract-error').textContent = error.message;
  } finally { editor.busy = false; }
}

async function saveContract() {
  const editor = App.contractEditor;
  if (!editor || editor.busy) return;
  if (!editor.reviewed || editor.reviewed !== fingerprint()) { invalidate(); return; }
  editor.busy = true;
  $('contract-save').disabled = true;
  try {
    const contract = editorValue();
    const previous = App.state.input_contracts.find((c) => c.id === contract.id);
    const index = App.state.input_contracts.findIndex((c) => c.id === contract.id);
    if (index < 0) App.state.input_contracts.push(contract); else App.state.input_contracts[index] = contract;
    markEdit();
    const submittedGeneration = App.editGeneration;
    const submittedLocalEdits = editor.localEdits;
    const ok = await saveState({ silent: true });
    if (!ok) {
      // A failed write must not allow the global Save button to bypass impact review.
      if (submittedGeneration === App.editGeneration) {
        if (previous) App.state.input_contracts[index] = previous;
        else App.state.input_contracts = App.state.input_contracts.filter((c) => c.id !== contract.id);
      }
      invalidate();
      return;
    }
    if (App.contractEditor !== editor) return;
    editor.baseline = stableStringify(contract);
    if (submittedLocalEdits !== editor.localEdits || submittedGeneration !== App.editGeneration) {
      invalidate();
      $('contract-impact').textContent = '服务端已保存提交时的契约；保存期间的新编辑已保留，请重新检查影响后再次保存。';
      renderContractBinding();
      return;
    }
    editor.busy = false;
    openEditor(contract.id);
    renderContractBinding();
    toast('共享输入契约已保存，未来生成使用更新后的定义。', 'ok');
  } catch (error) { $('contract-error').textContent = error.message; }
  finally { editor.busy = false; }
}

export function bindContractEvents() {
  $('template-contract').addEventListener('change', (e) => {
    const template = activeTemplate();
    if (!template) return;
    if (e.target.value) template.input_contract_id = e.target.value; else delete template.input_contract_id;
    markEdit(); refreshRunPlan();
  });
  $('contracts-manage').addEventListener('click', () => {
    openEditor(activeTemplate()?.input_contract_id || App.state.input_contracts[0]?.id);
    $('contract-dialog').showModal();
  });
  $('contract-close').addEventListener('click', () => { if (discardAllowed()) $('contract-dialog').close(); });
  $('contract-dialog').addEventListener('cancel', (e) => { if (!discardAllowed()) e.preventDefault(); });
  $('contract-dialog').addEventListener('click', (e) => { if (e.target === $('contract-dialog') && !discardAllowed()) e.stopImmediatePropagation(); }, true);
  $('contract-select').addEventListener('change', (e) => { if (discardAllowed()) openEditor(e.target.value); else e.target.value = App.state.input_contracts.some((c) => c.id === App.contractEditor.id) ? App.contractEditor.id : ''; });
  $('contract-new').addEventListener('click', () => { if (discardAllowed()) openEditor(); });
  $('contract-copy').addEventListener('click', () => { if (discardAllowed()) openEditor(App.contractEditor.id, true); });
  for (const id of ['contract-name', 'contract-description', 'contract-fields']) $(id).addEventListener('input', invalidate);
  $('contract-review').addEventListener('click', reviewImpact);
  $('contract-save').addEventListener('click', saveContract);
  $('contract-delete').addEventListener('click', async () => {
    const editor = App.contractEditor;
    if (!editor || editor.busy || App.state.templates.some((t) => t.input_contract_id === editor.id)) return;
    if (!discardAllowed() || !window.confirm('删除未引用的契约？已冻结历史不受影响。')) return;
    App.state.input_contracts = App.state.input_contracts.filter((c) => c.id !== editor.id);
    markEdit();
    if (await saveState({ silent: true })) { openEditor(App.state.input_contracts[0]?.id); renderContractBinding(); }
  });
}
