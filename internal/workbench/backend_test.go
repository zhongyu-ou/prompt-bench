package workbench

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type harness struct {
	t      *testing.T
	store  *Store
	engine *Engine
	server *httptest.Server
}

func newHarness(t *testing.T, getenv func(string) string) *harness {
	t.Helper()
	s, err := openStore(filepath.Join(t.TempDir(), "data", "promptbench.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	e := newEngine(s, getenv)
	ts := httptest.NewUnstartedServer(nil)
	ts.Config.Handler = newAPI(s, e, ts.Listener.Addr().String())
	ts.Start()
	h := &harness{t, s, e, ts}
	t.Cleanup(func() { ts.Close(); e.close(); s.close() })
	return h
}
func (h *harness) api(method, path string, body any, want int, out any) []byte {
	h.t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err = io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != want {
		h.t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err = decodeStored(raw, out); err != nil {
			h.t.Fatal(err)
		}
	}
	return raw
}
func fixtureState(base string) State {
	s := State{Version: 1, Cases: []Case{{ID: "a", Variables: map[string]any{"CurrentText": "alpha", "PriorText": "history", "SourceLanguage": "zh", "ReplacementMap": ""}}, {ID: "b", Variables: map[string]any{"CurrentText": "beta", "SourceLanguage": "en", "ReplacementMap": "replace"}}}, Templates: []Template{{ID: "t", Name: "Template", Messages: []Message{{Role: "system", Content: "Header\n{{- if .ReplacementMap }} REPLACE={{.ReplacementMap}}{{- end }}\n{{- range $k, $v := .TargetLanguageNameMap }}\n{{$k}}={{$v}}{{if eq $k \"sr\"}} CYRILLIC{{end}}{{- end }}"}, {Role: "user", Content: "{{.CurrentText}}"}}}}, Providers: []Provider{{ID: "p", Name: "Fixture", Protocol: openAIChatProtocol, BaseURL: base + "/v1"}}, Settings: Settings{DefaultRuns: 20, Concurrency: 20, TimeoutSeconds: 5}, Draft: Draft{Name: "test", CaseIDs: []string{"a", "b"}, Groups: []Group{{ID: "g1", Name: "Group 1", Enabled: true, TemplateID: "t", ProviderID: "p", Model: "requested-one", Parameters: map[string]any{"temperature": json.Number("0"), "reasoning_effort": "none", "seed": json.Number("9007199254740993")}, Runs: 2}, {ID: "g2", Name: "Group 2", Enabled: true, TemplateID: "t", ProviderID: "p", Model: "requested-two", Parameters: map[string]any{}, Runs: 2}}}}
	for i := range s.Draft.Groups {
		s.Draft.Groups[i].LanguageRoutes = []LanguageRoute{{SourceLanguage: "zh", Targets: []Target{{Key: "en", Name: "English"}, {Key: "sr", Name: "Serbian"}}}, {SourceLanguage: "en", Targets: []Target{{Key: "jp", Name: "Japanese"}}}}
	}
	return s
}
func (h *harness) save(s State) State {
	h.t.Helper()
	var current State
	h.api("GET", "/api/state", nil, 200, &current)
	s.Version = current.Version
	// Deterministic fixture installation is not a public state-resource mutation.
	if mustJSON(h.t, s.Cases) != mustJSON(h.t, current.Cases) || mustJSON(h.t, s.Collections) != mustJSON(h.t, current.Collections) {
		saved, err := h.store.saveState(s, nil)
		if err != nil {
			h.t.Fatal(err)
		}
		return saved
	}
	var saved State
	h.api("PUT", "/api/state", s, 200, &saved)
	return saved
}
func runInput(s State, concurrency int) RunInput {
	return RunInput{StateVersion: s.Version, Name: s.Draft.Name, CaseIDs: s.Draft.CaseIDs, Groups: s.Draft.Groups, Concurrency: concurrency}
}
func (h *harness) wait(id string) Detail {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var d Detail
		h.api("GET", "/api/runs/"+id, nil, 200, &d)
		if d.Batch.FinishedAt != "" {
			return d
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("batch did not finish")
	return Detail{}
}
func success(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"model":"returned-model","choices":[{"message":{"content":"fixture output"}}]}`)
}

func TestPreviewEqualsSentAndReplayFrozen(t *testing.T) {
	type captured struct{ body, endpoint, authorization string }
	calls := make(chan captured, 32)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls <- captured{string(b), r.URL.Path, r.Header.Get("Authorization")}
		json.NewEncoder(w).Encode(map[string]any{"model": "returned-model", "choices": []any{map[string]any{"message": map[string]string{"content": "fixture output " + strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")}}}})
	}))
	defer provider.Close()
	var key atomic.Value
	key.Store("first-private-key")
	h := newHarness(t, func(string) string { return key.Load().(string) })
	s := fixtureState(provider.URL)
	s.Providers[0].APIKeyEnv = "FIXTURE_KEY"
	s = h.save(s)
	type preview struct {
		Request    json.RawMessage `json:"request"`
		Endpoint   string          `json:"endpoint"`
		PromptHash string          `json:"prompt_hash"`
	}
	nullGroup := s.Draft.Groups[0]
	nullGroup.Parameters = map[string]any{"temperature": nil, "reasoning_effort": nil}
	var explicitNull preview
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": nullGroup}, 200, &explicitNull)
	if !bytes.Contains(explicitNull.Request, []byte(`"temperature":null`)) || !bytes.Contains(explicitNull.Request, []byte(`"reasoning_effort":null`)) {
		t.Fatal("explicit null parameters were omitted")
	}
	previews := map[string]preview{}
	for _, id := range s.Draft.CaseIDs {
		for _, g := range s.Draft.Groups {
			var p preview
			h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": id, "group": g}, 200, &p)
			previews[id+g.ID] = p
		}
	}
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &b)
	d := h.wait(b.ID)
	if d.Batch.Completed != 8 || d.Batch.Failed != 0 || len(d.Results) != 8 {
		t.Fatalf("unexpected counts: %+v", d.Batch)
	}
	wantOrder := []string{"ag1", "ag2", "bg1", "bg2", "ag1", "ag2", "bg1", "bg2"}
	for i, r := range d.Results {
		call := <-calls
		p := previews[r.CaseID+r.GroupID]
		if r.CaseID+r.GroupID != wantOrder[i] {
			t.Fatalf("group/case interleaving: %+v", r)
		}
		if call.body != r.RawRequest || !bytes.Equal(r.Request, p.Request) || call.body != string(p.Request) || r.PromptHash != p.PromptHash {
			t.Fatalf("preview/sent/persisted request drift: %#v %s", call, r.RawRequest)
		}
		if call.endpoint != "/v1/chat/completions" || p.Endpoint != provider.URL+call.endpoint || call.authorization != "Bearer first-private-key" {
			t.Fatalf("endpoint/auth mismatch: %+v %+v", call, p)
		}
		if r.Model == r.ResponseModel || r.ResponseModel != "returned-model" || r.Output != "fixture output [REDACTED]" {
			t.Fatalf("identity/output: %+v", r)
		}
	}
	rawA := string(previews["ag1"].Request)
	if !strings.Contains(rawA, `"seed":9007199254740993`) || !strings.Contains(rawA, `"temperature":0`) || !strings.Contains(rawA, `"reasoning_effort":"none"`) || !strings.Contains(rawA, `Header\nen=English\nsr=Serbian CYRILLIC`) {
		t.Fatalf("Go rendering/numeric presence: %s", rawA)
	}
	if strings.Contains(string(previews["ag2"].Request), "temperature") || strings.Contains(string(previews["ag2"].Request), "reasoning_effort") {
		t.Fatal("omitted parameters injected")
	}
	// Delete every mutable source and change settings; replay must still use the old endpoint, roles, exact numbers and prompt bytes.
	empty := State{Cases: []Case{}, Templates: []Template{}, Providers: []Provider{}, Settings: Settings{DefaultRuns: 3, Concurrency: 2, TimeoutSeconds: 1}, Draft: Draft{CaseIDs: []string{}, Groups: []Group{}}}
	h.save(empty)
	key.Store("rotated-private-key")
	var replay Batch
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 202, &replay)
	again := h.wait(replay.ID)
	if replay.ID == b.ID || replay.ReplayOf != b.ID || !reflect.DeepEqual(d.Snapshot, again.Snapshot) {
		t.Fatal("replay did not retain original snapshot")
	}
	for i, r := range again.Results {
		call := <-calls
		if call.body != d.Results[i].RawRequest || r.RawRequest != call.body || call.authorization != "Bearer rotated-private-key" {
			t.Fatalf("replay request/auth drift: %+v", call)
		}
		if r.Output != "fixture output [REDACTED]" {
			t.Fatal("rotated replay key echo not redacted")
		}
	}
	export := h.api("GET", "/api/runs/"+replay.ID+"/export", nil, 200, nil)
	if bytes.Contains(export, []byte("private-key")) || bytes.Contains(export, []byte("Authorization")) {
		t.Fatal("credential leaked in export")
	}
	key.Store("")
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 400, nil)
	select {
	case <-calls:
		t.Fatal("missing-key replay sent request")
	default:
	}
}

func TestErrorsPreservedNoRetriesAndRedaction(t *testing.T) {
	key := `secret-quote"-key`
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		switch in["model"] {
		case "http-error":
			w.WriteHeader(422)
			json.NewEncoder(w).Encode(map[string]any{"model": "error-model", "error": map[string]string{"message": "echo " + key}})
		case "bad-json":
			fmt.Fprint(w, "invalid JSON: "+key)
		case "binary":
			w.Write([]byte{0xff, 0xfe, 'x'})
		case "escaped-key":
			var escaped strings.Builder
			for _, r := range key {
				fmt.Fprintf(&escaped, `\u%04x`, r)
			}
			w.WriteHeader(422)
			fmt.Fprintf(w, `{"model":"%s","error":{"%s":"%s"}}`, escaped.String(), escaped.String(), escaped.String())
		default:
			json.NewEncoder(w).Encode(map[string]any{"model": "returned", "choices": []any{map[string]any{"message": map[string]string{"content": "echo " + key}}}})
		}
	}))
	defer provider.Close()
	h := newHarness(t, func(string) string { return key })
	s := fixtureState(provider.URL)
	s.Providers[0].APIKeyEnv = "TEST_KEY"
	s.Draft.CaseIDs = []string{"a"}
	s.Draft.Groups = nil
	for i, model := range []string{"http-error", "bad-json", "binary", "success", "escaped-key"} {
		s.Draft.Groups = append(s.Draft.Groups, Group{ID: fmt.Sprint(i), Name: model, Enabled: true, TemplateID: "t", ProviderID: "p", Model: model, Parameters: map[string]any{}, Runs: 1})
	}
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 2), 202, &b)
	d := h.wait(b.ID)
	if count.Load() != 5 || d.Batch.Failed != 4 || d.Batch.Completed != 1 {
		t.Fatalf("retries/counts: calls=%d batch=%+v", count.Load(), d.Batch)
	}
	if d.Results[0].HTTPStatus != 422 || !strings.Contains(d.Results[0].RawResponse, "[REDACTED]") || d.Results[0].ResponseModel != "error-model" {
		t.Fatalf("HTTP error lost: %+v", d.Results[0])
	}
	if !strings.Contains(d.Results[1].Error, "decode response") || d.Results[1].RawResponse != "invalid JSON: [REDACTED]" {
		t.Fatalf("decode evidence lost: %+v", d.Results[1])
	}
	binary, err := base64.StdEncoding.DecodeString(d.Results[2].RawResponseBase64)
	if err != nil || !bytes.Equal(binary, []byte{0xff, 0xfe, 'x'}) {
		t.Fatal("binary raw bytes not preserved")
	}
	if d.Results[3].Output != "echo [REDACTED]" {
		t.Fatal("success output echo not redacted")
	}
	var escapedBody map[string]any
	if err := json.Unmarshal([]byte(d.Results[4].RawResponse), &escapedBody); err != nil {
		t.Fatal(err)
	}
	if d.Results[4].ResponseModel != "[REDACTED]" || escapedBody["error"].(map[string]any)["[REDACTED]"] != "[REDACTED]" {
		t.Fatal("Unicode-escaped upstream key leaked")
	}
	for _, path := range []string{"/api/state", "/api/runs/" + b.ID, "/api/runs/" + b.ID + "/export"} {
		raw := h.api("GET", path, nil, 200, nil)
		if bytes.Contains(raw, []byte(key)) || bytes.Contains(raw, []byte(`secret-quote`)) {
			t.Fatalf("key leaked through %s", path)
		}
	}
}

func TestGlobalCapStopAndNoBrowserOwnership(t *testing.T) {
	var active, maxActive, issued atomic.Int32
	entered := make(chan struct{}, 100)
	release := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		issued.Add(1)
		for {
			old := maxActive.Load()
			if n <= old || maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		active.Add(-1)
		success(w)
	}))
	defer provider.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	h := newHarness(t, nil)
	s := fixtureState(provider.URL)
	s.Draft.Groups[0].Runs = 20
	s.Draft.Groups[1].Runs = 20
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 20), 202, &b)
	for range 20 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("did not fill cap")
		}
	}
	var d Detail
	h.api("GET", "/api/runs/"+b.ID, nil, 200, &d)
	if d.Batch.InFlight != 20 || d.Batch.Total != 80 {
		t.Fatalf("live progress not visible: %+v", d.Batch)
	}
	// The start response connection is already gone; calls remain live and observable on a new request.
	h.api("POST", "/api/runs", runInput(s, 20), 409, nil)
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 409, nil)
	var stopped Batch
	h.api("POST", "/api/runs/"+b.ID+"/stop", map[string]any{}, 200, &stopped)
	if stopped.Status != "stopping" || stopped.Cancelled != 60 || stopped.InFlight != 20 {
		t.Fatalf("stop did not preserve issued work: %+v", stopped)
	}
	h.api("POST", "/api/runs", runInput(s, 20), 409, nil)
	close(release)
	d = h.wait(b.ID)
	if issued.Load() != 20 || maxActive.Load() != 20 || d.Batch.Completed != 20 || d.Batch.Cancelled != 60 || d.Batch.Status != "stopped" {
		t.Fatalf("cap/stop semantics calls=%d max=%d batch=%+v", issued.Load(), maxActive.Load(), d.Batch)
	}
	for i, r := range d.Results {
		if i < 20 && r.Status != "completed" || i >= 20 && r.Status != "cancelled" {
			t.Fatalf("wrong status %d: %+v", i, r)
		}
	}
}

func TestRestartAndExclusiveDirectoryLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "promptbench.sqlite")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	d := Detail{Batch: Batch{ID: "restart", Name: "Interrupted", Status: "running", CreatedAt: now(), Total: 3, InFlight: 1, Completed: 1, Concurrency: 2}, Snapshot: Snapshot{Requests: []FrozenRequest{}}, Results: []Result{{ID: "done", CaseID: "a", GroupID: "g", Iteration: 1, Status: "completed"}, {ID: "inflight", CaseID: "a", GroupID: "g", Iteration: 2, Status: "running"}, {ID: "pending", CaseID: "a", GroupID: "g", Iteration: 3, Status: "pending"}}}
	if err = s.create(d); err != nil {
		t.Fatal(err)
	}
	second, err := openStore(path)
	if err == nil {
		second.close()
		t.Fatal("second process acquired live directory")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Fatal(err)
	}
	live, err := s.detail(d.Batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if live.Batch.Status != "running" || live.Results[1].Status != "running" {
		t.Fatal("failed second open mutated active work")
	}
	s.close()
	s, err = openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	recovered, err := s.detail(d.Batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Batch.Status != "interrupted" || recovered.Batch.Interrupted != 2 || recovered.Batch.Completed != 1 || recovered.Batch.InFlight != 0 {
		t.Fatalf("restart state: %+v", recovered.Batch)
	}
	if recovered.Results[0].Status != "completed" || recovered.Results[1].Status != "interrupted" || recovered.Results[2].Status != "interrupted" || !strings.Contains(recovered.Results[1].Error, "not resent") {
		t.Fatal("restart changed completed or forgot unknown work")
	}
	e := newEngine(s, func(string) string { t.Fatal("restart must not resolve/send"); return "" })
	defer e.close()
	if e.active != nil {
		t.Fatal("restart automatically resumed")
	}
	for _, p := range []string{filepath.Dir(path), path, filepath.Join(filepath.Dir(path), "promptbench.lock")} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("non-private permissions %s: %o", p, info.Mode().Perm())
		}
	}
	bytes, err := os.ReadFile(path)
	if err != nil || !strings.HasPrefix(string(bytes), "SQLite format 3") {
		t.Fatal("not actual SQLite persistence")
	}
}

func TestInputSecurityAndStaleVersionsPreventCalls(t *testing.T) {
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { count.Add(1); success(w) }))
	defer provider.Close()
	h := newHarness(t, nil)
	s := h.save(fixtureState(provider.URL))
	old := s
	var saved State
	h.api("PUT", "/api/state", s, 200, &saved)
	h.api("PUT", "/api/state", old, 409, nil)
	h.api("POST", "/api/preview", map[string]any{"state_version": old.Version, "case_id": "a", "group": old.Draft.Groups[0]}, 409, nil)
	h.api("POST", "/api/runs", runInput(old, 1), 409, nil)
	s = saved
	for _, key := range []string{"model", "messages", "stream", "Authorization", "api_key", "extra_headers"} {
		input := runInput(s, 1)
		input.Groups = append([]Group(nil), s.Draft.Groups...)
		input.Groups[0].Parameters = map[string]any{key: true}
		h.api("POST", "/api/runs", input, 400, nil)
	}
	for _, concurrency := range []int{0, 21} {
		h.api("POST", "/api/runs", runInput(s, concurrency), 400, nil)
	}
	bad := runInput(s, 1)
	bad.CaseIDs = []string{"missing"}
	h.api("POST", "/api/runs", bad, 400, nil)
	// Repeated explicit selections now use union semantics, not duplicate calls.
	h.api("POST", "/api/selection/preview", map[string]any{"state_version": s.Version, "case_ids": []string{"a", "a"}, "groups": s.Draft.Groups}, 200, nil)
	bad = runInput(s, 1)
	bad.Groups = append([]Group(nil), s.Draft.Groups...)
	bad.Groups[0].Runs = 0
	h.api("POST", "/api/runs", bad, 400, nil)
	malicious := s
	malicious.Providers = append([]Provider(nil), s.Providers...)
	malicious.Providers[0].BaseURL = "http://user:secret@127.0.0.1/v1"
	h.api("PUT", "/api/state", malicious, 400, nil)
	malicious = s
	malicious.Templates = append([]Template(nil), s.Templates...)
	malicious.Templates[0].Messages = []Message{{Role: "user", Content: "{{exec \"pwd\"}}"}}
	h.api("PUT", "/api/state", malicious, 400, nil)
	for _, change := range []string{"host", "origin", "content-type"} {
		req, _ := http.NewRequest("POST", h.server.URL+"/api/runs", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		switch change {
		case "host":
			req.Host = "evil.example"
		case "origin":
			req.Header.Set("Origin", "http://evil.example")
		case "content-type":
			req.Header.Set("Content-Type", "text/plain")
		}
		resp, err := h.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		want := 403
		if change == "content-type" {
			want = 415
		}
		if resp.StatusCode != want {
			t.Fatalf("%s accepted: %d", change, resp.StatusCode)
		}
	}
	// An actual same-origin browser mutation is accepted, not rejected along with bad origins.
	req, _ := http.NewRequest("POST", h.server.URL+"/api/preview", strings.NewReader(fmt.Sprintf(`{"state_version":%d,"case_id":"a","group":%s}`, s.Version, mustJSON(t, s.Draft.Groups[0]))))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.server.URL)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("same origin rejected")
	}
	if count.Load() != 0 {
		t.Fatalf("invalid inputs issued %d calls", count.Load())
	}
	for _, addr := range []string{"0.0.0.0:8787", ":8787", "example.com:8787", "192.168.0.1:8787"} {
		if _, err := loopbackAddress(addr); err == nil {
			t.Fatalf("public bind allowed: %s", addr)
		}
	}
}
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRedirectNeverForwardsCredentials(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1); success(w) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer redirect.Close()
	h := newHarness(t, func(string) string { return "private-redirect-key" })
	s := fixtureState(redirect.URL)
	s.Providers[0].APIKeyEnv = "KEY"
	s.Draft.CaseIDs = []string{"a"}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s = h.save(s)
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &b)
	d := h.wait(b.ID)
	if targetCalls.Load() != 0 || d.Results[0].HTTPStatus != 307 || d.Results[0].Status != "failed" {
		t.Fatal("redirect followed or not recorded")
	}
}

func TestRenderBoundAndEnvFile(t *testing.T) {
	s := fixtureState("http://127.0.0.1:9797")
	s.Cases[0].Variables["CurrentText"] = strings.Repeat("x", maxRender+1)
	if _, err := renderRequest(s, "a", s.Draft.Groups[0]); err == nil {
		t.Fatal("unbounded template output")
	}
	s.Templates[0].Messages = []Message{{Role: "user", Content: strings.Repeat("x", maxRender+1)}}
	if _, err := renderRequest(s, "a", s.Draft.Groups[0]); err == nil {
		t.Fatal("unbounded literal output")
	}
	file := filepath.Join(t.TempDir(), "keys.env")
	t.Setenv("PROMPTBENCH_EXISTING", "existing")
	os.Unsetenv("PROMPTBENCH_TEST_NEW")
	t.Cleanup(func() { os.Unsetenv("PROMPTBENCH_TEST_NEW") })
	if err := os.WriteFile(file, []byte("# sample\nPROMPTBENCH_EXISTING=do-not-override\nexport PROMPTBENCH_TEST_NEW='local-only'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadEnvFile(file); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("PROMPTBENCH_EXISTING") != "existing" || os.Getenv("PROMPTBENCH_TEST_NEW") != "local-only" {
		t.Fatal("env-file handling")
	}
	// Current API base URLs are normalized only by appending chat/completions.
	ep, err := (openAIChat{}).endpoint(Provider{BaseURL: "http://127.0.0.1:9797/v1/"})
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(ep)
	if u.Path != "/v1/chat/completions" {
		t.Fatal(ep)
	}
}
