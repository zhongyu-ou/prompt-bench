package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestCaseCRUDSharedMembershipsAndDeletion(t *testing.T) {
	h := newHarness(t, nil)
	s := h.save(fixtureState("http://127.0.0.1:1"))
	var v StateView
	h.api("POST", "/api/collections", map[string]any{"state_version": s.Version, "name": "Shared"}, 201, &v)
	c1 := v.Collections[0].ID
	h.api("POST", "/api/collections", map[string]any{"state_version": v.Version, "name": "Other"}, 201, &v)
	c2 := v.Collections[1].ID
	vars := map[string]any{"CurrentText": "same\n input ", "SourceLanguage": "zh-CN", "ReplacementMap": nil, "extra": []any{true, json.Number("9007199254740993")}}
	h.api("POST", "/api/cases", map[string]any{"state_version": v.Version, "variables": vars, "collection_ids": []string{c1, c2}}, 201, &v)
	id := v.Cases[len(v.Cases)-1].ID
	if len(id) != 32 || id == "a" {
		t.Fatal("case ID not generated")
	}
	h.api("POST", "/api/cases", map[string]any{"state_version": v.Version, "variables": vars}, 201, &v)
	copyID := v.Cases[len(v.Cases)-1].ID
	if copyID == id || len(v.Cases) != 4 {
		t.Fatal("intentional duplicate collapsed")
	}
	vars["CurrentText"] = "changed shared"
	h.api("PUT", "/api/cases/"+id, map[string]any{"state_version": v.Version, "variables": vars}, 200, &v)
	for _, c := range v.Collections {
		if !slices.Contains(c.CaseIDs, id) {
			t.Fatal("shared edit lost memberships")
		}
	}
	v.Draft.CaseIDs = []string{id}
	v.Draft.CollectionIDs = []string{c1, c2}
	v.Draft.ExcludedCaseIDs = []string{id}
	s = h.save(v.State)
	h.api("DELETE", "/api/cases/"+id, map[string]any{"state_version": s.Version}, 200, &v)
	if slices.Contains(v.Draft.CaseIDs, id) || slices.Contains(v.Draft.ExcludedCaseIDs, id) {
		t.Fatal("dangling draft reference")
	}
	for _, c := range v.Collections {
		if slices.Contains(c.CaseIDs, id) {
			t.Fatal("dangling membership")
		}
	}
	h.api("DELETE", "/api/collections/"+c1, map[string]any{"state_version": v.Version}, 200, &v)
	if len(v.Cases) != 3 || slices.Contains(v.Draft.CollectionIDs, c1) {
		t.Fatal("collection deletion removed cases or left draft ref")
	}
	before := v.Version
	h.api("POST", "/api/collections/"+c2+"/members", map[string]any{"state_version": v.Version, "add_case_ids": []string{copyID}, "remove_case_ids": []string{copyID}}, 400, nil)
	if h.view().Version != before {
		t.Fatal("invalid membership partially committed")
	}
	h.api("POST", "/api/collections/"+c2+"/members", map[string]any{"state_version": v.Version, "add_case_ids": []string{copyID, copyID}}, 200, &v)
	if !reflect.DeepEqual(v.Collections[0].CaseIDs, []string{copyID}) {
		t.Fatal(v.Collections)
	}
}

func TestSelection150Cases1080AndExactRouting(t *testing.T) {
	h := newHarness(t, nil)
	s := fixtureState("http://127.0.0.1:1")
	s.Cases = []Case{}
	first := []string{}
	second := []string{}
	for i := range 150 {
		id := fmt.Sprintf("c%03d", i)
		source := []string{"zh", "en", "es", "zh-CN"}[i%4]
		s.Cases = append(s.Cases, Case{ID: id, Variables: map[string]any{"CurrentText": fmt.Sprint(i), "SourceLanguage": source}})
		if i < 12 {
			first = append(first, id)
		}
		if i >= 9 && i < 29 {
			second = append(second, id)
		}
	}
	s.Collections = []Collection{{ID: "one", Name: "12", CaseIDs: first}, {ID: "two", Name: "20", CaseIDs: second}}
	s.Draft.CaseIDs = []string{}
	s.Draft.CollectionIDs = []string{"one", "two"}
	s.Draft.ExcludedCaseIDs = []string{"c000", "c001"}
	for i := range s.Draft.Groups {
		s.Draft.Groups[i].Runs = 20
		s.Draft.Groups[i].LanguageRoutes = []LanguageRoute{{SourceLanguage: "zh", Targets: []Target{{Key: "en", Name: "English"}}}, {SourceLanguage: "en", Targets: []Target{{Key: "jp", Name: "Japanese"}}}}
	}
	s.Draft.Groups[1].LanguageRoutes[0].Targets = append(s.Draft.Groups[1].LanguageRoutes[0].Targets, Target{Key: "jp", Name: "Japanese"})
	s = h.save(s)
	body := map[string]any{"state_version": s.Version, "case_ids": []string{"c002"}, "collection_ids": s.Draft.CollectionIDs, "excluded_case_ids": s.Draft.ExcludedCaseIDs, "groups": s.Draft.Groups}
	var preview struct {
		CaseIDs      []string `json:"case_ids"`
		CaseCount    int      `json:"case_count"`
		RequestCount int      `json:"request_count"`
		Resolutions  []struct {
			CaseID  string `json:"case_id"`
			GroupID string `json:"group_id"`
			LanguageResolution
		} `json:"resolutions"`
	}
	h.api("POST", "/api/selection/preview", body, 200, &preview)
	if preview.CaseCount != 27 || preview.RequestCount != 1080 || len(preview.Resolutions) != 54 {
		t.Fatalf("wrong count: %+v", preview)
	}
	snap, err := freeze(s, RunInput{StateVersion: s.Version, CaseIDs: []string{"c002"}, CollectionIDs: s.Draft.CollectionIDs, ExcludedCaseIDs: s.Draft.ExcludedCaseIDs, Groups: s.Draft.Groups, Concurrency: 20})
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, f := range snap.Requests {
		total += f.Runs
	}
	if total != 1080 || len(snap.Cases) != 27 || !reflect.DeepEqual(snap.CaseIDs, preview.CaseIDs) {
		t.Fatal("selection preview and freeze differ")
	}
	for _, r := range preview.Resolutions {
		if r.SourceLanguage == "es" || r.SourceLanguage == "zh-CN" {
			if !r.UsedDefault || !reflect.DeepEqual(r.Targets, []Target{{Key: "en", Name: "English"}}) {
				t.Fatal("locale silently normalized/default wrong")
			}
		}
		if r.SourceLanguage == "en" && (r.UsedDefault || r.Targets[0].Key != "jp") {
			t.Fatal("jp key changed")
		}
	}
	g := s.Draft.Groups[0]
	g.LanguageRoutes = g.LanguageRoutes[:1]
	var p struct {
		LanguageResolution LanguageResolution `json:"language_resolution"`
	}
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "c005", "group": g}, 200, &p)
	if p.LanguageResolution.SourceLanguage != "en" || !p.LanguageResolution.UsedDefault || p.LanguageResolution.Targets[0].Key != "en" {
		t.Fatal("en missing rule did not resolve en→en")
	}
	// No calls: merely applying/previewing a selection is not execution.
	if len(h.mustBatches()) != 0 {
		t.Fatal("preview started calls")
	}
}
func (h *harness) mustBatches() []Batch {
	h.t.Helper()
	var b []Batch
	h.api("GET", "/api/runs", nil, 200, &b)
	return b
}

func TestRoutesValidationAndForbiddenCaseOverride(t *testing.T) {
	h := newHarness(t, nil)
	s := h.save(fixtureState("http://127.0.0.1:1"))
	g := s.Draft.Groups[0]
	for _, routes := range [][]LanguageRoute{
		{{SourceLanguage: "zh", Targets: []Target{{Key: "en", Name: "English"}}}, {SourceLanguage: "zh", Targets: []Target{{Key: "jp", Name: "Japanese"}}}},
		{{SourceLanguage: "zh", Targets: []Target{}}}, {{SourceLanguage: " zh", Targets: []Target{{Key: "en", Name: "English"}}}},
		{{SourceLanguage: "zh", Targets: []Target{{Key: "en", Name: "English"}, {Key: "en", Name: "Other"}}}}, {{SourceLanguage: "zh", Targets: []Target{{Key: "x ", Name: "Custom"}}}},
	} {
		g.LanguageRoutes = routes
		h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": g}, 400, nil)
	}
	g.LanguageRoutes = []LanguageRoute{{SourceLanguage: "zh", Targets: []Target{{Key: "custom-key", Name: "Custom Language"}}}}
	var p map[string]any
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": g}, 200, &p)
	if !strings.Contains(p["raw_request"].(string), "custom-key=Custom Language") {
		t.Fatal(p)
	}
	forbidden := map[string]any{"CurrentText": "x", "TargetLanguageNameMap": map[string]any{"en": "English"}}
	h.api("POST", "/api/cases", map[string]any{"state_version": s.Version, "variables": forbidden}, 400, nil)
	h.api("PUT", "/api/cases/a", map[string]any{"state_version": s.Version - 1, "variables": forbidden}, 409, nil)
	var old map[string]any
	decodeStored([]byte(mustJSON(t, s)), &old)
	old["version"] = s.Version - 1
	old["cases"].([]any)[0].(map[string]any)["name"] = "old tab"
	h.api("PUT", "/api/state", old, 409, nil)
	old["version"] = s.Version
	h.api("PUT", "/api/state", old, 400, nil)
	s.Cases[0].ID = "client-assigned"
	s.Draft.CaseIDs[0] = "client-assigned"
	h.api("PUT", "/api/state", s, 400, nil)
}

func TestSharedCaseEditRoutingSnapshotAndReplayHTTP(t *testing.T) {
	calls := make(chan string, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		calls <- string(raw)
		success(w)
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := oneCase(fixtureState(provider.URL))
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Collections = []Collection{{ID: "shared1", Name: "One", CaseIDs: []string{"a"}}, {ID: "shared2", Name: "Two", CaseIDs: []string{"a"}}}
	s = h.save(s)
	var before struct {
		RawRequest         string             `json:"raw_request"`
		LanguageResolution LanguageResolution `json:"language_resolution"`
	}
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": s.Draft.Groups[0]}, 200, &before)
	d := h.run(s)
	sent := <-calls
	if before.RawRequest != sent || d.Snapshot.Requests[0].RawRequest != sent {
		t.Fatal("preview differs from sent bytes")
	}
	if !reflect.DeepEqual(*d.Snapshot.Requests[0].LanguageResolution, before.LanguageResolution) {
		t.Fatal("frozen resolution differs")
	}
	var v StateView
	h.api("PUT", "/api/cases/a", map[string]any{"state_version": s.Version, "variables": map[string]any{"CurrentText": "edited shared", "SourceLanguage": "zh-CN"}}, 200, &v)
	v.Draft.Groups[0].LanguageRoutes = []LanguageRoute{{SourceLanguage: "zh-CN", Targets: []Target{{Key: "jp", Name: "Japanese"}}}}
	s = h.save(v.State)
	newDetail := h.run(s)
	newSent := <-calls
	if sent == newSent || !strings.Contains(newSent, "jp=Japanese") || !strings.Contains(newSent, "edited shared") {
		t.Fatal("future shared run ignored changes")
	}
	if newDetail.Snapshot.Requests[0].LanguageResolution.SourceLanguage != "zh-CN" {
		t.Fatal("raw source not frozen")
	}
	h.api("DELETE", "/api/cases/a", map[string]any{"state_version": s.Version}, 200, &v)
	var b Batch
	h.api("POST", "/api/runs/"+d.Batch.ID+"/replay", map[string]any{}, 202, &b)
	replayed := h.wait(b.ID)
	if <-calls != sent || replayed.Results[0].RawRequest != sent {
		t.Fatal("history changed after shared edit/delete/routes")
	}
	var reread Detail
	raw := h.api("GET", "/api/runs/"+d.Batch.ID, nil, 200, &reread)
	if !bytes.Equal([]byte(reread.Results[0].RawRequest), []byte(sent)) {
		t.Fatal("old record changed")
	}
	if bytes.Contains(raw, []byte("edited shared")) {
		t.Fatal("old snapshot mutated")
	}
}

func TestNarrowStateSavePreservesImportedNumbers(t *testing.T) {
	h := newHarness(t, nil)
	s := h.view()
	content := `{"format":"promptbench-cases","version":1,"cases":[{"id":"typed","variables":{"CurrentText":" whitespace\n ","SourceLanguage":"zh","decimal":1.0,"large":9007199254740993,"null":null,"array":[1,"1",true]}}],"collections":[]}`
	var imported struct {
		State     StateView         `json:"state"`
		CaseIDMap map[string]string `json:"case_id_map"`
	}
	h.api("POST", "/api/cases/import", map[string]any{"state_version": s.Version, "format": "json", "content": content}, 200, &imported)
	id := imported.CaseIDMap["typed"]
	before := mustJSON(t, imported.State.Cases)
	templates := imported.State.Templates
	templates[0].Messages = append(templates[0].Messages, Message{Role: "user", Content: "unrelated template edit"})
	providers := imported.State.Providers
	providers[0].Name = "unrelated provider edit"
	var saved StateView
	h.api("PUT", "/api/state", map[string]any{"version": imported.State.Version, "templates": templates, "providers": providers, "settings": imported.State.Settings, "draft": imported.State.Draft}, 200, &saved)
	if got := mustJSON(t, saved.Cases); got != before || !strings.Contains(got, `"decimal":1.0`) || !strings.Contains(got, `"large":9007199254740993`) {
		t.Fatal("unrelated save changed exact numeric input", got)
	}
	// Simulate browser JSON.parse/stringify normalization/rounding: refuse resource mutation.
	var rounded map[string]any
	json.Unmarshal([]byte(mustJSON(t, saved.State)), &rounded)
	h.api("PUT", "/api/state", rounded, 400, nil)
	if h.view().Version != saved.Version {
		t.Fatal("read-only rejection wrote state")
	}
	for _, format := range []string{"json", "jsonl"} {
		raw := h.api("POST", "/api/cases/export", map[string]any{"state_version": saved.Version, "format": format, "case_ids": []string{id}}, 200, nil)
		parsed, err := parseCasePackage(format, string(raw))
		if err != nil {
			t.Fatal(err)
		}
		compact := mustJSON(t, parsed)
		if !strings.Contains(compact, `"decimal":1.0`) || !strings.Contains(compact, `"large":9007199254740993`) {
			t.Fatalf("export normalized number: %s", raw)
		}
		var result struct {
			NewCount      int       `json:"new_count"`
			ExistingCount int       `json:"existing_count"`
			State         StateView `json:"state"`
		}
		h.api("POST", "/api/cases/import", map[string]any{"state_version": saved.Version, "format": format, "content": string(raw)}, 200, &result)
		if result.NewCount != 0 || result.ExistingCount != 1 || mustJSON(t, result.State.Cases) != before {
			t.Fatal("roundtrip fingerprint/input changed")
		}
		saved = result.State
	}
}

func TestLosslessCaseReadPatchAndAdvancedReplacement(t *testing.T) {
	h := newHarness(t, nil)
	v := h.view()
	rawVars := `{"CurrentText":"original","SourceLanguage":"zh","decimal":1.0,"large":9007199254740993,"extra":{"list":[null,"1",1]}}`
	var read struct {
		Version int64 `json:"version"`
		Cases   []struct {
			ID            string `json:"id"`
			VariablesJSON string `json:"variables_json"`
		} `json:"cases"`
	}
	h.api("POST", "/api/cases", map[string]any{"state_version": v.Version, "variables_json": rawVars}, 201, &read)
	c := read.Cases[len(read.Cases)-1]
	id := c.ID
	if !strings.Contains(c.VariablesJSON, `"decimal":1.0`) || !strings.Contains(c.VariablesJSON, `"large":9007199254740993`) {
		t.Fatal("missing lossless read DTO", c)
	}
	h.api("PUT", "/api/cases/"+id, map[string]any{"state_version": read.Version, "variable_patch": map[string]any{"CurrentText": "form edit"}}, 200, &read)
	c = read.Cases[len(read.Cases)-1]
	if !strings.Contains(c.VariablesJSON, `"CurrentText":"form edit"`) || !strings.Contains(c.VariablesJSON, `"decimal":1.0`) || !strings.Contains(c.VariablesJSON, `"large":9007199254740993`) {
		t.Fatal("form patch rounded unknown values", c)
	}
	h.api("PUT", "/api/cases/"+id, map[string]any{"state_version": read.Version, "variables_json": c.VariablesJSON}, 200, &read)
	before := read.Version
	for _, body := range []map[string]any{
		{"variables_json": rawVars, "variable_patch": map[string]any{"CurrentText": "ambiguous"}},
		{"variables_json": rawVars + " {}"},
		{"variable_patch": map[string]any{"TargetLanguageNameMap": map[string]any{"en": "English"}}},
		{"variable_patch": map[string]any{"decimal": nil}, "remove_variables": []string{"decimal"}},
	} {
		body["state_version"] = before
		h.api("PUT", "/api/cases/"+id, body, 400, nil)
	}
	h.api("PUT", "/api/cases/"+id, map[string]any{"state_version": before, "remove_variables": []string{"extra"}}, 200, &read)
	if strings.Contains(read.Cases[len(read.Cases)-1].VariablesJSON, `"extra"`) {
		t.Fatal("variable removal ignored")
	}
	st, err := h.store.state()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mustJSON(t, st), `"variables_json"`) {
		t.Fatal("derived DTO duplicated persisted truth")
	}
}

func TestFrozenCollectionProvenanceSurvivesRenameMembershipAndDeletion(t *testing.T) {
	h := newHarness(t, nil)
	s := fixtureState("http://127.0.0.1:1")
	s.Collections = []Collection{{ID: "chosen", Name: "Original collection", CaseIDs: []string{"a", "b"}}, {ID: "unused", Name: "Not selected", CaseIDs: []string{"b"}}}
	s = h.save(s)
	in := runInput(s, 1)
	in.CaseIDs = nil
	in.CollectionIDs = []string{"chosen", "chosen"}
	in.ExcludedCaseIDs = []string{"b"}
	snap, err := freeze(s, in)
	if err != nil {
		t.Fatal(err)
	}
	want := []Collection{{ID: "chosen", Name: "Original collection", CaseIDs: []string{"a", "b"}}}
	if !reflect.DeepEqual(snap.Collections, want) || !reflect.DeepEqual(snap.CaseIDs, []string{"a"}) {
		t.Fatal("provenance did not retain original selection", snap)
	}
	d := Detail{Batch: Batch{ID: "provenance", Status: "completed", CreatedAt: now()}, Snapshot: snap, Results: []Result{}}
	if err := h.store.create(d); err != nil {
		t.Fatal(err)
	}
	var v StateView
	h.api("PUT", "/api/collections/chosen", map[string]any{"state_version": s.Version, "name": "Renamed"}, 200, &v)
	h.api("POST", "/api/collections/chosen/members", map[string]any{"state_version": v.Version, "remove_case_ids": []string{"b"}}, 200, &v)
	h.api("DELETE", "/api/collections/chosen", map[string]any{"state_version": v.Version}, 200, &v)
	var exported Detail
	h.api("GET", "/api/runs/provenance/export", nil, 200, &exported)
	if !reflect.DeepEqual(exported.Snapshot.Collections, want) || !reflect.DeepEqual(exported.Snapshot.Selection, snap.Selection) {
		t.Fatal("historical collection provenance changed")
	}
	// Frozen memberships also do not alias the source slice.
	s.Collections[0].CaseIDs[0] = "modified"
	if !reflect.DeepEqual(snap.Collections, want) {
		t.Fatal("frozen membership aliases current state")
	}
}

func TestLegacyHistoryExportRetainsRecordedCaseIdentityAndBody(t *testing.T) {
	h := newHarness(t, nil)
	body := "{\n  \"messages\": [{\"role\":\"user\",\"content\":\"original  body\\n\"}], \"model\":\"old\"\n}"
	snapshot := Snapshot{
		Cases:    []SnapshotCase{{ID: "old-semantic-id", Name: "原始名称", Description: "原始描述", Variables: map[string]any{"TargetLanguageNameMap": map[string]any{"jp": "Japanese"}}}},
		Requests: []FrozenRequest{{CaseID: "old-semantic-id", CaseName: "原始名称", Request: json.RawMessage(body), RawRequest: body, PromptHash: "recorded-original-hash"}},
	}
	result := Result{ID: "old-result", CaseID: "old-semantic-id", CaseName: "原始名称", Request: json.RawMessage(body), RawRequest: body, PromptHash: "recorded-original-hash"}
	if err := h.store.create(Detail{Batch: Batch{ID: "legacy-export", Status: "completed", CreatedAt: now()}, Snapshot: snapshot, Results: []Result{result}}); err != nil {
		t.Fatal(err)
	}
	var exported Detail
	h.api("GET", "/api/runs/legacy-export/export", nil, 200, &exported)
	c := exported.Snapshot.Cases[0]
	if c.ID != "old-semantic-id" || c.Name != "原始名称" || c.Description != "原始描述" {
		t.Fatal("legacy Case identity changed", c)
	}
	f, r := exported.Snapshot.Requests[0], exported.Results[0]
	if f.CaseID != c.ID || f.CaseName != c.Name || r.CaseID != c.ID || r.CaseName != c.Name || f.RawRequest != body || r.RawRequest != body || f.PromptHash != "recorded-original-hash" || r.PromptHash != f.PromptHash {
		t.Fatal("recorded legacy body/identity/hash changed")
	}
	state := h.api("GET", "/api/state", nil, 200, nil)
	var current struct {
		Cases []map[string]any `json:"cases"`
	}
	if err := json.Unmarshal(state, &current); err != nil {
		t.Fatal(err)
	}
	for _, c := range current.Cases {
		if _, ok := c["name"]; ok {
			t.Fatal("historical names leaked into current Case schema")
		}
		if _, ok := c["description"]; ok {
			t.Fatal("historical descriptions leaked into current Case schema")
		}
	}
}

func TestPureVariablesProjectionPreservesUntouchedInput(t *testing.T) {
	h := newHarness(t, nil)
	before := h.api("GET", "/api/state", nil, 200, nil)
	base := `{"CurrentText":"untouched\r\nline","PriorText":"old","decimal":1.50,"large":9007199254740993,"nested":[null,true,"12345678901234567890",{"n":2.00}],"remove":"gone"}`
	var out struct {
		VariablesJSON string `json:"variables_json"`
	}
	h.api("POST", "/api/cases/variables/preview", map[string]any{"variables_json": base, "variable_patch": map[string]any{"PriorText": "changed"}, "remove_variables": []string{"remove"}}, 200, &out)
	for _, literal := range []string{`"CurrentText":"untouched\r\nline"`, `"decimal":1.50`, `"large":9007199254740993`, `"nested":[null,true,"12345678901234567890",{"n":2.00}]`, `"PriorText":"changed"`} {
		if !strings.Contains(out.VariablesJSON, literal) {
			t.Fatal("projection changed untouched input", out.VariablesJSON)
		}
	}
	if strings.Contains(out.VariablesJSON, `"remove"`) {
		t.Fatal("removal ignored")
	}
	for _, input := range []map[string]any{
		{"variables_json": base, "variable_patch": map[string]any{"TargetLanguageNameMap": map[string]any{"en": "English"}}},
		{"variables_json": `{"TargetLanguageNameMap":{}}`},
		{"variables_json": base, "variable_patch": map[string]any{"PriorText": "x"}, "remove_variables": []string{"PriorText"}},
		{"variables_json": "{} {}"}, {},
	} {
		h.api("POST", "/api/cases/variables/preview", input, 400, nil)
	}
	after := h.api("GET", "/api/state", nil, 200, nil)
	if !bytes.Equal(before, after) || len(h.mustBatches()) != 0 {
		t.Fatal("pure projection mutated state or started a run")
	}
}

func TestLegacyEmptyCollectionsReadAsArray(t *testing.T) {
	st := State{Cases: []Case{}}
	raw, err := json.Marshal(StateView{State: st})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"collections":[]`)) {
		t.Fatalf("empty collections read shape: %s", raw)
	}
}
