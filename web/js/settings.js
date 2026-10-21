import { App } from './state.js';
import { $ } from './utils.js';
import { refreshRunPlan, validateSettings } from './run-plan.js';
import { updateDirtyUI } from './shell-view.js';
import { scheduleSelectionPreview } from './selection.js';
import { toast } from './feedback.js';
import { saveState } from './persistence.js';

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
    renderSettings();
    updateDirtyUI();
    refreshRunPlan();
    scheduleSelectionPreview();
  }
}

export function bindSettingsEvents() {
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
}

export { renderSettings };
