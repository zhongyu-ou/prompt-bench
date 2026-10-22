package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func metricFixture(base string) State {
	s := fixtureState(base)
	s.Draft.CaseIDs = []string{"a"}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s.Providers = append(s.Providers, Provider{ID: "jev", Name: "Decision", Protocol: typesafeProtocol, BaseURL: base + "/v1", APIKeyEnv: "SYNTHETIC_JEV_KEY"})
	s.Metrics = []Metric{{ID: "han", Name: "Chinese characters", Kind: "code", ReturnType: "boolean", Rule: "Detect Chinese characters in selected target", Code: `function evaluate(input){return {value:/[\u4e00-\u9fff]/u.test(input.target),reason:"character presence"}}`}, {ID: "judge", Name: "Meaning", Kind: "model", ReturnType: "boolean", ProviderID: "jev", Model: "jev-fixture", Rule: "Is the target a greeting?"}}
	s.Draft.Metrics = []MetricSelection{{MetricID: "han", Target: MetricTarget{Mode: "json_pointer", Pointer: "/en"}}, {MetricID: "judge", Target: MetricTarget{Mode: "json_pointer", Pointer: "/en"}}}
	return s
}
func selectedRun(s State, c int) RunInput {
	in := runInput(s, c)
	in.Metrics = s.Draft.Metrics
	return in
}
func generatedJSON(w http.ResponseWriter, output string) {
	json.NewEncoder(w).Encode(map[string]any{"model": "generation-fixture", "choices": []any{map[string]any{"message": map[string]string{"content": output}}}})
}
func TestEvaluationSnapshotPartialFailureReplayAndSecrets(t *testing.T) {
	var generation, decision atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "systemone") {
			decision.Add(1)
			w.WriteHeader(503)
			fmt.Fprint(w, `{"error":"synthetic-secret"}`)
			return
		}
		generation.Add(1)
		generatedJSON(w, `{"corrected_text":"中文原文","en":"Hello"}`)
	}))
	defer provider.Close()
	h := newHarness(t, func(string) string { return "synthetic-secret" })
	s := h.save(metricFixture(provider.URL))
	var b Batch
	h.api("POST", "/api/runs", selectedRun(s, 2), 202, &b)
	d := h.wait(b.ID)
	if d.Batch.Completed != 1 || d.Batch.Failed != 0 || d.Batch.Status != "completed_with_errors" || d.Batch.Evaluation.Completed != 1 || d.Batch.Evaluation.Error != 1 || d.Batch.MaxModelCalls != 1 {
		t.Fatalf("independent progress: %+v", d.Batch)
	}
	if threshold := d.Snapshot.Metrics[1].Metric.Threshold; threshold == nil || *threshold != 0.5 {
		t.Fatal("effective default threshold was not frozen")
	}
	r := d.Results[0]
	if r.Status != "completed" || r.Evaluations[0].Status != "completed" || r.Evaluations[0].Value != false || r.Evaluations[1].Status != "error" || !strings.Contains(r.Evaluations[1].RawResponse, "[REDACTED]") {
		t.Fatalf("outcomes: %+v", r)
	}
	if len(d.EvaluationSummary) != 4 || d.EvaluationSummary[0].Valid != 1 || d.EvaluationSummary[0].FalseCount != 1 || d.EvaluationSummary[2].Error != 1 {
		t.Fatalf("summary: %+v", d.EvaluationSummary)
	}
	export := h.api("GET", "/api/runs/"+b.ID+"/export", nil, 200, nil)
	if bytes.Contains(export, []byte("synthetic-secret")) {
		t.Fatal("secret in export")
	}
	s.Metrics[0].Code = `function evaluate(){return {value:true}}`
	s.Draft.Metrics = nil
	s = h.save(s)
	var replay Batch
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 202, &replay)
	again := h.wait(replay.ID)
	if !reflect.DeepEqual(d.Snapshot, again.Snapshot) || again.Results[0].Evaluations[0].Value != false || generation.Load() != 2 || decision.Load() != 2 {
		t.Fatal("frozen replay changed or retried")
	}
	s.Metrics = []Metric{}
	s.Providers = []Provider{}
	s.Templates = []Template{}
	s.Draft.Metrics = []MetricSelection{}
	s.Draft.Groups = []Group{}
	h.save(s)
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 202, &replay)
	deletedSourcesReplay := h.wait(replay.ID)
	if !reflect.DeepEqual(d.Snapshot, deletedSourcesReplay.Snapshot) || deletedSourcesReplay.Results[0].Evaluations[0].Value != false || decision.Load() != 3 {
		t.Fatal("source deletion broke frozen metric/provider replay")
	}
	// State mutation never rewrites the old immutable snapshot or results.
	var original Detail
	h.api("GET", "/api/runs/"+b.ID, nil, 200, &original)
	if !reflect.DeepEqual(d, original) {
		t.Fatal("history changed after configuration edit/replay")
	}
}
func TestEvaluationPreflightAndProviderCapability(t *testing.T) {
	var calls atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); success(w) }))
	defer p.Close()
	h := newHarness(t, nil)
	s := h.save(metricFixture(p.URL))
	h.api("POST", "/api/runs", selectedRun(s, 1), 400, nil)
	if calls.Load() != 0 {
		t.Fatal("generation before decision credential preflight")
	}
	bad := s
	bad.Draft.Groups = append([]Group{}, s.Draft.Groups...)
	bad.Draft.Groups[0].ProviderID = "jev"
	h.api("PUT", "/api/state", bad, 400, nil)
	badRun := selectedRun(s, 1)
	badRun.Groups = bad.Draft.Groups
	h.api("POST", "/api/runs", badRun, 400, nil)
	// Generic state writes own metrics and use the existing optimistic version.
	var fields map[string]any
	raw, _ := json.Marshal(s)
	json.Unmarshal(raw, &fields)
	delete(fields, "metrics")
	draft := fields["draft"].(map[string]any)
	delete(draft, "metrics")
	var saved State
	h.api("PUT", "/api/state", fields, 200, &saved)
	if len(saved.Metrics) != 2 || len(saved.Draft.Metrics) != 2 {
		t.Fatal("omitted additive metrics were erased")
	}
	h.api("PUT", "/api/state", s, 409, nil)
	saved.Draft.Metrics = []MetricSelection{}
	saved.Metrics = []Metric{}
	h.api("PUT", "/api/state", saved, 200, &saved)
	if len(saved.Metrics) != 0 {
		t.Fatal("metric delete not applied")
	}
}
func TestMetricTrialPointerStrictnessAndSummary(t *testing.T) {
	h := newHarness(t, nil)
	m := Metric{ID: "trial", Name: "Trial", Kind: "code", ReturnType: "boolean", Code: `function evaluate(i){return {value: /[\u4e00-\u9fff]/u.test(i.target)}}`}
	trial := func(output, pointer string) MetricOutcome {
		var o MetricOutcome
		h.api("POST", "/api/metrics/trial", map[string]any{"metric": m, "target": MetricTarget{Mode: "json_pointer", Pointer: pointer}, "input": MetricInput{Output: output}}, 200, &o)
		return o
	}
	if o := trial(`{"corrected_text":"中文原文","en":"Hello"}`, "/en"); o.Status != "completed" || o.Value != false {
		t.Fatalf("target drift: %+v", o)
	}
	if o := trial(`{"en":"中"}`, "/en"); o.Value != true {
		t.Fatal(o)
	}
	for _, v := range []struct{ output, pointer string }{{"not json", "/en"}, {`{"jp":"Hello"}`, "/en"}, {`{"en":[]}`, "/en/0"}, {`{"en":[1]}`, "/en/01"}} {
		if o := trial(v.output, v.pointer); o.Status != "error" {
			t.Fatalf("target error missing: %+v", o)
		}
	}
	if v, e := metricTarget(`{"a/b":{"~key":[false]}}`, MetricTarget{Mode: "json_pointer", Pointer: "/a~1b/~0key/0"}); e != nil || v != false {
		t.Fatalf("RFC6901: %v %v", v, e)
	}
	if _, e := metricTarget(`{}`, MetricTarget{Mode: "json_pointer", Pointer: "/~2"}); e == nil {
		t.Fatal("invalid pointer escape accepted")
	}
	metrics := []FrozenMetric{{Metric: Metric{ID: "n"}}, {Metric: Metric{ID: "c", Labels: []MetricLabel{{Label: "yes"}, {Label: "no"}}}}}
	d := Detail{Snapshot: Snapshot{Metrics: metrics}, Results: []Result{{Evaluations: []MetricOutcome{{MetricID: "n", Status: "completed", Value: 2.0}, {MetricID: "c", Status: "completed", Value: "yes"}}}, {Evaluations: []MetricOutcome{{MetricID: "n", Status: "completed", Value: 4.0}, {MetricID: "c", Status: "error"}}}}}
	summaries := evaluationSummary(d)
	if *summaries[0].Mean != 3 || *summaries[0].Min != 2 || *summaries[0].Max != 4 || summaries[1].Labels["yes"] != 1 || summaries[1].Valid != 1 || summaries[1].Error != 1 {
		t.Fatalf("valid denominators: %+v", summaries)
	}
}
func TestEvaluationStopDuringInflightMetric(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var generations, decisions atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "systemone") {
			decisions.Add(1)
			entered <- struct{}{}
			<-release
			fmt.Fprint(w, `{"model":"fixture","answers":{"metric":{"type":"noul","noul":0.8}}}`)
			return
		}
		generations.Add(1)
		generatedJSON(w, `{"en":"Hello"}`)
	}))
	defer p.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	h := newHarness(t, func(string) string { return "synthetic-key" })
	s := metricFixture(p.URL)
	s.Draft.Groups[0].Runs = 3
	s.Metrics = append(s.Metrics, Metric{ID: "later", Name: "Later", Kind: "code", ReturnType: "boolean", Code: `function evaluate(){return {value:true}}`})
	s.Draft.Metrics = append(s.Draft.Metrics, MetricSelection{MetricID: "later", Target: MetricTarget{Mode: "output"}})
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", selectedRun(s, 1), 202, &b)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("metric did not dispatch")
	}
	var active Detail
	h.api("GET", "/api/runs/"+b.ID, nil, 200, &active)
	if active.Batch.Completed != 1 || active.Batch.Status != "running" || active.Batch.Evaluation.Running != 1 {
		t.Fatal(active.Batch)
	}
	var stop Batch
	h.api("POST", "/api/runs/"+b.ID+"/stop", map[string]any{}, 200, &stop)
	if stop.Status != "stopping" {
		t.Fatal(stop)
	}
	h.api("POST", "/api/runs", selectedRun(s, 1), 409, nil)
	close(release)
	d := h.wait(b.ID)
	if d.Batch.Status != "stopped" || d.Batch.Completed != 1 || d.Batch.Cancelled != 2 || d.Batch.Evaluation.Completed != 2 || d.Batch.Evaluation.Cancelled != 7 || generations.Load() != 1 || decisions.Load() != 1 {
		t.Fatalf("stop counts %+v gen%d decision%d", d.Batch, generations.Load(), decisions.Load())
	}
}
func TestEvaluationGenerationFailureAndMissingTarget(t *testing.T) {
	var decisions atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "systemone") {
			decisions.Add(1)
			t.Error("decision called without a valid target")
			return
		}
		if fail.Load() {
			w.WriteHeader(500)
			fmt.Fprint(w, `{"error":"generation failed"}`)
			return
		}
		generatedJSON(w, `{"jp":"Hello"}`)
	}))
	defer p.Close()
	h := newHarness(t, func(string) string { return "synthetic-key" })
	s := h.save(metricFixture(p.URL))
	var b Batch
	h.api("POST", "/api/runs", selectedRun(s, 2), 202, &b)
	d := h.wait(b.ID)
	if d.Batch.Failed != 1 || d.Batch.Evaluation.Skipped != 2 || d.Batch.Evaluation.Error != 0 || decisions.Load() != 0 {
		t.Fatalf("failed generation must skip metrics: %+v", d)
	}
	fail.Store(false)
	h.api("POST", "/api/runs", selectedRun(s, 2), 202, &b)
	d = h.wait(b.ID)
	if d.Batch.Completed != 1 || d.Batch.Evaluation.Error != 2 || d.Batch.Evaluation.Completed != 0 || decisions.Load() != 0 {
		t.Fatalf("missing field must not fall back or call model: %+v", d)
	}
}
func TestEvaluationRecoveryPreservesGenerationAndPriorHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "promptbench.sqlite")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	completed := Detail{Batch: Batch{ID: "old", CreatedAt: now(), Status: "completed", Total: 1, Completed: 1}, Results: []Result{{ID: "old-r", Status: "completed", Output: "historical raw", RawResponse: "preserved"}}}
	if err = s.create(completed); err != nil {
		t.Fatal(err)
	}
	var before []byte
	s.db.QueryRow("SELECT data FROM results WHERE id='old-r'").Scan(&before)
	interrupted := Detail{Batch: Batch{ID: "active", CreatedAt: now(), Status: "running", Total: 1, Completed: 1, Evaluation: EvaluationProgress{Total: 3, Completed: 1, Pending: 1, Running: 1}}, Results: []Result{{ID: "active-r", Status: "completed", Output: "durable generation", Evaluations: []MetricOutcome{{MetricID: "done", Status: "completed", Value: true}, {MetricID: "running", Status: "running"}, {MetricID: "pending", Status: "pending"}}}}}
	if err = s.create(interrupted); err != nil {
		t.Fatal(err)
	}
	s.close()
	s, err = openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	d, err := s.detail("active")
	if err != nil {
		t.Fatal(err)
	}
	if d.Batch.Status != "interrupted" || d.Batch.Completed != 1 || d.Batch.Interrupted != 0 || d.Batch.Evaluation.Interrupted != 2 || d.Batch.Evaluation.Running != 0 || d.Batch.Evaluation.Pending != 0 || d.Results[0].Status != "completed" || d.Results[0].Output != "durable generation" || d.Results[0].Evaluations[0].Status != "completed" {
		t.Fatalf("recovery lost independent state: %+v", d)
	}
	var after []byte
	s.db.QueryRow("SELECT data FROM results WHERE id='old-r'").Scan(&after)
	if !bytes.Equal(before, after) {
		t.Fatal("recovery rewrote completed historical result")
	}
}
func TestMixedGenerationDecisionGlobalConcurrency(t *testing.T) {
	var active, peak, gen, judge atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		if strings.HasSuffix(r.URL.Path, "systemone") {
			judge.Add(1)
			fmt.Fprint(w, `{"model":"fixture","answers":{"metric":{"type":"noul","noul":0.8}}}`)
		} else {
			gen.Add(1)
			generatedJSON(w, `{"en":"Hello"}`)
		}
	}))
	defer p.Close()
	h := newHarness(t, func(string) string { return "synthetic-key" })
	s := metricFixture(p.URL)
	s.Draft.Groups[0].Runs = 60
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", selectedRun(s, 20), 202, &b)
	d := h.wait(b.ID)
	if peak.Load() > 20 || peak.Load() < 2 || gen.Load() != 60 || judge.Load() != 60 || d.Batch.Evaluation.Completed != 120 {
		t.Fatalf("global cap peak%d gen%d decision%d batch%+v", peak.Load(), gen.Load(), judge.Load(), d.Batch)
	}
}

func TestNumericMetricSummaryStaysFinite(t *testing.T) {
	for _, values := range [][]float64{{math.MaxFloat64, math.MaxFloat64}, {math.MaxFloat64, -math.MaxFloat64}, {-math.MaxFloat64, -math.MaxFloat64}} {
		d := Detail{Snapshot: Snapshot{Metrics: []FrozenMetric{{Metric: Metric{ID: "n"}}}}}
		for _, value := range values {
			d.Results = append(d.Results, Result{Evaluations: []MetricOutcome{{MetricID: "n", Status: "completed", Value: value}}})
		}
		summary := evaluationSummary(d)[0]
		if summary.Mean == nil || math.IsInf(*summary.Mean, 0) || math.IsNaN(*summary.Mean) {
			t.Fatalf("finite values overflowed summary: %+v", summary)
		}
		if _, err := json.Marshal(summary); err != nil {
			t.Fatal(err)
		}
	}
}
