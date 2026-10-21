package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func schemaTwoCaseState(t *testing.T) map[string]any {
	t.Helper()
	st := fixtureState("https://example.com")
	for i := range st.Providers {
		st.Providers[i].CredentialRef = "installed-credential-" + st.Providers[i].ID
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(mustJSON(t, st)), &root); err != nil {
		t.Fatal(err)
	}
	root["version"] = float64(17)
	root["cases"] = []any{map[string]any{"id": "oldname", "name": "用户名称", "description": "original description", "variables": map[string]any{"SourceLanguage": "zh-CN", "CurrentText": "你好", "PriorText": "original", "ReplacementMap": "", "TargetLanguageNameMap": map[string]any{"en": "English", "jp": "Japanese"}}}}
	root["collections"] = []any{map[string]any{"id": "collection", "name": "kept", "case_ids": []string{"oldname"}}}
	draft := root["draft"].(map[string]any)
	draft["case_ids"] = []string{"oldname"}
	draft["excluded_case_ids"] = []string{"oldname"}
	draft["collection_ids"] = []string{"collection"}
	for _, group := range draft["groups"].([]any) {
		delete(group.(map[string]any), "language_routes")
		group.(map[string]any)["runs"] = float64(20)
	}
	root["settings"].(map[string]any)["default_runs"] = float64(3)
	root["templates"].([]any)[0].(map[string]any)["messages"] = []any{map[string]any{"role": "system", "content": "system preserved"}, map[string]any{"role": "user", "content": "{{.CurrentText}}"}, map[string]any{"role": "assistant", "content": "additional preserved"}}
	return root
}

func installSchemaTwo(t *testing.T, raw []byte) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "schema2.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE state(id INTEGER PRIMARY KEY,version INTEGER,data BLOB); CREATE TABLE batches(id TEXT PRIMARY KEY,created_at TEXT,summary BLOB,snapshot BLOB); CREATE TABLE results(id TEXT PRIMARY KEY,batch_id TEXT,seq INTEGER,group_id TEXT,case_id TEXT,iteration INTEGER,data BLOB,UNIQUE(batch_id,group_id,case_id,iteration)); PRAGMA user_version=2;`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO state VALUES(1,17,?)", raw); err != nil {
		t.Fatal(err)
	}
	return db, path
}

func TestCaseSchemaMigrationArchivesAndPreservesHistory(t *testing.T) {
	root := schemaTwoCaseState(t)
	raw := []byte("\n " + mustJSON(t, root) + "\n")
	db, path := installSchemaTwo(t, raw)
	snapshot := []byte(" {\n\"cases\":[{\"id\":\"oldname\",\"name\":\"historical name\",\"variables\":{\"TargetLanguageNameMap\":{\"en\":\"English\"}}}],\"requests\":[]} ")
	result := []byte(" {\"case_id\":\"oldname\",\"raw_response\":\"original\"}\n")
	if _, err := db.Exec("INSERT INTO batches VALUES('history','', '{}', ?)", snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO results VALUES('result','history',0,'g1','oldname',1,?)", result); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	var archived, actual []byte
	if err := db.QueryRow("SELECT state_data FROM migration_archives WHERE from_version=2").Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(archived, raw) || !bytes.Contains(archived, []byte("oldname")) {
		t.Fatal("archive did not preserve exact original state")
	}
	if err := db.QueryRow("SELECT snapshot FROM batches WHERE id='history'").Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, snapshot) {
		t.Fatal("historical snapshot rewritten")
	}
	if err := db.QueryRow("SELECT data FROM results WHERE id='result'").Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, result) {
		t.Fatal("historical result rewritten")
	}
	st, err := store.state()
	if err != nil {
		t.Fatal(err)
	}
	id := st.Cases[0].ID
	if id == "oldname" || id == "" || st.Version != 18 || st.Draft.CaseIDs[0] != id || st.Draft.ExcludedCaseIDs[0] != id || st.Collections[0].CaseIDs[0] != id {
		t.Fatal("Case identity migration failed", st)
	}
	if _, ok := st.Cases[0].Variables["TargetLanguageNameMap"]; ok {
		t.Fatal("legacy target map retained")
	}
	for _, g := range st.Draft.Groups {
		if g.Runs != 20 || len(g.LanguageRoutes) != 1 || g.LanguageRoutes[0].SourceLanguage != "zh-CN" || len(g.LanguageRoutes[0].Targets) != 2 {
			t.Fatal("group behavior changed", g)
		}
	}
	if st.Settings.DefaultRuns != 3 || len(st.Templates[0].Messages) != 3 || st.Templates[0].Messages[0].Role != "system" || st.Templates[0].Messages[2].Content != "additional preserved" {
		t.Fatal("settings or messages lost")
	}
	for i, p := range st.Providers {
		original := root["providers"].([]any)[i].(map[string]any)
		if p.CredentialRef != original["credential_ref"] || p.Protocol != original["protocol"] {
			t.Fatal("provider protection changed")
		}
	}
}

func TestCaseSchemaMigrationFailsAtomically(t *testing.T) {
	for _, scenario := range []string{"conflict", "unknown-field", "missing-source", "missing-map"} {
		t.Run(scenario, func(t *testing.T) {
			root := schemaTwoCaseState(t)
			cases := root["cases"].([]any)
			first := cases[0].(map[string]any)
			switch scenario {
			case "conflict":
				cases = append(cases, map[string]any{"id": "conflicting", "variables": map[string]any{"SourceLanguage": "zh-CN", "TargetLanguageNameMap": map[string]any{"es": "Spanish"}}})
				root["cases"] = cases
			case "unknown-field":
				first["unrepresentable"] = "must not disappear"
			case "missing-source":
				delete(first["variables"].(map[string]any), "SourceLanguage")
			case "missing-map":
				root["cases"] = append(cases, map[string]any{"id": "missing", "variables": map[string]any{"SourceLanguage": "zh-CN"}})
			}
			raw := []byte(mustJSON(t, root))
			db, path := installSchemaTwo(t, raw)
			store, err := openStore(path)
			if err == nil {
				store.close()
				t.Fatal("unsafe migration accepted")
			}
			if !strings.Contains(err.Error(), "Case migration") {
				t.Fatal(err)
			}
			var actual []byte
			var version int
			if err := db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&actual); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(actual, raw) || version != 2 {
				t.Fatal("failed migration wrote database")
			}
			var count int
			if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='migration_archives'").Scan(&count); err != nil || count != 0 {
				t.Fatal("failed migration left archive changes", err)
			}
		})
	}
}

func TestInstalledSchemaTwoFourCaseShape(t *testing.T) {
	st, err := seedState()
	if err != nil {
		t.Fatal(err)
	}
	oldIDs := []string{"labor", "rule_of_law", "water_ecology", "labor_greetings"}
	var root map[string]any
	if err := json.Unmarshal([]byte(mustJSON(t, st)), &root); err != nil {
		t.Fatal(err)
	}
	cases := root["cases"].([]any)
	for i, entry := range cases {
		c := entry.(map[string]any)
		c["id"], c["name"], c["description"] = oldIDs[i], "installed "+oldIDs[i], "original experiment input"
		c["variables"].(map[string]any)["TargetLanguageNameMap"] = map[string]any{"en": "English"}
	}
	root["version"] = float64(17)
	root["settings"].(map[string]any)["default_runs"] = float64(3)
	draft := root["draft"].(map[string]any)
	draft["case_ids"] = oldIDs
	for _, entry := range draft["groups"].([]any) {
		delete(entry.(map[string]any), "language_routes")
	}
	root["templates"].([]any)[0].(map[string]any)["messages"] = []any{map[string]any{"role": "system", "content": seedTemplate}, map[string]any{"role": "user", "content": "hi"}}
	raw := []byte(mustJSON(t, root))
	db, path := installSchemaTwo(t, raw)
	store, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	migrated, err := store.state()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated.Cases) != 4 || migrated.Settings.DefaultRuns != 3 || migrated.Version != 18 {
		t.Fatal("installed state changed", migrated)
	}
	for i, c := range migrated.Cases {
		if c.ID == oldIDs[i] || migrated.Draft.CaseIDs[i] != c.ID {
			t.Fatal("installed Case ID not remapped")
		}
		if mustJSON(t, c.Variables) != mustJSON(t, st.Cases[i].Variables) {
			t.Fatal("installed variables changed")
		}
	}
	for _, g := range migrated.Draft.Groups {
		if g.Runs != 20 || len(g.LanguageRoutes) != 1 || g.LanguageRoutes[0].SourceLanguage != "zh-CN" || len(g.LanguageRoutes[0].Targets) != 1 || g.LanguageRoutes[0].Targets[0] != (Target{Key: "en", Name: "English"}) {
			t.Fatal("installed route or runs changed", g)
		}
	}
	for i, p := range migrated.Providers {
		if p != st.Providers[i] {
			t.Fatal("installed provider refs changed")
		}
	}
	messages := migrated.Templates[0].Messages
	if len(messages) != 2 || messages[0].Role != "system" || messages[0].Content != seedTemplate || messages[1].Role != "user" || messages[1].Content != "hi" {
		t.Fatal("installed messages changed")
	}
	var archived []byte
	if err := db.QueryRow("SELECT state_data FROM migration_archives").Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, archived) {
		t.Fatal("installed state archive changed")
	}
}
