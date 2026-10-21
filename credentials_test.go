package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func (h *harness) view() StateView {
	h.t.Helper()
	var v StateView
	h.api("GET", "/api/state", nil, 200, &v)
	return v
}
func (h *harness) credentials(st State, updates map[string]CredentialUpdate, want int) StateView {
	h.t.Helper()
	var v StateView
	h.api("PUT", "/api/state", StateWrite{State: st, CredentialUpdates: updates}, want, &v)
	return v
}
func oneCase(s State) State {
	s.Draft.CaseIDs = []string{"a"}
	for i := range s.Draft.Groups {
		s.Draft.Groups[i].Runs = 1
	}
	return s
}
func (h *harness) run(s State) Detail {
	h.t.Helper()
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &b)
	return h.wait(b.ID)
}

func TestManualCredentialLifecycleAndIndependentProfiles(t *testing.T) {
	calls := make(chan string, 100)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls <- r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]any{"model": "returned", "choices": []any{map[string]any{"message": map[string]string{"content": "echo " + r.Header.Get("Authorization")}}}})
	}))
	defer provider.Close()
	var env atomic.Value
	env.Store("fake-env-key")
	h := newHarness(t, func(string) string { return env.Load().(string) })
	s := oneCase(fixtureState(provider.URL))
	s.Providers[0].APIKeyEnv = "SHARED_ENV"
	other := s.Providers[0]
	other.ID = "other"
	other.Name = "Other profile"
	s.Providers = append(s.Providers, other)
	s.Draft.Groups[1].ProviderID = "other"
	s = h.save(s)
	v := h.view()
	if v.Credentials["p"].Source != "env" || !v.Credentials["p"].EnvAvailable || v.Credentials["p"].ManualSet {
		t.Fatal(v.Credentials)
	}
	h.run(s)
	for range 2 {
		if <-calls != "Bearer fake-env-key" {
			t.Fatal("blank initial did not use env")
		}
	}
	v = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "manual-first"}, "other": {Action: "set", Key: "manual-second"}}, 200)
	s = v.State
	if v.Credentials["p"].Source != "manual" || !v.Credentials["p"].ManualSet {
		t.Fatal(v.Credentials)
	}
	d := h.run(s)
	if <-calls != "Bearer manual-first" || <-calls != "Bearer manual-second" {
		t.Fatal("profiles sharing env collided")
	}
	if !d.Snapshot.Requests[0].RequiresAuth || d.Snapshot.Requests[0].CredentialRef == d.Snapshot.Requests[1].CredentialRef {
		t.Fatal("auth snapshot/ref not independent")
	}
	// A save with untouched password has no mutation; both overrides remain.
	v = h.credentials(s, nil, 200)
	s = v.State
	h.run(s)
	if <-calls != "Bearer manual-first" || <-calls != "Bearer manual-second" {
		t.Fatal("untouched override replaced")
	}
	v = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "manual-replaced"}, "other": {Action: "clear"}}, 200)
	s = v.State
	h.run(s)
	if <-calls != "Bearer manual-replaced" || <-calls != "Bearer fake-env-key" {
		t.Fatal("replace/clear precedence wrong")
	}
	for _, path := range []string{"/api/state", "/api/runs/" + d.Batch.ID, "/api/runs/" + d.Batch.ID + "/export"} {
		raw := h.api("GET", path, nil, 200, nil)
		for _, secret := range []string{"manual-first", "manual-second", "manual-replaced", "fake-env-key"} {
			if bytes.Contains(raw, []byte(secret)) {
				t.Fatalf("secret in %s", path)
			}
		}
	}
	var encrypted []byte
	if err := h.store.db.QueryRow("SELECT ciphertext FROM credentials WHERE ref=?", s.Providers[0].CredentialRef).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("manual-replaced")) {
		t.Fatal("unencrypted credential")
	}
	var dbPath string
	rows, err := h.store.db.Query("PRAGMA database_list")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var seq int
		var name string
		if err = rows.Scan(&seq, &name, &dbPath); err != nil {
			t.Fatal(err)
		}
	}
	rows.Close()
	rawDB, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"manual-first", "manual-second", "manual-replaced"} {
		if bytes.Contains(rawDB, []byte(secret)) {
			t.Fatal("plaintext manual key in SQLite")
		}
	}
	// Clearing the final override with no env fails, including authenticated history after source deletion.
	v = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "clear"}}, 200)
	s = v.State
	env.Store("")
	v = h.view()
	if v.Credentials["p"].Source != "missing" || v.Credentials["p"].Available || v.Credentials["p"].EnvAvailable {
		t.Fatal(v.Credentials)
	}
	h.api("POST", "/api/runs", runInput(s, 1), 400, nil)
	empty := State{Cases: []Case{}, Templates: []Template{}, Providers: []Provider{}, Settings: s.Settings, Draft: Draft{CaseIDs: []string{}, Groups: []Group{}}}
	h.save(empty)
	h.api("POST", "/api/runs/"+d.Batch.ID+"/replay", map[string]any{}, 400, nil)
	select {
	case <-calls:
		t.Fatal("missing history auth sent anonymous call")
	default:
	}
}

func TestCredentialValidationOwnershipAtomicityAndProtocolCatalog(t *testing.T) {
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { count.Add(1); success(w) }))
	defer provider.Close()
	h := newHarness(t, nil)
	s := h.save(oneCase(fixtureState(provider.URL)))
	var catalog []ProtocolInfo
	h.api("GET", "/api/protocols", nil, 200, &catalog)
	if len(catalog) != 1 || catalog[0].ID != openAIChatProtocol {
		t.Fatal(catalog)
	}
	// Credential-only PUT still bumps version, and a stale render/freeze cannot mix old endpoint with a newly replaced key.
	frozen, err := freeze(s, runInput(s, 1))
	if err != nil {
		t.Fatal(err)
	}
	v := h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "coherent-key"}}, 200)
	if v.Version != s.Version+1 {
		t.Fatal("credential save did not bump version")
	}
	if _, err = h.engine.start("stale", frozen, 1, "", s.Version); !errors.Is(err, errStale) {
		t.Fatal("stale pre-rendered snapshot accepted", err)
	}
	h.credentials(s, map[string]CredentialUpdate{"p": {Action: "clear"}}, 409)
	s = v.State
	if h.view().Credentials["p"].Source != "manual" {
		t.Fatal("stale save cleared override")
	}
	for _, update := range []CredentialUpdate{{Action: "set", Key: ""}, {Action: "set", Key: "bad\r\nkey"}, {Action: "clear", Key: "pending-secret"}, {Action: "other", Key: "pending-secret"}} {
		raw := h.api("PUT", "/api/state", StateWrite{State: s, CredentialUpdates: map[string]CredentialUpdate{"p": update}}, 400, nil)
		if bytes.Contains(raw, []byte("pending-secret")) || bytes.Contains(raw, []byte("bad\\r")) {
			t.Fatal("validation echoed password")
		}
	}
	bad := s
	bad.Providers = append([]Provider(nil), s.Providers...)
	bad.Providers[0].CredentialRef = "forged"
	h.credentials(bad, nil, 400)
	bad = s
	bad.Providers = append([]Provider(nil), s.Providers...)
	clone := bad.Providers[0]
	clone.ID = "new"
	bad.Providers = append(bad.Providers, clone)
	h.credentials(bad, nil, 400)
	bad = s
	bad.Providers = append([]Provider(nil), s.Providers...)
	bad.Providers[0].Protocol = "anthropic-not-implemented"
	h.credentials(bad, nil, 400)
	unsupported := frozen
	unsupported.Requests = append([]FrozenRequest(nil), frozen.Requests...)
	unsupported.Requests[0].Protocol = "unsupported"
	if _, err = h.engine.start("unsupported", unsupported, 1, "", 0); err == nil {
		t.Fatal("unsupported replay protocol accepted")
	}
	// Retained refs cannot be resurrected by a newly-created provider, even under the original id.
	deleted := s
	deleted.Providers = []Provider{}
	deleted.Draft.Groups = []Group{}
	deleted = h.save(deleted)
	recreate := deleted
	recreate.Providers = []Provider{clone}
	h.credentials(recreate, nil, 400)
	if count.Load() != 0 {
		t.Fatal("invalid inputs issued calls")
	}
}

func TestInFlightKeepsResolvedManualKeyAndRedactsNewKeys(t *testing.T) {
	calls := make(chan string, 8)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var n atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls <- r.Header.Get("Authorization")
		if n.Add(1) == 1 {
			entered <- struct{}{}
			<-release
		}
		json.NewEncoder(w).Encode(map[string]any{"model": "returned", "choices": []any{map[string]any{"message": map[string]string{"content": "old-flight-key new-flight-key env-flight-key"}}}})
	}))
	defer provider.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	h := newHarness(t, func(string) string { return "env-flight-key" })
	s := oneCase(fixtureState(provider.URL))
	s.Providers[0].APIKeyEnv = "ENV"
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 2
	s = h.save(s)
	v := h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "old-flight-key"}}, 200)
	s = v.State
	var batch Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &batch)
	<-entered
	v = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "new-flight-key"}}, 200)
	s = v.State
	close(release)
	d := h.wait(batch.ID)
	for range 2 {
		if <-calls != "Bearer old-flight-key" {
			t.Fatal("batch credential changed mid-run")
		}
	}
	for _, r := range d.Results {
		if strings.Contains(r.RawResponse, "flight-key") || strings.Contains(r.Output, "flight-key") {
			t.Fatal("known old/new/env key echo leaked")
		}
	}
	next := h.run(s)
	for range 2 {
		if <-calls != "Bearer new-flight-key" {
			t.Fatal("later batch used old key")
		}
	}
	if next.Batch.Completed != 2 {
		t.Fatal(next.Batch)
	}
}

func TestEncryptedCredentialRestartAndMissingMasterFailSafe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "promptbench.sqlite")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.state()
	if err != nil {
		t.Fatal(err)
	}
	st, err = s.saveState(st, map[string]CredentialUpdate{st.Providers[0].ID: {Action: "set", Key: "persist-private-key"}})
	if err != nil {
		t.Fatal(err)
	}
	ref := st.Providers[0].CredentialRef
	s.close()
	s, err = openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	key, status, err := s.credential(ref, "MISSING_ENV", true, func(string) string { return "" })
	if err != nil || key != "persist-private-key" || status.Source != "manual" {
		t.Fatal("restart failed", status, err)
	}
	s.close()
	keyPath := filepath.Join(filepath.Dir(path), "credentials.key")
	master, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if failed, err := openStore(path); err == nil {
		failed.close()
		t.Fatal("missing master silently replaced")
	}
	if _, err = os.Stat(keyPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed startup regenerated master")
	}
	if err = os.WriteFile(keyPath, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if failed, err := openStore(path); err == nil {
		failed.close()
		t.Fatal("wrong master accepted")
	}
	if err = os.WriteFile(keyPath, master, 0600); err != nil {
		t.Fatal(err)
	}
	s, err = openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	restored, _ := s.state()
	if restored.Version != st.Version {
		t.Fatal("failed key recovery changed data")
	}
}

func TestLegacyMigrationPreservesUserHistoryBytesAndReplay(t *testing.T) {
	calls := make(chan string, 2)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		calls <- string(raw)
		if r.URL.Path != "/frozen-legacy" || r.Header.Get("Authorization") != "Bearer legacy-env-key" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("legacy wire metadata drift")
		}
		success(w)
	}))
	defer provider.Close()
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE state(id INTEGER PRIMARY KEY,version INTEGER,data BLOB); CREATE TABLE batches(id TEXT PRIMARY KEY,created_at TEXT,summary BLOB,snapshot BLOB); CREATE TABLE results(id TEXT PRIMARY KEY,batch_id TEXT,seq INTEGER,group_id TEXT,case_id TEXT,iteration INTEGER,data BLOB,UNIQUE(batch_id,group_id,case_id,iteration));`)
	if err != nil {
		t.Fatal(err)
	}
	old := oneCase(fixtureState(provider.URL))
	old.Version = 7
	old.Cases[0].Variables["UserEdit"] = "USER EDIT preserved"
	stateMap := map[string]any{}
	json.Unmarshal([]byte(mustJSON(t, old)), &stateMap)
	for _, p := range stateMap["providers"].([]any) {
		delete(p.(map[string]any), "protocol")
		delete(p.(map[string]any), "credential_ref")
	}
	stateRaw := mustJSON(t, stateMap)
	rawRequest := "{\n \"messages\":[{\"role\":\"user\",\"content\":\"original\"}],\"model\":\"legacy-model\"\n}"
	hash := sha256.Sum256([]byte(rawRequest))
	hashText := hex.EncodeToString(hash[:])
	legacySnapshot := map[string]any{"cases": old.Cases, "templates": old.Templates, "providers": stateMap["providers"], "groups": old.Draft.Groups, "case_ids": old.Draft.CaseIDs, "timeout_seconds": 5, "requests": []any{map[string]any{"case_id": "a", "case_name": "original case", "group_id": "g1", "group_name": "original group", "model": "legacy-model", "endpoint": provider.URL + "/frozen-legacy", "api_key_env": "LEGACY_KEY", "request": json.RawMessage(rawRequest), "prompt_hash": hashText, "runs": 1}}}
	summary := Batch{ID: "history", Name: "USER HISTORY", Status: "completed", CreatedAt: now(), FinishedAt: now(), Total: 1, Completed: 1, Concurrency: 1}
	result := Result{ID: "original-result", CaseID: "a", GroupID: "g1", Iteration: 1, Status: "completed", RawRequest: rawRequest, Request: json.RawMessage(rawRequest), RawResponse: "original response", PromptHash: hashText}
	resultBytes := mustJSON(t, result)
	if _, err = db.Exec("INSERT INTO state VALUES(1,7,?)", stateRaw); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO batches VALUES(?,?,?,?)", summary.ID, summary.CreatedAt, mustJSON(t, summary), mustJSON(t, legacySnapshot)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO results VALUES(?,?,?,?,?,?,?)", result.ID, summary.ID, 0, "g1", "a", 1, resultBytes); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	migrated, err := s.state()
	if err != nil {
		t.Fatal(err)
	}
	if migrated.Version != 8 || migrated.Cases[0].Variables["UserEdit"] != "USER EDIT preserved" || migrated.Providers[0].Protocol != openAIChatProtocol {
		t.Fatal("state migration lost edits")
	}
	var actual string
	if err = s.db.QueryRow("SELECT data FROM results WHERE id=?", result.ID).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if actual != resultBytes {
		t.Fatal("migration rewrote result record")
	}
	d, err := s.detail("history")
	if err != nil {
		t.Fatal(err)
	}
	f := d.Snapshot.Requests[0]
	if f.RawRequest != rawRequest || f.PromptHash != hashText || !f.RequiresAuth || f.CredentialRef != "legacy:p" || f.Protocol != openAIChatProtocol {
		t.Fatal("legacy snapshot changed bytes or auth", f)
	}
	e := newEngine(s, func(string) string { return "legacy-env-key" })
	defer e.close()
	b, err := e.start("replay", d.Snapshot, 1, d.Batch.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	e.wg.Wait()
	if <-calls != rawRequest {
		t.Fatal("legacy replay changed actual body whitespace")
	}
	replayed, err := s.detail(b.ID)
	if err != nil || replayed.Batch.Completed != 1 || len(replayed.Results) != 1 {
		t.Fatal("migration replay failed", err)
	}
}

// A test-only wire protocol proves the boundary with real HTTP, without advertising
// or implementing any unrequested native-vendor option in production.
type fixtureWireProtocol struct{}

func (fixtureWireProtocol) Info() ProtocolInfo {
	return ProtocolInfo{ID: "test-wire", Name: "Test wire", Roles: []string{"user"}}
}
func (fixtureWireProtocol) Validate(Provider) error { return nil }
func (fixtureWireProtocol) Prepare(p Provider, model string, m []Message, params map[string]any) (PreparedRequest, error) {
	body, _ := json.Marshal(map[string]any{"text": m[len(m)-1].Content, "target": model})
	return PreparedRequest{Endpoint: p.BaseURL + "/native", Method: "PUT", Headers: map[string]string{"Content-Type": "application/json", "X-Wire-Version": "fixture-v1"}, Body: body}, nil
}
func (fixtureWireProtocol) Authorize(r *http.Request, key string) error {
	r.Header.Set("X-Test-Credential", key)
	return nil
}
func (fixtureWireProtocol) Decode(raw []byte) (string, string, error) {
	var body map[string]string
	err := json.Unmarshal(raw, &body)
	return body["identity"], body["text"], err
}
func TestProtocolBoundaryFrozenHeadersAndNonBearerAuth(t *testing.T) {
	protocolAdapters = append(protocolAdapters, fixtureWireProtocol{})
	defer func() { protocolAdapters = protocolAdapters[:len(protocolAdapters)-1] }()
	var called atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		if r.Method != "PUT" || r.URL.Path != "/native" || r.Header.Get("X-Wire-Version") != "fixture-v1" || r.Header.Get("X-Test-Credential") != "test-native-key" || r.Header.Get("Authorization") != "" {
			t.Error("adapter wire contract not honored")
		}
		fmt.Fprint(w, `{"identity":"wire-returned","text":"wire output"}`)
	}))
	defer provider.Close()
	h := newHarness(t, func(string) string { return "test-native-key" })
	s := oneCase(fixtureState(provider.URL))
	s.Providers[0].BaseURL = provider.URL
	s.Providers[0].Protocol = "test-wire"
	s.Providers[0].APIKeyEnv = "TEST"
	s.Draft.Groups = s.Draft.Groups[:1]
	s = h.save(s)
	d := h.run(s)
	if called.Load() != 1 || d.Results[0].Output != "wire output" || d.Results[0].ResponseModel != "wire-returned" {
		t.Fatal("core assumed OpenAI shape")
	}
	f := d.Snapshot.Requests[0]
	if f.Protocol != "test-wire" || f.Method != "PUT" || f.Headers["X-Wire-Version"] != "fixture-v1" {
		t.Fatal("prepared metadata not frozen")
	}
	// The runtime credential is absent from frozen nonsecret headers and export.
	raw := h.api("GET", "/api/runs/"+d.Batch.ID+"/export", nil, 200, nil)
	if bytes.Contains(raw, []byte("test-native-key")) || bytes.Contains(raw, []byte("X-Test-Credential")) {
		t.Fatal("runtime auth leaked into snapshot")
	}
}

func TestFutureDatabaseVersionRejectedWithoutDroppingState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.sqlite")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	var before string
	if err = s.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("PRAGMA user_version=4"); err != nil {
		t.Fatal(err)
	}
	s.close()
	if old, err := openStore(path); err == nil {
		old.close()
		t.Fatal("future database accepted")
	} else if !strings.Contains(err.Error(), "newer") {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var after string
	var version int
	if err = db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if after != before || version != 4 {
		t.Fatal("future state downgraded or reset")
	}
}

func TestInvalidEnvironmentCredentialNeverSent(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); success(w) }))
	defer provider.Close()
	h := newHarness(t, func(string) string { return "invalid\ncredential" })
	s := oneCase(fixtureState(provider.URL))
	s.Providers[0].APIKeyEnv = "ENV"
	s = h.save(s)
	status := h.view().Credentials["p"]
	if status.Source != "invalid" || status.EnvAvailable || status.Available {
		t.Fatal(status)
	}
	h.api("POST", "/api/runs", runInput(s, 1), 400, nil)
	if calls.Load() != 0 {
		t.Fatal("invalid env was sent")
	}
}
