package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// EvaluationConfig is the write contract: every source output is judged once
// per selected metric. There is no evaluation repetition request.
type EvaluationConfig struct {
	Metrics     []MetricSelection `json:"metrics"`
	Concurrency int               `json:"concurrency"`
}
type FrozenEvaluationConfig struct {
	Metrics     []FrozenMetric `json:"metrics"`
	Concurrency int            `json:"concurrency"`
}
type EvaluationInput struct {
	StateVersion    int64    `json:"state_version"`
	Name            string   `json:"name"`
	GenerationRunID string   `json:"generation_run_id"`
	ResultIDs       []string `json:"result_ids"`
	EvaluationConfig
}
type Evaluation struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	GenerationRunID string `json:"generation_run_id"`
	Status          string `json:"status"`
	Total           int    `json:"total"`
	Completed       int    `json:"completed"`
	Failed          int    `json:"failed"`
	Cancelled       int    `json:"cancelled"`
	Interrupted     int    `json:"interrupted"`
	InFlight        int    `json:"in_flight"`
	Concurrency     int    `json:"concurrency"`
	// Repeats is historical read-only evidence. New evaluations leave it zero;
	// schema2 rows written before the single-pass contract keep their value.
	Repeats    int    `json:"repeats,omitempty"`
	CreatedAt  string `json:"created_at"`
	FinishedAt string `json:"finished_at"`
	ReplayOf   string `json:"replay_of"`
	Error      string `json:"error,omitempty"`
}
type EvaluationSource struct {
	Result  Result        `json:"result"`
	Case    SnapshotCase  `json:"case"`
	Request FrozenRequest `json:"request"`
}
type EvaluationSnapshot struct {
	GenerationRunID string             `json:"generation_run_id"`
	Results         []EvaluationSource `json:"results"`
	Metrics         []FrozenMetric     `json:"metrics"`
	TimeoutSeconds  int                `json:"timeout_seconds"`
	// Repeats is historical read-only evidence; new snapshots omit it.
	Repeats int `json:"repeats,omitempty"`
}
type EvaluationOutcome struct {
	ResultID string `json:"result_id"`
	MetricID string `json:"metric_id"`
	// Round exists for the schema2 outcome key and old multi-round history. New
	// single-pass outcomes are always round 1; no new rounds are created.
	Round   int           `json:"round"`
	Outcome MetricOutcome `json:"outcome"`
}
type EvaluationDetail struct {
	Evaluation Evaluation          `json:"evaluation"`
	Snapshot   EvaluationSnapshot  `json:"snapshot"`
	Outcomes   []EvaluationOutcome `json:"outcomes"`
	Summary    []MetricSummary     `json:"summary"`
}

func freezeEvaluationConfig(s State, in EvaluationConfig) (FrozenEvaluationConfig, error) {
	if in.Concurrency < 1 || in.Concurrency > 20 {
		return FrozenEvaluationConfig{}, errors.New("concurrency must be 1–20")
	}
	metrics, err := freezeMetrics(s, in.Metrics)
	if err != nil {
		return FrozenEvaluationConfig{}, err
	}
	if len(metrics) == 0 {
		return FrozenEvaluationConfig{}, errors.New("select at least one metric")
	}
	return FrozenEvaluationConfig{Metrics: metrics, Concurrency: in.Concurrency}, nil
}
func evaluationSources(d Detail, ids []string) ([]EvaluationSource, error) {
	if d.Batch.Status == "running" || d.Batch.Status == "stopping" {
		return nil, evaluationInputError{errors.New("source generation must be terminal")}
	}
	selected := map[string]bool{}
	for _, id := range ids {
		if selected[id] {
			return nil, evaluationInputError{errors.New("duplicate result id")}
		}
		selected[id] = true
	}
	cases := map[string]SnapshotCase{}
	for _, c := range d.Snapshot.Cases {
		cases[c.ID] = c
	}
	requests := map[[2]string]FrozenRequest{}
	for _, r := range d.Snapshot.Requests {
		requests[[2]string{r.CaseID, r.GroupID}] = r
	}
	sources := []EvaluationSource{}
	for _, r := range d.Results {
		if len(ids) > 0 && !selected[r.ID] {
			continue
		}
		if r.Status != "completed" {
			if len(ids) > 0 {
				return nil, evaluationInputError{fmt.Errorf("result %s did not complete successfully", r.ID)}
			}
			continue
		}
		c, ok := cases[r.CaseID]
		if !ok {
			return nil, fmt.Errorf("result %s frozen Case missing", r.ID)
		}
		request, ok := requests[[2]string{r.CaseID, r.GroupID}]
		if !ok {
			return nil, fmt.Errorf("result %s frozen request missing", r.ID)
		}
		// The source retains immutable metric context and output, not duplicate wire
		// payloads or legacy inline judgments. The generation remains their owner.
		r.Evaluations = nil
		r.Request = nil
		r.RawRequest = ""
		r.RawResponse = ""
		r.RawResponseBase64 = ""
		sources = append(sources, EvaluationSource{r, c, request})
		delete(selected, r.ID)
	}
	if len(selected) > 0 {
		return nil, evaluationInputError{errors.New("result id not found in source generation")}
	}
	if len(sources) == 0 {
		return nil, evaluationInputError{errors.New("source generation has no successful outputs")}
	}
	return sources, nil
}
func newEvaluation(name, source, replay string, config FrozenEvaluationConfig, timeout int) EvaluationDetail {
	if strings.TrimSpace(name) == "" {
		name = "Evaluation"
	}
	return EvaluationDetail{Evaluation: Evaluation{ID: newID(), Name: name, GenerationRunID: source, Status: "queued", Concurrency: config.Concurrency, CreatedAt: now(), ReplayOf: replay}, Snapshot: EvaluationSnapshot{GenerationRunID: source, Results: []EvaluationSource{}, Metrics: config.Metrics, TimeoutSeconds: timeout}, Outcomes: []EvaluationOutcome{}, Summary: []MetricSummary{}}
}
func populateEvaluation(d *EvaluationDetail, sources []EvaluationSource) error {
	n, m := len(sources), len(d.Snapshot.Metrics)
	if n == 0 || m == 0 || n > 100000/m {
		return errors.New("evaluation must contain 1–100000 judgments")
	}
	d.Snapshot.Results = sources
	d.Evaluation.Total = n * m
	d.Outcomes = make([]EvaluationOutcome, 0, d.Evaluation.Total)
	for _, source := range sources {
		for _, metric := range d.Snapshot.Metrics {
			d.Outcomes = append(d.Outcomes, EvaluationOutcome{source.Result.ID, metric.Metric.ID, 1, MetricOutcome{MetricID: metric.Metric.ID, Status: "pending"}})
		}
	}
	return nil
}
func evaluationDetailSummary(d EvaluationDetail) []MetricSummary {
	resultGroups := make(map[string]string, len(d.Snapshot.Results))
	groupIDs := []string{}
	seen := map[string]bool{}
	for _, source := range d.Snapshot.Results {
		group := source.Result.GroupID
		resultGroups[source.Result.ID] = group
		if group != "" && !seen[group] {
			seen[group] = true
			groupIDs = append(groupIDs, group)
		}
	}
	out, indexes := metricSummaryEntries(d.Snapshot.Metrics, groupIDs)
	for _, entry := range d.Outcomes {
		if idx, ok := indexes[[2]string{entry.MetricID, ""}]; ok {
			accumulateMetricOutcome(&out[idx], entry.Outcome)
		}
		if group := resultGroups[entry.ResultID]; group != "" {
			if idx, ok := indexes[[2]string{entry.MetricID, group}]; ok {
				accumulateMetricOutcome(&out[idx], entry.Outcome)
			}
		}
	}
	return out
}
func redactEvaluationSnapshot(s EvaluationSnapshot, keys map[string]string) EvaluationSnapshot {
	raw, _ := json.Marshal(s)
	raw = redactBody(raw, keys)
	var clean EvaluationSnapshot
	if decodeStored(raw, &clean) == nil {
		return clean
	}
	return s
}
