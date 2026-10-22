package workbench

import (
	"encoding/json"
)

// Each existing batch worker owns one generation followed by its independent
// metric calls. This shares the global concurrency cap without another queue.
func (e *Engine) evaluateResult(a *activeBatch, idx int, r Result, request FrozenRequest) Result {
	for j, f := range a.detail.Snapshot.Metrics {
		e.mu.Lock()
		if e.fatal != nil {
			e.mu.Unlock()
			return r
		}
		o := r.Evaluations[j]
		switch {
		case a.stopped:
			o.Status = "cancelled"
			o.Error = "stopped before metric dispatch"
		case r.Status != "completed":
			o.Status = "skipped"
			o.Error = "generation did not complete"
		default:
			o.Status = "running"
			o.StartedAt = now()
		}
		p := &a.detail.Batch.Evaluation
		p.Pending--
		if o.Status == "running" {
			p.Running++
		} else {
			o.FinishedAt = now()
			if o.Status == "cancelled" {
				p.Cancelled++
			} else {
				p.Skipped++
			}
		}
		r.Evaluations[j] = o
		a.detail.Results[idx] = r
		if err := e.store.update(a.detail.Batch, r); err != nil {
			e.fatal = err
			e.mu.Unlock()
			return r
		}
		e.mu.Unlock()
		if o.Status != "running" {
			continue
		}
		input := MetricInput{Output: r.Output, Group: MetricGroup{ID: r.GroupID, Name: r.GroupName, Model: r.Model}, Iteration: r.Iteration, LanguageResolution: request.LanguageResolution}
		for _, c := range a.detail.Snapshot.Cases {
			if c.ID == r.CaseID {
				input.Case = c
				break
			}
		}
		input, err := prepareMetricInput(input, f.Target)
		if err != nil {
			o.Status = "error"
			o.Error = err.Error()
			o.FinishedAt = now()
		} else if f.Metric.Kind == "code" {
			o = runCodeMetric(f.Metric, input)
		} else {
			o = e.callModelMetric(f, input, a.keys[f.Provider.CredentialRef], a.detail.Snapshot.TimeoutSeconds)
		}
		o.MetricID = f.Metric.ID
		if o.StartedAt == "" {
			o.StartedAt = r.Evaluations[j].StartedAt
		}
		// Even code errors/reasons and arbitrary provider distributions can echo a
		// credential known to the server. Redact before any durable write.
		raw, _ := json.Marshal(o)
		raw = redactBody(raw, e.store.sensitiveValues())
		var clean MetricOutcome
		if json.Unmarshal(raw, &clean) == nil {
			o = clean
		}
		e.mu.Lock()
		p = &a.detail.Batch.Evaluation
		p.Running--
		if o.Status == "completed" {
			p.Completed++
		} else {
			p.Error++
		}
		r.Evaluations[j] = o
		a.detail.Results[idx] = r
		if err := e.store.update(a.detail.Batch, r); err != nil {
			e.fatal = err
		}
		e.mu.Unlock()
	}
	return r
}
