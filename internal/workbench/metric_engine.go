package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
)

type activeEvaluation struct {
	detail  EvaluationDetail
	next    int
	stopped bool
	keys    map[string]string
	sources map[string]EvaluationSource
	metrics map[string]FrozenMetric
}

func (e *Engine) startEvaluation(in EvaluationInput) (Evaluation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active != nil || e.activeEvaluation != nil {
		return Evaluation{}, errActive
	}
	if e.closing {
		return Evaluation{}, errors.New("server is shutting down")
	}
	if e.fatal != nil {
		return Evaluation{}, e.fatal
	}
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	state, err := e.store.state()
	if err != nil {
		return Evaluation{}, err
	}
	if state.Version != in.StateVersion {
		return Evaluation{}, errStale
	}
	config, err := freezeEvaluationConfig(state, in.EvaluationConfig)
	if err != nil {
		return Evaluation{}, evaluationInputError{err}
	}
	source, err := e.store.detail(in.GenerationRunID)
	if err != nil {
		return Evaluation{}, err
	}
	sources, err := evaluationSources(source, in.ResultIDs)
	if err != nil {
		return Evaluation{}, err
	}
	d := newEvaluation(in.Name, in.GenerationRunID, "", config, source.Snapshot.TimeoutSeconds)
	if err = populateEvaluation(&d, sources); err != nil {
		return Evaluation{}, evaluationInputError{err}
	}
	keys, err := e.evaluationKeys(d.Snapshot.Metrics)
	if err != nil {
		return Evaluation{}, err
	}
	d.Snapshot = redactEvaluationSnapshot(d.Snapshot, e.store.sensitiveValues())
	d.Evaluation.Status = "running"
	if err = e.store.createEvaluation(d); err != nil {
		return Evaluation{}, err
	}
	e.activateEvaluationLocked(d, keys)
	return d.Evaluation, nil
}
func (e *Engine) evaluationKeys(metrics []FrozenMetric) (map[string]string, error) {
	keys := map[string]string{}
	for _, f := range metrics {
		if err := validateMetric(f.Metric); err != nil {
			return nil, err
		}
		if err := validateMetricTarget(f.Target); err != nil {
			return nil, err
		}
		if f.Metric.Kind != "model" {
			continue
		}
		if f.Provider == nil || f.Provider.Protocol != typesafeProtocol || f.Provider.CredentialRef == "" {
			return nil, errors.New("snapshot decision provider missing")
		}
		if _, err := typesafeEndpoint(*f.Provider); err != nil {
			return nil, err
		}
		key, _, err := e.store.credential(f.Provider.CredentialRef, f.Provider.APIKeyEnv, true, e.getenv)
		if err != nil {
			return nil, evaluationInputError{fmt.Errorf("metric %s: %w", f.Metric.Name, err)}
		}
		keys[f.Provider.CredentialRef] = key
	}
	return keys, nil
}
func (e *Engine) activateEvaluationLocked(d EvaluationDetail, keys map[string]string) {
	a := &activeEvaluation{detail: d, keys: keys, sources: map[string]EvaluationSource{}, metrics: map[string]FrozenMetric{}}
	for _, s := range d.Snapshot.Results {
		a.sources[s.Result.ID] = s
	}
	for _, m := range d.Snapshot.Metrics {
		a.metrics[m.Metric.ID] = m
	}
	e.activeEvaluation = a
	for range d.Evaluation.Concurrency {
		e.wg.Add(1)
		go e.evaluationWorker(a)
	}
}
func (e *Engine) launchChainedEvaluationLocked(a *activeBatch) {
	id := a.detail.Batch.EvaluationExecutionID
	if id == "" || e.fatal != nil {
		return
	}
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	d, err := e.store.evaluationDetail(id)
	if err != nil {
		e.fatal = err
		return
	}
	if d.Evaluation.Status != "queued" {
		return
	}
	if a.stopped || e.closing {
		d.Evaluation.Status = "stopped"
		d.Evaluation.Error = "source generation stopped; evaluation not dispatched"
		d.Evaluation.FinishedAt = now()
		if err = e.store.updateEvaluation(d, false); err != nil {
			e.fatal = err
		}
		return
	}
	source, err := e.store.detail(a.detail.Batch.ID)
	if err == nil {
		var sources []EvaluationSource
		sources, err = evaluationSources(source, nil)
		if err == nil {
			err = populateEvaluation(&d, sources)
		}
	}
	var keys map[string]string
	if err == nil {
		keys, err = e.evaluationKeys(d.Snapshot.Metrics)
	}
	if err != nil {
		d.Evaluation.Status = "failed"
		d.Evaluation.Error = redact(err.Error(), e.store.sensitiveValues())
		d.Evaluation.FinishedAt = now()
		for i := range d.Outcomes {
			o := &d.Outcomes[i].Outcome
			o.Status = "error"
			o.Error = d.Evaluation.Error
			o.FinishedAt = now()
			d.Evaluation.Failed++
		}
	} else {
		d.Evaluation.Status = "running"
	}
	d.Snapshot = redactEvaluationSnapshot(d.Snapshot, e.store.sensitiveValues())
	if err = e.store.updateEvaluation(d, true); err != nil {
		e.fatal = err
		return
	}
	if d.Evaluation.Status == "running" {
		e.activateEvaluationLocked(d, keys)
	}
}
func (e *Engine) evaluationWorker(a *activeEvaluation) {
	defer e.wg.Done()
	for {
		e.mu.Lock()
		if e.activeEvaluation != a || a.stopped || e.fatal != nil || a.next >= len(a.detail.Outcomes) {
			e.mu.Unlock()
			return
		}
		idx := a.next
		a.next++
		entry := a.detail.Outcomes[idx]
		entry.Outcome.Status = "running"
		entry.Outcome.StartedAt = now()
		a.detail.Outcomes[idx] = entry
		a.detail.Evaluation.InFlight++
		if err := e.store.updateEvaluation(a.detail, false, entry); err != nil {
			e.fatal = err
			e.mu.Unlock()
			return
		}
		source := a.sources[entry.ResultID]
		f := a.metrics[entry.MetricID]
		timeout := a.detail.Snapshot.TimeoutSeconds
		e.mu.Unlock()
		input := MetricInput{Case: source.Case, Output: source.Result.Output, Group: MetricGroup{ID: source.Result.GroupID, Name: source.Result.GroupName, Model: source.Result.Model}, Iteration: source.Result.Iteration, LanguageResolution: source.Request.LanguageResolution}
		prepared, err := prepareMetricInput(input, f.Target)
		var outcome MetricOutcome
		if err != nil {
			outcome = MetricOutcome{Status: "error", Error: err.Error(), FinishedAt: now()}
		} else if f.Metric.Kind == "code" {
			outcome = runCodeMetric(f.Metric, prepared)
		} else {
			outcome = e.callModelMetric(f, prepared, a.keys[f.Provider.CredentialRef], timeout)
		}
		outcome.MetricID = entry.MetricID
		if outcome.StartedAt == "" {
			outcome.StartedAt = entry.Outcome.StartedAt
		}
		if outcome.FinishedAt == "" {
			outcome.FinishedAt = now()
		}
		raw, _ := json.Marshal(outcome)
		raw = redactBody(raw, e.store.sensitiveValues())
		var clean MetricOutcome
		if decodeStored(raw, &clean) == nil {
			outcome = clean
		}
		e.mu.Lock()
		entry.Outcome = outcome
		a.detail.Outcomes[idx] = entry
		a.detail.Evaluation.InFlight--
		if outcome.Status == "completed" {
			a.detail.Evaluation.Completed++
		} else {
			a.detail.Evaluation.Failed++
		}
		e.finishEvaluationLocked(a)
		if err = e.store.updateEvaluation(a.detail, false, entry); err != nil {
			e.fatal = err
		}
		e.mu.Unlock()
	}
}
func (e *Engine) finishEvaluationLocked(a *activeEvaluation) {
	b := &a.detail.Evaluation
	if b.Completed+b.Failed+b.Cancelled == b.Total && b.InFlight == 0 {
		b.FinishedAt = now()
		switch {
		case a.stopped:
			b.Status = "stopped"
		case b.Failed > 0:
			b.Status = "completed_with_errors"
		default:
			b.Status = "completed"
		}
		e.activeEvaluation = nil
	}
}
func (e *Engine) stopEvaluation(id string) (Evaluation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	a := e.activeEvaluation
	if a == nil || a.detail.Evaluation.ID != id {
		d, err := e.store.evaluationDetail(id)
		if err != nil {
			return Evaluation{}, err
		}
		if d.Evaluation.Status == "queued" {
			d.Evaluation.Status = "stopped"
			d.Evaluation.Error = "stopped before source generation completed"
			d.Evaluation.FinishedAt = now()
			if err = e.store.updateEvaluation(d, false); err != nil {
				return Evaluation{}, err
			}
		}
		return d.Evaluation, nil
	}
	a.stopped = true
	a.detail.Evaluation.Status = "stopping"
	changed := []EvaluationOutcome{}
	for i := a.next; i < len(a.detail.Outcomes); i++ {
		o := &a.detail.Outcomes[i].Outcome
		o.Status = "cancelled"
		o.Error = "stopped before dispatch"
		o.FinishedAt = now()
		a.detail.Evaluation.Cancelled++
		changed = append(changed, a.detail.Outcomes[i])
	}
	a.next = len(a.detail.Outcomes)
	e.finishEvaluationLocked(a)
	if err := e.store.updateEvaluation(a.detail, false, changed...); err != nil {
		e.fatal = err
		return Evaluation{}, err
	}
	return a.detail.Evaluation, nil
}
func (e *Engine) replayEvaluation(id string) (Evaluation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active != nil || e.activeEvaluation != nil {
		return Evaluation{}, errActive
	}
	if e.closing {
		return Evaluation{}, errors.New("server is shutting down")
	}
	if e.fatal != nil {
		return Evaluation{}, e.fatal
	}
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	old, err := e.store.evaluationDetail(id)
	if err != nil {
		return Evaluation{}, err
	}
	if old.Evaluation.Status == "queued" || old.Evaluation.Status == "running" || old.Evaluation.Status == "stopping" {
		return Evaluation{}, errActive
	}
	if len(old.Snapshot.Results) == 0 {
		return Evaluation{}, evaluationInputError{errors.New("execution has no frozen successful source outputs")}
	}
	d := newEvaluation(old.Evaluation.Name+" · replay", old.Evaluation.GenerationRunID, id, FrozenEvaluationConfig{Metrics: old.Snapshot.Metrics, Concurrency: old.Evaluation.Concurrency}, old.Snapshot.TimeoutSeconds)
	if err = populateEvaluation(&d, old.Snapshot.Results); err != nil {
		return Evaluation{}, err
	}
	keys, err := e.evaluationKeys(d.Snapshot.Metrics)
	if err != nil {
		return Evaluation{}, err
	}
	d.Snapshot = redactEvaluationSnapshot(d.Snapshot, e.store.sensitiveValues())
	d.Evaluation.Status = "running"
	if err = e.store.createEvaluation(d); err != nil {
		return Evaluation{}, err
	}
	e.activateEvaluationLocked(d, keys)
	return d.Evaluation, nil
}
