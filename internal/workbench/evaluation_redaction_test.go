package workbench

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestEvaluationRedactionCredentialIdentityCollision(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		generatedJSON(w, "ordinary output")
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := metricFixture(provider.URL)
	s.Cases[0].ID = "judge"
	s.Cases[0].Variables["evidence"] = map[string]any{"judge": []any{"judge", json.Number("9007199254740993")}}
	s.Draft.CaseIDs = []string{"judge"}
	s.Draft.Groups[0].ID = "judge"
	s.Metrics = []Metric{{ID: "judge", Name: "Code", Kind: "code", ReturnType: "boolean", Code: `function evaluate(i){return {value:true,reason:i.group.id}}`}}
	s.Draft.Metrics = nil
	s = h.save(s)
	s = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "judge"}}, 200).State
	var batch Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &batch)
	generation := h.wait(batch.ID)
	in := EvaluationInput{StateVersion: s.Version, GenerationRunID: batch.ID, EvaluationConfig: EvaluationConfig{Metrics: []MetricSelection{{MetricID: "judge", Target: MetricTarget{Mode: "output"}}}, Concurrency: 1}}
	var execution Evaluation
	h.api("POST", "/api/evaluations", in, 202, &execution)
	detail := h.waitEvaluation(execution.ID)
	assertEvaluationRedactionCompleted(t, detail, generation.Results[0].ID, "judge", "judge")
	if detail.Outcomes[0].Outcome.Reason != "[REDACTED]" {
		t.Fatalf("code-produced credential echo was not redacted: %+v", detail.Outcomes)
	}
	frozen := detail.Snapshot.Results[0]
	if frozen.Case.ID != "judge" || frozen.Result.CaseID != "judge" || frozen.Request.CaseID != "judge" || frozen.Request.GroupID != "judge" {
		t.Fatalf("source references changed: %+v", frozen)
	}
	evidence := frozen.Case.Variables["evidence"].(map[string]any)["[REDACTED]"].([]any)
	if evidence[0] != "[REDACTED]" || evidence[1] != json.Number("9007199254740993") {
		t.Fatalf("arbitrary JSON evidence was not safely redacted: %+v", evidence)
	}
	var exported EvaluationDetail
	h.api("GET", "/api/evaluations/"+execution.ID+"/export", nil, 200, &exported)
	if !reflect.DeepEqual(detail, exported) {
		t.Fatal("export differs from readable evaluation detail")
	}
	var replay Evaluation
	h.api("POST", "/api/evaluations/"+execution.ID+"/replay", map[string]any{}, 202, &replay)
	again := h.waitEvaluation(replay.ID)
	assertEvaluationRedactionCompleted(t, again, generation.Results[0].ID, "judge", "judge")
	if !reflect.DeepEqual(detail.Snapshot, again.Snapshot) || again.Outcomes[0].Outcome.Reason != "[REDACTED]" {
		t.Fatal("replay lost frozen references or content redaction")
	}
	var unchanged Detail
	h.api("GET", "/api/runs/"+batch.ID, nil, 200, &unchanged)
	if !reflect.DeepEqual(generation, unchanged) {
		t.Fatal("evaluation rewrote source generation history")
	}
}

func assertEvaluationRedactionCompleted(t *testing.T, d EvaluationDetail, resultID, metricID, groupID string) {
	t.Helper()
	if d.Evaluation.Status != "completed" || d.Evaluation.Completed != 1 || d.Evaluation.Failed != 0 || len(d.Outcomes) != 1 {
		t.Fatalf("evaluation did not complete: %+v", d)
	}
	entry := d.Outcomes[0]
	if entry.ResultID != resultID || entry.MetricID != metricID || entry.Outcome.MetricID != metricID || entry.Outcome.Status != "completed" || entry.Outcome.Value != true {
		t.Fatalf("consumer outcome references/value changed: %+v", entry)
	}
	if len(d.Snapshot.Metrics) != 1 || d.Snapshot.Metrics[0].Metric.ID != metricID || d.Snapshot.Metrics[0].Target.Mode != "output" {
		t.Fatalf("frozen metric lookup changed: %+v", d.Snapshot.Metrics)
	}
	if len(d.Summary) != 2 {
		t.Fatalf("missing overall/group summaries: %+v", d.Summary)
	}
	for i, expectedGroup := range []string{"", groupID} {
		entry := d.Summary[i]
		if entry.MetricID != metricID || entry.GroupID != expectedGroup || entry.Valid != 1 || entry.TrueCount != 1 || entry.Error != 0 || entry.Pending != 0 {
			t.Fatalf("summary does not match completed outcome: %+v", d.Summary)
		}
	}
}

func TestEvaluationRedactionPreservesShortMachineStrings(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		generatedJSON(w, "ordinary output")
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := metricFixture(provider.URL)
	s.Metrics = []Metric{{ID: "judge", Name: "Code", Kind: "code", ReturnType: "boolean", Code: `function evaluate(){return {value:true,reason:["out","put"].join("")}}`}}
	s.Draft.Metrics = nil
	s = h.save(s)
	var batch Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &batch)
	generation := h.wait(batch.ID)
	// These are all valid synthetic credentials, including status, target kind,
	// return type, executable tokens, JSON field names and actual source IDs.
	for _, secret := range []string{"code", "output", "completed", "boolean", "true", "id", "1", generation.Results[0].ID, batch.ID} {
		t.Run(secret, func(t *testing.T) {
			s = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: secret}}, 200).State
			var execution Evaluation
			h.api("POST", "/api/evaluations", EvaluationInput{StateVersion: s.Version, GenerationRunID: batch.ID, EvaluationConfig: EvaluationConfig{Metrics: []MetricSelection{{MetricID: "judge", Target: MetricTarget{Mode: "output"}}}, Concurrency: 1}}, 202, &execution)
			d := h.waitEvaluation(execution.ID)
			assertEvaluationRedactionCompleted(t, d, generation.Results[0].ID, "judge", s.Draft.Groups[0].ID)
			if d.Snapshot.GenerationRunID != batch.ID || d.Snapshot.Results[0].Result.Status != "completed" || d.Snapshot.Metrics[0].Metric.Kind != "code" || d.Snapshot.Metrics[0].Metric.ReturnType != "boolean" || d.Snapshot.Metrics[0].Metric.Code != s.Metrics[0].Code {
				t.Fatalf("machine configuration was redacted: %+v", d.Snapshot)
			}
			if secret == "output" && d.Outcomes[0].Outcome.Reason != "[REDACTED]" {
				t.Fatalf("ordinary content echo survived: %+v", d.Outcomes[0])
			}
		})
	}
}

func TestEvaluationRedactionPreservesDecisionCredentialReference(t *testing.T) {
	var expectedAuth atomic.Value
	expectedAuth.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/systemone") {
			generatedJSON(w, "ordinary output")
			return
		}
		auth := expectedAuth.Load().(string)
		if r.Header.Get("Authorization") != auth {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":"wrong credential reference"}`)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"model": "decision", "echo": strings.TrimPrefix(auth, "Bearer "), "answers": map[string]any{"metric": map[string]any{"type": "noul", "noul": 0.9, "legend": map[string]string{"yes": strings.TrimPrefix(auth, "Bearer ")}}}})
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := h.save(metricFixture(provider.URL))
	var batch Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &batch)
	generation := h.wait(batch.ID)
	ref := s.Providers[1].CredentialRef
	expectedAuth.Store("Bearer " + ref)
	s = h.credentials(s, map[string]CredentialUpdate{"jev": {Action: "set", Key: ref}}, 200).State
	var execution Evaluation
	h.api("POST", "/api/evaluations", EvaluationInput{StateVersion: s.Version, GenerationRunID: batch.ID, EvaluationConfig: EvaluationConfig{Metrics: []MetricSelection{{MetricID: "judge", Target: MetricTarget{Mode: "output"}}}, Concurrency: 1}}, 202, &execution)
	d := h.waitEvaluation(execution.ID)
	assertEvaluationRedactionCompleted(t, d, generation.Results[0].ID, "judge", s.Draft.Groups[0].ID)
	frozen := d.Snapshot.Metrics[0]
	if frozen.Provider.CredentialRef != ref || frozen.Provider.ID != "jev" || frozen.Metric.ProviderID != "jev" || frozen.Provider.Protocol != typesafeProtocol {
		t.Fatalf("decision provider/auth routing changed: %+v", frozen)
	}
	outcome := d.Outcomes[0].Outcome
	if strings.Contains(outcome.RawResponse, ref) || outcome.Legend["yes"] != "[REDACTED]" || !strings.Contains(outcome.RawResponse, "[REDACTED]") {
		t.Fatalf("upstream credential echo survived in evidence: %+v", outcome)
	}
	var replay Evaluation
	h.api("POST", "/api/evaluations/"+execution.ID+"/replay", map[string]any{}, 202, &replay)
	assertEvaluationRedactionCompleted(t, h.waitEvaluation(replay.ID), generation.Results[0].ID, "judge", s.Draft.Groups[0].ID)
}

func TestEvaluationRedactionTypedConfigurationAndEvidence(t *testing.T) {
	const secret = "secret"
	provider := Provider{ID: secret, Name: secret, Protocol: typesafeProtocol, BaseURL: "https://secret.invalid", APIKeyEnv: secret, CredentialRef: secret}
	metric := FrozenMetric{Metric: Metric{
		ID: secret, Name: secret, Kind: "code", ReturnType: "classification",
		Code: `function evaluate(){return {value:"secret"}}`, Rule: secret, ProviderID: secret, Model: secret,
		Levels: []string{secret}, Labels: []MetricLabel{{Label: secret, Description: secret}},
	}, Target: MetricTarget{Mode: "json_pointer", Pointer: "/secret"}, Provider: &provider, RequiresAuth: true}
	snapshot := EvaluationSnapshot{GenerationRunID: secret, Metrics: []FrozenMetric{metric}, Results: []EvaluationSource{{
		Result: Result{ID: secret, CaseID: secret, GroupID: secret, GroupName: secret, Model: secret, Status: "completed", Output: secret, Error: secret, ResponseModel: secret, PromptHash: secret},
		Case:   SnapshotCase{ID: secret, Variables: map[string]any{"nested": []any{map[string]any{secret: secret}, json.Number("1.00")}}},
		Request: FrozenRequest{CaseID: secret, GroupID: secret, GroupName: secret, Model: secret, Endpoint: provider.BaseURL, Method: "POST", APIKeyEnv: secret, Protocol: typesafeProtocol, CredentialRef: secret, PromptHash: secret,
			Request: json.RawMessage(`{"model":"secret","temperature":1.00,"content":"\u0073ecret"}`), RawRequest: `{"content":"\u0073ecret"}`,
			LanguageResolution: &LanguageResolution{SourceLanguage: secret, Targets: []Target{{Key: secret, Name: secret}}},
		},
	}}}
	before := mustJSON(t, snapshot)
	clean := redactEvaluationSnapshot(snapshot, map[string]string{"credential": secret})
	if mustJSON(t, snapshot) != before {
		t.Fatal("redaction mutated immutable source content")
	}
	if !reflect.DeepEqual(snapshot.Metrics, clean.Metrics) {
		t.Fatalf("judgment code/criteria/provider/target configuration changed: %+v", clean.Metrics)
	}
	source := clean.Results[0]
	if source.Result.ID != secret || source.Result.CaseID != secret || source.Result.GroupID != secret || source.Result.GroupName != secret || source.Result.Model != secret || source.Result.PromptHash != secret || source.Case.ID != secret {
		t.Fatalf("source identity/configuration changed: %+v", source)
	}
	request := source.Request
	if request.CaseID != secret || request.GroupID != secret || request.Model != secret || request.Endpoint != provider.BaseURL || request.CredentialRef != secret || request.APIKeyEnv != secret || request.PromptHash != secret || !reflect.DeepEqual(request.LanguageResolution, snapshot.Results[0].Request.LanguageResolution) {
		t.Fatalf("request routing/configuration changed: %+v", request)
	}
	if source.Result.Output != "[REDACTED]" || source.Result.Error != "[REDACTED]" || source.Result.ResponseModel != "[REDACTED]" || strings.Contains(string(request.Request), secret) || strings.Contains(request.RawRequest, secret) || !strings.Contains(string(request.Request), "[REDACTED]") || !strings.Contains(request.RawRequest, "[REDACTED]") {
		t.Fatalf("untrusted source/wire evidence was not redacted: %+v", source)
	}
	nested := source.Case.Variables["nested"].([]any)
	if nested[0].(map[string]any)["[REDACTED]"] != "[REDACTED]" || nested[1] != json.Number("1.00") {
		t.Fatalf("content redaction lost recursive sanitization or numeric lexemes: %+v", nested)
	}
	outcome := MetricOutcome{MetricID: secret, Status: "completed", Value: secret, Reason: secret, Error: secret, StartedAt: secret, FinishedAt: secret, ResponseModel: secret, RawResponse: `{"echo":"\u0073ecret"}`, Probabilities: map[string]float64{secret: 1}, Legend: map[string]string{secret: secret}}
	cleanOutcome := redactEvaluationOutcome(outcome, map[string]string{"credential": secret, "status-collision": "completed"})
	if cleanOutcome.MetricID != secret || cleanOutcome.Status != "completed" || cleanOutcome.Value != secret || cleanOutcome.StartedAt != secret || cleanOutcome.FinishedAt != secret || cleanOutcome.Probabilities[secret] != 1 {
		t.Fatalf("typed outcome value/identity/status/criteria changed: %+v", cleanOutcome)
	}
	if cleanOutcome.Reason != "[REDACTED]" || cleanOutcome.Error != "[REDACTED]" || cleanOutcome.ResponseModel != "[REDACTED]" || cleanOutcome.Legend[secret] != "[REDACTED]" || !strings.Contains(cleanOutcome.RawResponse, "[REDACTED]") {
		t.Fatalf("outcome content evidence was not redacted: %+v", cleanOutcome)
	}
	if outcome.Legend[secret] != secret {
		t.Fatal("outcome content redaction mutated the original legend")
	}
	raw := json.RawMessage(` { "large": 9007199254740993, "decimal": 1.00 } `)
	if clean := redactEvaluationPayload(raw, map[string]string{"credential": secret}); string(clean) != string(raw) {
		t.Fatalf("unmatched request payload bytes changed: %s", clean)
	}
}
