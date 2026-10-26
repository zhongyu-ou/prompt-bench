const BATCH_STATUS = {
  queued: '等待生成完成',
  failed: '失败',
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

const ICON_EDIT = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.8-3.4 8.9-8.9a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1l-8.9 8.9L4 16z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const ICON_TRASH = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l.7 10h6.6l.7-10M8.4 8v5M11.6 8v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const PROHIBITED_VARIABLES = ['TargetLanguageNameMap'];

const LANGUAGE_NAMES = { en: 'English', jp: 'Japanese', ja: 'Japanese', es: 'Spanish', zh: 'Chinese', 'zh-CN': 'Chinese (Simplified)', ko: 'Korean', fr: 'French', de: 'German' };

const METRIC_KIND_LABELS = { code: '代码', model: '模型' };

const METRIC_RETURN_LABELS = { boolean: '布尔', number: '数值', classification: '分类' };

const EVALUATION_STATUS = {
  pending: '待评估',
  running: '评估中',
  completed: '评估完成',
  error: '评估错误',
  skipped: '已跳过',
  cancelled: '已取消',
  interrupted: '结果未知'
};

export { ATTEMPT_STATUS, BATCH_STATUS, EVALUATION_STATUS, ICON_EDIT, ICON_TRASH, LANGUAGE_NAMES, METRIC_KIND_LABELS, METRIC_RETURN_LABELS, PROHIBITED_VARIABLES };
