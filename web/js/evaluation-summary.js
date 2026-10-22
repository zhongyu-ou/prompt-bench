// Aggregate only the caller's selected results; never infer filters or read UI state.
export function summarizeEvaluations(results, frozenMetrics) {
  const samples = Array.isArray(results) ? results : [];
  const groups = [...new Set(samples.map((result) => result.group_id).filter((id) => typeof id === 'string' && id !== ''))];
  const metrics = new Map();
  const rows = [];
  const indexes = new Map();
  for (const frozen of Array.isArray(frozenMetrics) ? frozenMetrics : []) {
    const metric = frozen?.metric;
    if (!metric || typeof metric.id !== 'string' || metrics.has(metric.id)) continue;
    metrics.set(metric.id, metric);
    const byGroup = new Map();
    indexes.set(metric.id, byGroup);
    for (const group of ['', ...groups]) {
      const labels = Object.fromEntries((Array.isArray(metric.labels) ? metric.labels : []).map((entry) => [entry.label, 0]));
      const row = {
        metric_id: metric.id, group_id: group, valid: 0, true_count: 0, false_count: 0,
        labels, error: 0, skipped: 0, cancelled: 0, interrupted: 0, pending: 0, running: 0
      };
      byGroup.set(group, row);
      rows.push(row);
    }
  }
  const countStatuses = new Set(['error', 'skipped', 'cancelled', 'interrupted', 'pending', 'running']);
  for (const result of samples) {
    for (const outcome of Array.isArray(result.evaluations) ? result.evaluations : []) {
      const metric = metrics.get(outcome.metric_id);
      if (!metric) continue;
      const value = outcome.value;
      const valid = metric.return_type === 'boolean' ? typeof value === 'boolean'
        : metric.return_type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : metric.return_type === 'classification' && typeof value === 'string'
            && (metric.labels || []).some((entry) => entry.label === value);
      const targets = [indexes.get(metric.id).get('')];
      if (result.group_id) {
        const groupRow = indexes.get(metric.id).get(result.group_id);
        if (groupRow) targets.push(groupRow);
      }
      for (const row of targets) {
        if (countStatuses.has(outcome.status)) {
          row[outcome.status] += 1;
          continue;
        }
        if (outcome.status !== 'completed') continue;
        if (!valid) { row.error += 1; continue; }
        row.valid += 1;
        if (metric.return_type === 'boolean') {
          row[value ? 'true_count' : 'false_count'] += 1;
        } else if (metric.return_type === 'classification') {
          row.labels[value] += 1;
        } else {
          row.min = row.min === undefined ? value : Math.min(row.min, value);
          row.max = row.max === undefined ? value : Math.max(row.max, value);
          if (row.mean === undefined) row.mean = value;
          else if ((row.mean < 0 || Object.is(row.mean, -0)) === (value < 0 || Object.is(value, -0))) {
            row.mean += (value - row.mean) / row.valid;
          } else {
            row.mean = row.mean * ((row.valid - 1) / row.valid) + value / row.valid;
          }
        }
      }
    }
  }
  return rows;
}
