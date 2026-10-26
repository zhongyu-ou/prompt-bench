package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestIndependentEvaluationFrozenInputsSubsetAndLimits(t *testing.T) {
	var generation, envReads atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { generation.Add(1); generatedJSON(w, `{"en":"Hello"}`) }))
	defer p.Close()
	h := newHarness(t, func(name string) string {
		if name == "SYNTHETIC_JEV_KEY" {
			envReads.Add(1)
		}
		return ""
	})
	s := metricFixture(p.URL)
	s.Draft.Groups[0].Runs = 100
	s.Metrics[0].ReturnType = "number"
	s.Metrics[0].Code = `function evaluate(i){if(i.case.variables.CurrentText!=="alpha")throw Error("Case changed");return {value:i.iteration}}`
	s = h.save(s)
	envReads.Store(0)
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 20), 202, &b)
	source := h.wait(b.ID)
	if envReads.Load() != 0 || generation.Load() != 100 {
		t.Fatal("generation inspected decision credentials or calls drifted")
	}
	h.api("PUT", "/api/cases/a", map[string]any{"state_version": s.Version, "variable_patch": map[string]any{"CurrentText": "modified later"}}, 200, &s)
	in := EvaluationInput{StateVersion: s.Version, GenerationRunID: b.ID, EvaluationConfig: EvaluationConfig{Metrics: []MetricSelection{{MetricID: "han", Target: MetricTarget{Mode: "output"}}}, Concurrency: 20}}
	var item Evaluation
	h.api("POST", "/api/evaluations", in, 202, &item)
	d := h.waitEvaluation(item.ID)
	if d.Evaluation.Total != 100 || d.Evaluation.Completed != 100 || generation.Load() != 100 {
		t.Fatalf("100 outputs x 1 judgment: %+v calls=%d", d.Evaluation, generation.Load())
	}
	if d.Evaluation.Repeats != 0 || d.Snapshot.Repeats != 0 {
		t.Fatalf("new evaluation exposed repetition: %+v %+v", d.Evaluation, d.Snapshot)
	}
	if len(d.Summary) != 2 || d.Summary[0].Mean == nil || math.Abs(*d.Summary[0].Mean-50.5) > 1e-10 {
		t.Fatal(d.Summary)
	}
	for _, outcome := range d.Outcomes {
		if outcome.Round != 1 {
			t.Fatal(outcome)
		}
	}
	in.ResultIDs = []string{source.Results[1].ID}
	h.api("POST", "/api/evaluations", in, 202, &item)
	subset := h.waitEvaluation(item.ID)
	if subset.Evaluation.Completed != 1 || len(subset.Snapshot.Results) != 1 {
		t.Fatal(subset)
	}
	for _, o := range subset.Outcomes {
		if o.Outcome.Value != json.Number("2") {
			t.Fatalf("evaluation round replaced generation iteration: %+v", o)
		}
	}
	if len(subset.Snapshot.Results[0].Result.Evaluations) != 0 || subset.Snapshot.Results[0].Result.RawResponse != "" {
		t.Fatal("legacy wire/outcomes duplicated into eval snapshot")
	}
	in.ResultIDs = []string{"missing"}
	h.api("POST", "/api/evaluations", in, 400, nil)
	in.ResultIDs = []string{source.Results[0].ID, source.Results[0].ID}
	h.api("POST", "/api/evaluations", in, 400, nil)
	in.ResultIDs = nil
	// Obsolete repetition requests are rejected rather than silently ignored.
	repeats := map[string]any{"state_version": s.Version, "generation_run_id": b.ID, "metrics": in.Metrics, "concurrency": 1, "repeats": 1}
	h.api("POST", "/api/evaluations", repeats, 400, nil)
	h.api("POST", "/api/runs", map[string]any{"state_version": s.Version, "after_generation_evaluation": map[string]any{"metrics": in.Metrics, "concurrency": 1}}, 400, nil)
	// Planned outcomes beyond 100000 are rejected before any generation/decision call.
	for i := range 999 {
		s.Metrics = append(s.Metrics, Metric{ID: fmt.Sprintf("extra-%d", i), Name: "Extra", Kind: "code", ReturnType: "boolean", Rule: "extra", Code: `function evaluate(){return {value:true}}`})
	}
	s = h.save(s)
	selections := make([]MetricSelection, 0, len(s.Metrics))
	for _, m := range s.Metrics {
		selections = append(selections, MetricSelection{MetricID: m.ID, Target: MetricTarget{Mode: "output"}})
	}
	in.StateVersion = s.Version
	in.Metrics = selections
	h.api("POST", "/api/evaluations", in, 400, nil)
	s.Draft.Groups[0].Runs = 100
	oversized := runInput(s, 1)
	oversized.Metrics = selections
	h.api("POST", "/api/runs", oversized, 400, nil)
	if generation.Load() != 100 {
		t.Fatal("oversized evaluation/execution sent calls")
	}
	in.Metrics = []MetricSelection{{MetricID: "han", Target: MetricTarget{Mode: "output"}}}
	in.StateVersion--
	h.api("POST", "/api/evaluations", in, 409, nil)
}
func TestEvaluationRejectsFailedSourceAndQueuedStop(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		w.WriteHeader(500)
	}))
	defer p.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	h := newHarness(t, nil)
	s := metricFixture(p.URL)
	s.Draft.Metrics = s.Draft.Metrics[:1]
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", selectedRun(s, 1), 202, &b)
	<-entered
	var queued EvaluationDetail
	h.api("GET", "/api/evaluations/"+b.EvaluationExecutionID, nil, 200, &queued)
	if queued.Evaluation.Status != "queued" {
		t.Fatal(queued)
	}
	h.api("POST", "/api/evaluations/"+b.EvaluationExecutionID+"/stop", map[string]any{}, 200, nil)
	close(release)
	source := h.wait(b.ID)
	stopped := h.waitEvaluation(b.EvaluationExecutionID)
	if stopped.Evaluation.Status != "stopped" {
		t.Fatal(stopped)
	}
	in := EvaluationInput{StateVersion: s.Version, GenerationRunID: b.ID, ResultIDs: []string{source.Results[0].ID}, EvaluationConfig: EvaluationConfig{Metrics: s.Draft.Metrics, Concurrency: 1}}
	raw := h.api("POST", "/api/evaluations", in, 400, nil)
	if !strings.Contains(string(raw), "did not complete successfully") {
		t.Fatal(string(raw))
	}
	if calls.Load() != 1 {
		t.Fatal("failed output regenerated")
	}
}
func TestEvaluationRestartInterruptsQueuedAndRunningWithoutRewritingEvidence(t *testing.T) {
	target := newTestStoreTarget(t)
	store := target.open(t)
	metric := FrozenMetric{Metric: Metric{ID: "m", Name: "M", Kind: "code", ReturnType: "boolean", Code: `function evaluate(){return {value:true}}`}, Target: MetricTarget{Mode: "output"}}
	source := Detail{Batch: Batch{ID: "generation", Name: "Generation", Status: "completed", CreatedAt: now(), Total: 1, Completed: 1, EvaluationExecutionID: "queued"}, Snapshot: Snapshot{Cases: []SnapshotCase{{ID: "a", Variables: map[string]any{"CurrentText": "original"}}}, Requests: []FrozenRequest{{CaseID: "a", GroupID: "g", RawRequest: `{"frozen":true}`}}, Evaluation: &FrozenEvaluationConfig{Metrics: []FrozenMetric{metric}, Concurrency: 1}}, Results: []Result{{ID: "result", CaseID: "a", GroupID: "g", Iteration: 8, Status: "completed", Output: "old output", Evaluations: []MetricOutcome{{MetricID: "legacy", Status: "completed", Value: true}}}}}
	if err := store.create(source); err != nil {
		t.Fatal(err)
	}
	sources, err := evaluationSources(source, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a historical multi-round evaluation that a schema2 database may
	// still be running while the binary now only creates single-pass records.
	running := newEvaluation("Running", source.Batch.ID, "", FrozenEvaluationConfig{Metrics: []FrozenMetric{metric}, Concurrency: 1}, 3)
	running.Snapshot.Results = sources
	running.Evaluation.Total = 3
	running.Outcomes = []EvaluationOutcome{{ResultID: "result", MetricID: "m", Round: 1, Outcome: MetricOutcome{MetricID: "m", Status: "pending"}}, {ResultID: "result", MetricID: "m", Round: 2, Outcome: MetricOutcome{MetricID: "m", Status: "pending"}}, {ResultID: "result", MetricID: "m", Round: 3, Outcome: MetricOutcome{MetricID: "m", Status: "pending"}}}
	running.Evaluation.Status = "running"
	running.Evaluation.Completed = 1
	running.Evaluation.InFlight = 1
	running.Outcomes[0].Outcome.Status = "completed"
	running.Outcomes[0].Outcome.Value = true
	running.Outcomes[1].Outcome.Status = "running"
	if err = store.createEvaluation(running); err != nil {
		t.Fatal(err)
	}
	var generationBefore, snapshotBefore, completedBefore []byte
	store.db.QueryRow("SELECT data FROM results WHERE id='result'").Scan(&generationBefore)
	store.db.QueryRow("SELECT snapshot FROM evaluations WHERE id=$1", running.Evaluation.ID).Scan(&snapshotBefore)
	store.db.QueryRow("SELECT data FROM evaluation_outcomes WHERE evaluation_id=$1 AND round=1", running.Evaluation.ID).Scan(&completedBefore)
	store.close()
	reopened, err := openStore(target.DSN, target.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	queued, err := reopened.evaluationDetail("queued")
	if err != nil || queued.Evaluation.Status != "interrupted" {
		t.Fatal(queued, err)
	}
	d, err := reopened.evaluationDetail(running.Evaluation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Evaluation.Status != "interrupted" || d.Evaluation.Interrupted != 2 || d.Evaluation.Completed != 1 || d.Evaluation.InFlight != 0 {
		t.Fatal(d)
	}
	var generationAfter, snapshotAfter, completedAfter []byte
	reopened.db.QueryRow("SELECT data FROM results WHERE id='result'").Scan(&generationAfter)
	reopened.db.QueryRow("SELECT snapshot FROM evaluations WHERE id=$1", running.Evaluation.ID).Scan(&snapshotAfter)
	reopened.db.QueryRow("SELECT data FROM evaluation_outcomes WHERE evaluation_id=$1 AND round=1", running.Evaluation.ID).Scan(&completedAfter)
	if !bytes.Equal(generationBefore, generationAfter) || !bytes.Equal(snapshotBefore, snapshotAfter) || !bytes.Equal(completedBefore, completedAfter) {
		t.Fatal("restart rewrote immutable evidence")
	}
}
func TestEvaluationReplayOfHistoricalRoundsCreatesOnePass(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.store.create(Detail{Batch: Batch{ID: "generation", Name: "Generation", Status: "completed", CreatedAt: now(), Total: 1, Completed: 1, Concurrency: 1}, Results: []Result{{ID: "result", CaseID: "a", GroupID: "g", Iteration: 3, Status: "completed", Output: "x"}}}); err != nil {
		t.Fatal(err)
	}
	metric := FrozenMetric{Metric: Metric{ID: "m", Name: "M", Kind: "code", ReturnType: "boolean", Code: `function evaluate(){return {value:true}}`}, Target: MetricTarget{Mode: "output"}}
	old := newEvaluation("Old multi-round", "generation", "", FrozenEvaluationConfig{Metrics: []FrozenMetric{metric}, Concurrency: 1}, 5)
	old.Evaluation.Status = "completed"
	old.Evaluation.Repeats = 4
	old.Evaluation.Total = 4
	old.Evaluation.Completed = 4
	old.Snapshot.Repeats = 4
	old.Snapshot.Results = []EvaluationSource{{Result: Result{ID: "result", CaseID: "a", GroupID: "g", Iteration: 3, Status: "completed", Output: "x"}, Case: SnapshotCase{ID: "a", Variables: map[string]any{}}, Request: FrozenRequest{CaseID: "a", GroupID: "g"}}}
	for round := 1; round <= 4; round++ {
		old.Outcomes = append(old.Outcomes, EvaluationOutcome{ResultID: "result", MetricID: "m", Round: round, Outcome: MetricOutcome{MetricID: "m", Status: "completed", Value: true}})
	}
	old.Snapshot = redactEvaluationSnapshot(old.Snapshot, nil)
	if err := h.store.createEvaluation(old); err != nil {
		t.Fatal(err)
	}
	var snapshotBefore []byte
	h.store.db.QueryRow("SELECT snapshot FROM evaluations WHERE id=$1", old.Evaluation.ID).Scan(&snapshotBefore)
	var replay Evaluation
	h.api("POST", "/api/evaluations/"+old.Evaluation.ID+"/replay", map[string]any{}, 202, &replay)
	replayed := h.waitEvaluation(replay.ID)
	if replayed.Evaluation.Total != 1 || replayed.Evaluation.Completed != 1 || len(replayed.Outcomes) != 1 || replayed.Outcomes[0].Round != 1 {
		t.Fatalf("historical rounds were repeated: %+v", replayed)
	}
	original := h.api("GET", "/api/evaluations/"+old.Evaluation.ID, nil, 200, nil)
	if !bytes.Contains(original, []byte(`"repeats":4`)) || !bytes.Contains(original, []byte(`"round":4`)) {
		t.Fatalf("historical evidence lost: %s", original)
	}
	var snapshotAfter []byte
	h.store.db.QueryRow("SELECT snapshot FROM evaluations WHERE id=$1", old.Evaluation.ID).Scan(&snapshotAfter)
	var outcomes int
	h.store.db.QueryRow("SELECT count(*) FROM evaluation_outcomes WHERE evaluation_id=$1", old.Evaluation.ID).Scan(&outcomes)
	if !bytes.Equal(snapshotBefore, snapshotAfter) || outcomes != 4 {
		t.Fatal("replay mutated historical multi-round evidence")
	}
}
func TestLegacyGenerationSnapshotMetadataReadOnlyAndNeverReplayed(t *testing.T) {
	var generation atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { generation.Add(1); success(w) }))
	defer p.Close()
	h := newHarness(t, nil)
	s := h.save(metricFixture(p.URL))
	snap, err := freeze(s, runInput(s, 1))
	if err != nil {
		t.Fatal(err)
	}
	legacy := json.RawMessage(`{"metrics":[{"metric":{"id":"han","name":"Legacy","kind":"code","return_type":"boolean","code":"function evaluate(){return {value:true}}"},"target":{"mode":"output"}}],"repeats":7,"concurrency":3}`)
	snap.LegacyAfterGenerationEvaluation = legacy
	d := Detail{Batch: Batch{ID: "legacy-batch", Name: "Legacy", Status: "completed", CreatedAt: now(), Concurrency: 1}, Snapshot: snap, Results: []Result{}}
	if err := h.store.create(d); err != nil {
		t.Fatal(err)
	}
	raw := h.api("GET", "/api/runs/legacy-batch", nil, 200, nil)
	if !bytes.Contains(raw, append([]byte(`"after_generation_evaluation":`), legacy...)) {
		t.Fatalf("legacy snapshot metadata was not preserved exactly: %s", raw)
	}
	if bytes.Contains(raw, []byte(`"evaluation":{"metrics"`)) {
		t.Fatal("legacy snapshot gained a new chained evaluation config")
	}
	var replay Batch
	h.api("POST", "/api/runs/legacy-batch/replay", map[string]any{}, 202, &replay)
	h.wait(replay.ID)
	if generation.Load() != 1 || replay.EvaluationExecutionID != "" {
		t.Fatalf("legacy shortcut executed during replay: gen%d %+v", generation.Load(), replay)
	}
	var replayed Detail
	h.api("GET", "/api/runs/"+replay.ID, nil, 200, &replayed)
	if replayed.Snapshot.Evaluation != nil || replayed.Snapshot.LegacyAfterGenerationEvaluation != nil {
		t.Fatal("generation replay carried chain configuration")
	}
	original := h.api("GET", "/api/runs/legacy-batch", nil, 200, nil)
	if !bytes.Contains(original, append([]byte(`"after_generation_evaluation":`), legacy...)) {
		t.Fatal("replay rewrote original frozen metadata")
	}
}
func TestSchemaOneForwardMigrationPreservesRawHistory(t *testing.T) {
	target := newTestStoreTarget(t)
	store := target.open(t)
	summary := []byte(`{ "id":"legacy", "status":"completed", "created_at":"old", "completed":1, "total":1 }`)
	snapshot := []byte(`{ "cases":[{"id":"a","variables":{"huge":9007199254740993}}],"metrics":[{"metric":{"id":"old"},"target":{"mode":"output"}}] }`)
	result := []byte(`{ "id":"legacy-result", "case_id":"a", "group_id":"g", "iteration":1, "status":"completed", "output":"old output", "evaluations":[{"metric_id":"old","status":"completed","value":true}] }`)
	if _, err := store.db.Exec("INSERT INTO batches(id,created_at,summary,snapshot) VALUES('legacy','old',$1,$2)", summary, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO results(id,batch_id,seq,group_id,case_id,iteration,data) VALUES('legacy-result','legacy',0,'g','a',1,$1)", result); err != nil {
		t.Fatal(err)
	}
	var stateBefore []byte
	store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&stateBefore)
	if _, err := store.db.Exec("DROP TABLE evaluation_outcomes; DROP TABLE evaluations; UPDATE schema_version SET version=1 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	store.close()
	reopened, err := openStore(target.DSN, target.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	var gotSummary, gotSnapshot, gotResult, gotState []byte
	var version int
	reopened.db.QueryRow("SELECT summary,snapshot FROM batches WHERE id='legacy'").Scan(&gotSummary, &gotSnapshot)
	reopened.db.QueryRow("SELECT data FROM results WHERE id='legacy-result'").Scan(&gotResult)
	reopened.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&gotState)
	reopened.db.QueryRow("SELECT version FROM schema_version WHERE id=1").Scan(&version)
	if version != 2 || !bytes.Equal(summary, gotSummary) || !bytes.Equal(snapshot, gotSnapshot) || !bytes.Equal(result, gotResult) || !bytes.Equal(stateBefore, gotState) {
		t.Fatal("schema 1 forward migration modified historical BYTEA")
	}
}

func TestEvaluationAPIInternalFailuresAreNotValidationErrors(t *testing.T) {
	h := newHarness(t, nil)
	h.api("GET", "/api/evaluations/missing", nil, 404, nil)
	// Malformed durable evidence is a server/storage problem, not bad user input.
	source := Detail{Batch: Batch{ID: "source", CreatedAt: now(), Status: "completed"}}
	if err := h.store.create(source); err != nil {
		t.Fatal(err)
	}
	bad := newEvaluation("Corrupt", "source", "", FrozenEvaluationConfig{}, 1)
	if err := h.store.createEvaluation(bad); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec("UPDATE evaluations SET snapshot=$1 WHERE id=$2", []byte("{"), bad.Evaluation.ID); err != nil {
		t.Fatal(err)
	}
	h.api("GET", "/api/evaluations/"+bad.Evaluation.ID, nil, 500, nil)
	h.api("GET", "/api/evaluations/"+bad.Evaluation.ID+"/export", nil, 500, nil)
	h.engine.mu.Lock()
	h.engine.fatal = errCredentialUnavailable
	h.engine.mu.Unlock()
	h.api("POST", "/api/evaluations", EvaluationInput{}, 500, nil)
	h.engine.mu.Lock()
	h.engine.fatal = nil
	h.engine.mu.Unlock()
	h.store.close()
	h.api("GET", "/api/evaluations/"+bad.Evaluation.ID, nil, 500, nil)
	h.api("POST", "/api/evaluations", EvaluationInput{}, 500, nil)
}
