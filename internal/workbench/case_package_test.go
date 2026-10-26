package workbench

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func packageTestVariables(t *testing.T, raw string) map[string]any {
	t.Helper()
	var variables map[string]any
	if err := packageJSON([]byte(raw), &variables); err != nil {
		t.Fatal(err)
	}
	return variables
}

func packageTestContent(t *testing.T, p casePackage, format string) string {
	t.Helper()
	b, err := encodeCasePackage(p, format)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCasePackageFingerprintOnlyCanonicalizesObjectKeys(t *testing.T) {
	base := packageTestVariables(t, `{"text":" 你好\n ","number":1.00,"nested":{"z":null,"a":[true,"x",2]}}`)
	want, err := caseInputFingerprint(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"number":1.00,"nested":{"a":[true,"x",2],"z":null},"text":" 你好\n "}`,
		`{"nested":{"z":null,"a":[true,"x",2]},"text":" 你好\n ","number":1.00}`,
		`{"nested":{"a":[true,"x",2],"z":null},"number":1.00,"text":" 你好\n "}`,
		`{"text":" 你好\n ","nested":{"a":[true,"x",2],"z":null},"number":1.00}`,
		`{"number":1.00,"text":" 你好\n ","nested":{"z":null,"a":[true,"x",2]}}`,
	} {
		got, err := caseInputFingerprint(packageTestVariables(t, raw))
		if err != nil || got != want {
			t.Fatalf("object permutation fingerprint = %q, %v; want %q", got, err, want)
		}
	}
	seen := map[string]string{}
	for _, raw := range []string{
		`{}`, `{"x":null}`, `{"x":false}`, `{"x":0}`, `{"x":0.0}`, `{"x":0e0}`,
		`{"x":"0"}`, `{"x":" 0"}`, `{"x":"0 "}`, `{"x":[]}`, `{"x":{}}`,
		`{"x":[1,2]}`, `{"x":[2,1]}`, `{"x":[1,"2"]}`, `{"x":[1,null]}`,
		`{"x":9007199254740993}`, `{"x":9007199254740992}`,
	} {
		got, err := caseInputFingerprint(packageTestVariables(t, raw))
		if err != nil {
			t.Fatal(err)
		}
		if previous, found := seen[got]; found {
			t.Fatalf("different inputs collapsed: %s and %s", previous, raw)
		}
		seen[got] = raw
	}
}

func TestCasePackageJSONAndJSONLRoundTrip(t *testing.T) {
	p := casePackage{Format: casePackageFormat, Version: 1,
		Cases:       []Case{{ID: "file-a", Variables: packageTestVariables(t, `{"n":1.2300e+2,"large":9007199254740993,"text":"\n中文 ","array":[false,null,{"z":2,"a":1}]}`)}},
		Collections: []Collection{{ID: "group", Name: "Shared", CaseIDs: []string{"file-a"}}, {ID: "empty", Name: "Empty", CaseIDs: []string{}}},
	}
	for _, first := range []string{"json", "jsonl"} {
		for _, second := range []string{"json", "jsonl"} {
			t.Run(first+"-"+second, func(t *testing.T) {
				parsed, err := parseCasePackage(first, packageTestContent(t, p, first))
				if err != nil {
					t.Fatal(err)
				}
				got, err := parseCasePackage(second, packageTestContent(t, parsed, second))
				if err != nil || !reflect.DeepEqual(got, p) {
					t.Fatalf("round trip = %#v, %v; want %#v", got, err, p)
				}
			})
		}
	}
	for _, format := range []string{"json", "jsonl"} {
		empty := casePackage{Format: casePackageFormat, Version: 1, Cases: []Case{}, Collections: []Collection{}}
		got, err := parseCasePackage(format, packageTestContent(t, empty, format))
		if err != nil || !reflect.DeepEqual(got, empty) {
			t.Fatalf("empty %s round trip = %#v, %v", format, got, err)
		}
	}
}

func TestCasePackageRejectsLegacyUnsupportedAndInvalidRecords(t *testing.T) {
	wrap := func(cases, collections string) string {
		return `{"format":"promptbench-cases","version":1,"cases":` + cases + `,"collections":` + collections + `}`
	}
	for _, tc := range []struct {
		name, content, message string
	}{
		{"legacy-array", `[{"id":"a","variables":{}}]`, "standard JSON package"},
		{"legacy-envelope", `{"cases":[]}`, "legacy packages are not supported"},
		{"name", wrap(`[{"id":"a","name":"legacy","variables":{}}]`, `[]`), `legacy field "name"`},
		{"description", wrap(`[{"id":"a","description":"legacy","variables":{}}]`, `[]`), `legacy field "description"`},
		{"runtime-map", wrap(`[{"id":"a","variables":{"TargetLanguageNameMap":null}}]`, `[]`), "execution-owned"},
		{"unknown-case", wrap(`[{"id":"a","variables":{},"other":1}]`, `[]`), `unsupported field "other"`},
		{"wrong-case", wrap(`[{"ID":"a","variables":{}}]`, `[]`), `unsupported field "ID"`},
		{"missing-variables", wrap(`[{"id":"a"}]`, `[]`), `required field "variables"`},
		{"null-variables", wrap(`[{"id":"a","variables":null}]`, `[]`), "must not be null"},
		{"array-variables", wrap(`[{"id":"a","variables":[]}]`, `[]`), "invalid variables"},
		{"bad-id", wrap(`[{"id":" a","variables":{}}]`, `[]`), "Case id must"},
		{"null-case", wrap(`[null]`, `[]`), "Case must be a JSON object"},
		{"null-cases", wrap(`null`, `[]`), "must not be null"},
		{"collection-extra", wrap(`[]`, `[{"id":"c","name":"C","case_ids":[],"other":1}]`), `unsupported field "other"`},
		{"collection-null", wrap(`[]`, `[{"id":"c","name":"C","case_ids":null}]`), "must not be null"},
		{"collection-blank", wrap(`[]`, `[{"id":"c","name":" ","case_ids":[]}]`), "must not be blank"},
		{"dangling", wrap(`[]`, `[{"id":"c","name":"C","case_ids":["a"]}]`), "unknown file Case id"},
		{"duplicate-members", wrap(`[{"id":"a","variables":{}}]`, `[{"id":"c","name":"C","case_ids":["a","a"]}]`), "unique"},
		{"duplicate-collections", wrap(`[]`, `[{"id":"c","name":"C","case_ids":[]},{"id":"c","name":"D","case_ids":[]}]`), "duplicate collection"},
		{"conflicting-id", wrap(`[{"id":"a","variables":{"n":1}},{"id":"a","variables":{"n":1.0}}]`, `[]`), "different variables"},
		{"unknown-top", `{"format":"promptbench-cases","version":1,"cases":[],"collections":[],"providers":[]}`, `unsupported field "providers"`},
		{"version", `{"format":"promptbench-cases","version":2,"cases":[],"collections":[]}`, "unsupported package"},
		{"second-value", wrap(`[]`, `[]`) + `{}`, "standard JSON package"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseCasePackage("json", tc.content)
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("error = %v; want substring %q", err, tc.message)
			}
		})
	}
	header := `{"type":"package","format":"promptbench-cases","version":1}` + "\n"
	for _, tc := range []struct{ content, message string }{
		{"", "header is required"},
		{`{"id":"a","variables":{}}`, "standard JSONL requires"},
		{`{"type":"case","id":"a","variables":{}}`, "first record"},
		{header + header, "unsupported record type"},
		{header + `{"type":"other"}`, "unsupported record type"},
		{header + `{"type":"case","id":"a","variables":{},"name":"old"}`, "legacy field"},
		{header + `{"type":"case","id":"a","variables":{"TargetLanguageNameMap":{}}}`, "execution-owned"},
		{header + `{"type":"collection","id":"c","name":"C","case_ids":["missing"]}`, "unknown file Case id"},
		{header + `{"type":"case","id":"a","variables":{}} {}`, "one JSON object"},
	} {
		_, err := parseCasePackage("jsonl", tc.content)
		if err == nil || !strings.Contains(err.Error(), tc.message) {
			t.Fatalf("JSONL %q: error = %v; want substring %q", tc.content, err, tc.message)
		}
	}
	// Collections may precede their Cases: validation covers the complete file.
	if _, err := parseCasePackage("jsonl", header+`{"type":"collection","id":"c","name":"C","case_ids":["a"]}`+"\n"+`{"type":"case","id":"a","variables":{}}`); err != nil {
		t.Fatal(err)
	}
}

func TestCasePackageImportMappingAndMembershipIdempotence(t *testing.T) {
	existing := packageTestVariables(t, `{"a":1,"b":{"x":null,"y":[1,2]}}`)
	fresh := packageTestVariables(t, `{"CurrentText":"new","n":1.00}`)
	st := State{Version: 7,
		Cases:       []Case{{ID: "local-first", Variables: existing}, {ID: "local-copy", Variables: existing}},
		Collections: []Collection{{ID: "stable", Name: "Renamed locally", CaseIDs: []string{"local-copy"}}, {ID: "target", Name: "Target", CaseIDs: []string{}}, {ID: "unrelated", Name: "Same name", CaseIDs: []string{}}},
	}
	before := packageTestContent(t, casePackage{Format: casePackageFormat, Version: 1, Cases: st.Cases, Collections: st.Collections}, "json")
	p := casePackage{Format: casePackageFormat, Version: 1,
		Cases:       []Case{{ID: "file-existing", Variables: packageTestVariables(t, `{"b":{"y":[1,2],"x":null},"a":1}`)}, {ID: "file-new", Variables: fresh}, {ID: "file-copy", Variables: fresh}, {ID: "file-new", Variables: fresh}},
		Collections: []Collection{{ID: "stable", Name: "Original name", CaseIDs: []string{"file-existing", "file-new", "file-copy"}}, {ID: "empty", Name: "Same name", CaseIDs: []string{}}},
	}
	plan, err := planCasePackageImport(st, p, []string{"target"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Preview.NewCount != 1 || plan.Preview.ExistingCount != 2 || len(plan.Preview.Cases) != 3 || plan.Preview.CollectionCount != 2 || len(plan.Preview.Warnings) != 0 {
		t.Fatalf("preview = %#v", plan.Preview)
	}
	if plan.CaseIDMap["file-existing"] != "local-first" || plan.CaseIDMap["file-new"] != plan.CaseIDMap["file-copy"] {
		t.Fatalf("ID map = %#v", plan.CaseIDMap)
	}
	newID := plan.CaseIDMap["file-new"]
	if decoded, err := hex.DecodeString(newID); err != nil || len(decoded) != 16 || newID == "file-new" {
		t.Fatalf("new local ID is not a random opaque ID: %q", newID)
	}
	if plan.Preview.Cases[0].LocalID != "local-first" || plan.Preview.Cases[1].LocalID != "" || plan.Preview.Cases[2].LocalID != "" {
		t.Fatalf("preview local IDs = %#v", plan.Preview.Cases)
	}
	wantCollections := []Collection{
		{ID: "stable", Name: "Renamed locally", CaseIDs: []string{"local-copy", "local-first", newID}},
		{ID: "target", Name: "Target", CaseIDs: []string{"local-first", newID}},
		{ID: "unrelated", Name: "Same name", CaseIDs: []string{}},
		{ID: "empty", Name: "Same name", CaseIDs: []string{}},
	}
	if !reflect.DeepEqual(plan.Collections, wantCollections) {
		t.Fatalf("collections = %#v; want %#v", plan.Collections, wantCollections)
	}
	if got := packageTestContent(t, casePackage{Format: casePackageFormat, Version: 1, Cases: st.Cases, Collections: st.Collections}, "json"); got != before {
		t.Fatal("import planning mutated the original state")
	}
	st.Cases = append(st.Cases, plan.NewCases...)
	st.Collections = plan.Collections
	st.Collections[3].Name = "Renamed empty"
	again, err := planCasePackageImport(st, p, []string{"target"})
	if err != nil || again.Preview.NewCount != 0 || again.Preview.ExistingCount != 3 || len(again.NewCases) != 0 || !reflect.DeepEqual(again.CaseIDMap, plan.CaseIDMap) || !reflect.DeepEqual(again.Collections, st.Collections) {
		t.Fatalf("reimport = %#v, %v", again, err)
	}
	if _, err := planCasePackageImport(st, p, []string{"unknown"}); err == nil || !strings.Contains(err.Error(), "target collection") {
		t.Fatalf("unknown target error = %v", err)
	}
}

func TestCasePackageExportMembershipSelection(t *testing.T) {
	st := State{
		Cases:       []Case{{ID: "a", Variables: map[string]any{"x": "a"}}, {ID: "b", Variables: map[string]any{"x": "b"}}, {ID: "c", Variables: map[string]any{"x": "c"}}},
		Collections: []Collection{{ID: "selected", Name: "Selected", CaseIDs: []string{"b", "a"}}, {ID: "shared", Name: "Shared", CaseIDs: []string{"a", "c"}}, {ID: "empty", Name: "Empty", CaseIDs: []string{}}, {ID: "unselected-empty", Name: "No", CaseIDs: []string{}}},
		Providers:   []Provider{{ID: "private", APIKeyEnv: "SECRET_ENV", CredentialRef: "cred_private"}},
		Draft:       Draft{Groups: []Group{{ID: "private-route", LanguageRoutes: []LanguageRoute{{SourceLanguage: "zh", Targets: []Target{{Key: "en", Name: "English"}}}}}}},
	}
	for _, memberships := range []bool{false, true} {
		p, err := exportCasePackage(st, []string{"a", "a"}, []string{"selected", "empty", "selected"}, memberships)
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Cases) != 2 || p.Cases[0].ID != "a" || p.Cases[1].ID != "b" {
			t.Fatalf("selection expanded or reordered: %#v", p.Cases)
		}
		if !memberships && len(p.Collections) != 0 {
			t.Fatalf("unchecked memberships exported collections: %#v", p.Collections)
		}
		if memberships {
			want := []Collection{{ID: "selected", Name: "Selected", CaseIDs: []string{"b", "a"}}, {ID: "shared", Name: "Shared", CaseIDs: []string{"a"}}, {ID: "empty", Name: "Empty", CaseIDs: []string{}}}
			if !reflect.DeepEqual(p.Collections, want) {
				t.Fatalf("memberships = %#v; want %#v", p.Collections, want)
			}
		}
		for _, format := range []string{"json", "jsonl"} {
			content := packageTestContent(t, p, format)
			for _, forbidden := range []string{"providers", "SECRET_ENV", "cred_private", "private-route", "language_routes", "runs", "credentials"} {
				if strings.Contains(content, forbidden) {
					t.Fatalf("%s export leaked %q", format, forbidden)
				}
			}
			if _, err := parseCasePackage(format, content); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, tc := range []struct{ cases, collections []string }{{[]string{"missing"}, nil}, {nil, []string{"missing"}}} {
		if _, err := exportCasePackage(st, tc.cases, tc.collections, false); err == nil {
			t.Fatal("export accepted unknown selection reference")
		}
	}
	p, err := exportCasePackage(st, nil, nil, true)
	if err != nil || len(p.Cases) != 0 || len(p.Collections) != 0 {
		t.Fatalf("empty export = %#v, %v", p, err)
	}
}

func TestCasePackageAPIAtomicityVersionAndRoundTrip(t *testing.T) {
	h := newHarness(t, nil)
	base := h.view()
	p := casePackage{Format: casePackageFormat, Version: 1,
		Cases:       []Case{{ID: "file-a", Variables: packageTestVariables(t, `{"CurrentText":"package-atomic-unique","n":1.00,"nil":null}`)}, {ID: "file-copy", Variables: packageTestVariables(t, `{"nil":null,"n":1.00,"CurrentText":"package-atomic-unique"}`)}},
		Collections: []Collection{{ID: "package-empty", Name: "Empty", CaseIDs: []string{}}, {ID: "package-members", Name: "Members", CaseIDs: []string{"file-a", "file-copy"}}},
	}
	input := casePackageImportInput{StateVersion: base.Version, Format: "json", Content: packageTestContent(t, p, "json")}
	var preview casePackagePreview
	h.api("POST", "/api/cases/import/preview", input, 200, &preview)
	if preview.StateVersion != base.Version || preview.NewCount != 1 || preview.ExistingCount != 1 || len(preview.Cases) != 2 {
		t.Fatalf("preview = %#v", preview)
	}
	if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
		t.Fatal("preview wrote state")
	}
	for _, path := range []string{"/api/cases/import/preview", "/api/cases/import"} {
		bad := input
		bad.StateVersion--
		bad.Format, bad.Content = "invalid", "not JSON"
		h.api("POST", path, bad, 409, nil)
		bad = input
		bad.CollectionIDs = []string{"missing-target"}
		h.api("POST", path, bad, 400, nil)
		bad = input
		broken := p
		broken.Collections = append(append([]Collection{}, p.Collections...), Collection{ID: "bad-late", Name: "Bad", CaseIDs: []string{"missing-file-case"}})
		bad.Content = packageTestContent(t, broken, "json")
		h.api("POST", path, bad, 400, nil)
		broken = p
		broken.Cases = append(append([]Case{}, p.Cases...), Case{ID: "file-a", Variables: map[string]any{"different": true}})
		bad.Content = packageTestContent(t, broken, "json")
		h.api("POST", path, bad, 400, nil)
		if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
			t.Fatalf("failed %s partially committed", path)
		}
	}
	var committed struct {
		State         StateView         `json:"state"`
		NewCount      int               `json:"new_count"`
		ExistingCount int               `json:"existing_count"`
		CaseIDMap     map[string]string `json:"case_id_map"`
		Warnings      []string          `json:"warnings"`
	}
	h.api("POST", "/api/cases/import", input, 200, &committed)
	if committed.State.Version != base.Version+1 || len(committed.State.Cases) != len(base.Cases)+1 || committed.NewCount != 1 || committed.ExistingCount != 1 || committed.Warnings == nil || committed.CaseIDMap["file-a"] != committed.CaseIDMap["file-copy"] || committed.State.Credentials == nil {
		t.Fatalf("commit response = %#v", committed)
	}
	localID := committed.CaseIDMap["file-a"]
	if localID == "file-a" || localID == "" {
		t.Fatalf("file ID was used as new Case ID: %q", localID)
	}
	// Renaming a collection cannot make reimport duplicate it or revert its name.
	var renamed StateView
	h.api("PUT", "/api/collections/package-members", map[string]any{"state_version": committed.State.Version, "name": "Local rename"}, 200, &renamed)
	input.StateVersion = renamed.Version
	input.Format, input.Content = "jsonl", packageTestContent(t, p, "jsonl")
	h.api("POST", "/api/cases/import", input, 200, &committed)
	if committed.NewCount != 0 || committed.ExistingCount != 2 || committed.CaseIDMap["file-a"] != localID || len(committed.State.Cases) != len(base.Cases)+1 || len(committed.State.Collections) != len(base.Collections)+2 {
		t.Fatalf("idempotent reimport = %#v", committed)
	}
	for _, collection := range committed.State.Collections {
		if collection.ID == "package-members" && (collection.Name != "Local rename" || !reflect.DeepEqual(collection.CaseIDs, []string{localID})) {
			t.Fatalf("reimport overwrote collection metadata or duplicated membership: %#v", collection)
		}
	}
	for _, format := range []string{"json", "jsonl"} {
		raw := h.api("POST", "/api/cases/export", map[string]any{"state_version": committed.State.Version, "format": format, "case_ids": []string{localID}, "collection_ids": []string{"package-empty"}, "include_memberships": true}, 200, nil)
		exported, err := parseCasePackage(format, string(raw))
		if err != nil || len(exported.Cases) != 1 || len(exported.Collections) != 2 {
			t.Fatalf("API %s round trip = %#v, %v", format, exported, err)
		}
		raw = h.api("POST", "/api/cases/export", map[string]any{"state_version": committed.State.Version, "format": format, "case_ids": []string{localID}, "collection_ids": []string{"package-empty"}}, 200, nil)
		exported, err = parseCasePackage(format, string(raw))
		if err != nil || len(exported.Cases) != 1 || len(exported.Collections) != 0 {
			t.Fatalf("API unchecked memberships = %#v, %v", exported, err)
		}
	}
}

func TestCasePackageExampleDownloadsAndMethods(t *testing.T) {
	h := newHarness(t, nil)
	before := h.view()
	for _, format := range []string{"json", "jsonl"} {
		resp, err := h.server.Client().Get(h.server.URL + "/api/cases/example?format=" + format)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Disposition"), "."+format) {
			resp.Body.Close()
			t.Fatalf("example response = %d, %v", resp.StatusCode, resp.Header)
		}
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			resp.Body.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		p, err := parseCasePackage(format, string(data))
		if err != nil || len(p.Cases) == 0 || len(p.Collections) != 2 || len(p.Collections[1].CaseIDs) != 0 {
			t.Fatalf("example = %#v, %v", p, err)
		}
	}
	h.api("GET", "/api/cases/example?format=unknown", nil, 400, nil)
	for _, path := range []string{"/api/cases/import/preview", "/api/cases/import", "/api/cases/export"} {
		h.api("GET", path, nil, 405, nil)
	}
	h.api("POST", "/api/cases/example?format=json", map[string]any{}, 405, nil)
	if got := h.view(); !reflect.DeepEqual(got.State, before.State) {
		t.Fatal("example or invalid method changed state")
	}
	a := newAPI(h.store, h.engine, "localhost")
	if a.packageAPI(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://localhost/api/cases", nil)) {
		t.Fatal("package handler consumed a non-package path")
	}
}

func TestCasePackageImportNumberLexemesRemainDistinct(t *testing.T) {
	var records []Case
	for i, literal := range []string{`1`, `1.0`, `1e0`, `"1"`, `true`, `null`, `[]`, `{}`} {
		records = append(records, Case{ID: fmt.Sprintf("file-%d", i), Variables: packageTestVariables(t, `{"value":`+literal+`}`)})
	}
	p := casePackage{Format: casePackageFormat, Version: 1, Cases: records, Collections: []Collection{}}
	for _, format := range []string{"json", "jsonl"} {
		parsed, err := parseCasePackage(format, packageTestContent(t, p, format))
		if err != nil {
			t.Fatal(err)
		}
		plan, err := planCasePackageImport(State{}, parsed, nil)
		if err != nil || plan.Preview.NewCount != len(records) || plan.Preview.ExistingCount != 0 {
			t.Fatalf("%s typed input plan = %#v, %v", format, plan.Preview, err)
		}
		if number, ok := plan.NewCases[1].Variables["value"].(json.Number); !ok || string(number) != "1.0" {
			t.Fatalf("number lexeme lost: %#v", plan.NewCases[1].Variables["value"])
		}
	}
}

func TestCasePackageFileIDNeverUpdatesExistingCase(t *testing.T) {
	old := Case{ID: "same-file-id", Variables: map[string]any{"value": "old"}}
	st := State{Cases: []Case{old}, Collections: []Collection{}}
	p := casePackage{Format: casePackageFormat, Version: 1,
		Cases:       []Case{{ID: old.ID, Variables: map[string]any{"value": "new"}}},
		Collections: []Collection{},
	}
	plan, err := planCasePackageImport(st, p, nil)
	if err != nil || plan.Preview.NewCount != 1 || len(plan.NewCases) != 1 || plan.CaseIDMap[old.ID] == old.ID {
		t.Fatalf("file/local ID collision plan = %#v, %v", plan, err)
	}
	if !reflect.DeepEqual(st.Cases, []Case{old}) || st.Cases[0].Variables["value"] != "old" {
		t.Fatal("file ID collision modified the existing Case")
	}
}

func TestTemplateVariablesImportObjectsAndNumberFidelity(t *testing.T) {
	first := `{"text":"帮我 schedule 一下明天的 meeting。","large":9007199254740993,"decimal":1.00,"nested":{"n":1.2300e+2},"values":[1.0,null,false],"nil":null,"__proto__":{"safe":true}}`
	for _, tc := range []struct {
		name, format, content string
		count                 int
	}{
		{"object", "json", first, 1},
		{"array", "json", "[" + first + ",{}]", 2},
		{"jsonl", "jsonl", "\n" + first + "\n \n{}\n", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := parseCaseImport("variables", tc.format, tc.content)
			if err != nil || len(p.Cases) != tc.count || len(p.Collections) != 0 {
				t.Fatalf("parse = %#v, %v", p, err)
			}
			for i, c := range p.Cases {
				if c.ID != fmt.Sprintf("row-%d", i+1) {
					t.Fatalf("row ID = %q", c.ID)
				}
				for _, key := range []string{"CurrentText", "SourceLanguage", "PriorText", "ReplacementMap"} {
					if _, found := c.Variables[key]; found {
						t.Fatalf("import injected %s into row %d", key, i+1)
					}
				}
			}
			if !reflect.DeepEqual(p.Cases[0].Variables, packageTestVariables(t, first)) {
				t.Fatalf("variables changed: %#v", p.Cases[0].Variables)
			}
			if n, ok := p.Cases[0].Variables["large"].(json.Number); !ok || n.String() != "9007199254740993" {
				t.Fatalf("large number changed: %#v", p.Cases[0].Variables["large"])
			}
			if tc.count == 2 && len(p.Cases[1].Variables) != 0 {
				t.Fatalf("empty variables object changed: %#v", p.Cases[1])
			}
			for _, format := range []string{"json", "jsonl"} {
				roundTrip, err := parseCaseImport("package", format, packageTestContent(t, p, format))
				if err != nil || !reflect.DeepEqual(roundTrip, p) {
					t.Fatalf("%s package round trip = %#v, %v", format, roundTrip, err)
				}
			}
		})
	}
	for _, format := range []string{"json", "jsonl"} {
		rows := []string{`{"value":1}`, `{"value":1.0}`, `{"value":1e0}`, `{}`, `{"PriorText":""}`}
		content := strings.Join(rows, "\n")
		if format == "json" {
			content = "[" + strings.Join(rows, ",") + "]"
		}
		p, err := parseCaseImport("variables", format, content)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := planCasePackageImport(State{}, p, nil)
		if err != nil || plan.Preview.NewCount != len(rows) {
			t.Fatalf("number lexemes or absent/empty fields collapsed: %#v, %v", plan, err)
		}
		for _, row := range plan.Preview.Cases {
			got := packageTestVariables(t, row.VariablesJSON)
			if !reflect.DeepEqual(got, row.Variables) {
				t.Fatalf("variables_json changed values: %s", row.VariablesJSON)
			}
		}
	}
	// Template fields carry no requiredness or string schema. SourceLanguage is
	// the existing optional routing field and remains a string when supplied.
	for _, content := range []string{`{}`, `{"CurrentText":null}`, `{"CurrentText":42}`, `{"CurrentText":false}`, `{"CurrentText":[]}`, `{"CurrentText":{}}`, `{"SourceLanguage":""}`, `{"SourceLanguage":" \n"}`} {
		for _, format := range []string{"json", "jsonl"} {
			if _, err := parseCaseImport("variables", format, content); err != nil {
				t.Errorf("rejected valid variables %s %q: %v", format, content, err)
			}
		}
	}
}

func TestTemplateVariablesImportRejectsInvalidInputs(t *testing.T) {
	for _, content := range []string{"", " ", "null", "true", "42", `"text"`, "[]", "[null]", "[{} , 1]", `{"TargetLanguageNameMap":null}`, `[{},{"TargetLanguageNameMap":{}}]`, `{"SourceLanguage":null}`, `{"SourceLanguage":42}`, "{} {}", "[{}"} {
		if _, err := parseCaseImport("variables", "json", content); err == nil {
			t.Errorf("accepted JSON %q", content)
		}
	}
	for _, content := range []string{"", "\n \n", "null", "[]", "{}\n42", "{} {}\n", "{}\n{\"TargetLanguageNameMap\":{}}", "{}\n{\"SourceLanguage\":false}"} {
		if _, err := parseCaseImport("variables", "jsonl", content); err == nil {
			t.Errorf("accepted JSONL %q", content)
		}
	}
	for _, tc := range []struct{ inputFormat, format string }{{"unknown", "json"}, {"eve-vocat", "json"}, {"variables", "yaml"}, {"", "json"}, {"package", "json"}} {
		if _, err := parseCaseImport(tc.inputFormat, tc.format, `{}`); err == nil {
			t.Errorf("accepted input_format=%q format=%q", tc.inputFormat, tc.format)
		}
	}
	for _, tc := range []struct{ format, content, location string }{
		{"json", `[{},{"SourceLanguage":null}]`, "row 2"},
		{"json", `[{},{"TargetLanguageNameMap":{}}]`, "row 2"},
		{"jsonl", "{}\n\n42", "JSONL line 3"},
		{"jsonl", "{}\n{\"SourceLanguage\":[]}", "JSONL line 2"},
	} {
		if _, err := parseCaseImport("variables", tc.format, tc.content); err == nil || !strings.Contains(err.Error(), tc.location) {
			t.Errorf("missing location %q: %v", tc.location, err)
		}
	}
	broken := State{Templates: []Template{{
		ID: "broken", Name: "Broken template",
		Messages: []Message{{Role: "user", Content: "{{"}},
	}}}
	_, err := importTemplateInputs(broken, casePackageImportInput{InputFormat: "variables", TemplateID: "broken"})
	if err == nil || !strings.Contains(err.Error(), "Broken template") || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("syntax error lost template identity: %v", err)
	}
}

func TestTemplateVariablesAPIGuidanceLosslessAndReuse(t *testing.T) {
	h := newHarness(t, nil)
	s := fixtureState("http://127.0.0.1:1")
	s.Cases, s.Collections, s.Providers = []Case{}, []Collection{}, []Provider{}
	s.Draft = Draft{}
	s.Templates = []Template{
		{ID: "a", Name: "Text", Messages: []Message{{Role: "user", Content: "{{.CurrentText}} / {{.PriorText}}"}}},
		{ID: "b", Name: "Context", Messages: []Message{{Role: "user", Content: "{{.text}} / {{.context}}"}}},
		{ID: "dynamic", Name: "Dynamic", Messages: []Message{{Role: "user", Content: "{{index . .KeyName}}"}}},
		{ID: "structured", Name: "History", Messages: []Message{{Role: "user", Content: "{{range .History}}{{.Content}}{{end}}"}}},
	}
	s = h.save(s)
	base := h.view()
	content := `{"text":"hello","large":9007199254740993,"decimal":1.00,"obj":{"n":1.2300e+2},"nil":null,"__proto__":"safe"}`
	input := casePackageImportInput{StateVersion: base.Version, InputFormat: "variables", TemplateID: "a", Format: "json", Content: "[" + content + "," + content + "]"}
	wantVariables := packageTestVariables(t, content)
	wantJSON, err := caseInputFingerprint(wantVariables)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id      string
		keys    []string
		dynamic bool
	}{
		{"a", []string{"CurrentText", "PriorText"}, false},
		{"b", []string{"context", "text"}, false},
		{"dynamic", []string{"KeyName"}, true},
		{"structured", []string{"History"}, false},
	} {
		input.TemplateID = tc.id
		var preview casePackagePreview
		h.api("POST", "/api/cases/import/preview", input, 200, &preview)
		if preview.StateVersion != base.Version || preview.NewCount != 1 || preview.ExistingCount != 1 || len(preview.Cases) != 2 || preview.TemplateID != tc.id || !reflect.DeepEqual(preview.InputKeys, tc.keys) || preview.DynamicInputs != tc.dynamic {
			t.Fatalf("preview for %s = %#v", tc.id, preview)
		}
		for _, row := range preview.Cases {
			if row.VariablesJSON != wantJSON || !reflect.DeepEqual(row.Variables, wantVariables) {
				t.Fatalf("template %s rewrote variables: %#v", tc.id, row)
			}
		}
	}
	if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
		t.Fatal("template-guided preview wrote state")
	}
	var committed struct {
		State         StateView         `json:"state"`
		NewCount      int               `json:"new_count"`
		ExistingCount int               `json:"existing_count"`
		CaseIDMap     map[string]string `json:"case_id_map"`
	}
	// Even the range template only guides import: the absent History belongs
	// to actual request rendering, not a synthetic import-time Group.
	h.api("POST", "/api/cases/import", input, 200, &committed)
	localID := committed.CaseIDMap["row-1"]
	if committed.NewCount != 1 || committed.ExistingCount != 1 || len(committed.State.Cases) != 1 || localID == "" || localID == "row-1" || localID != committed.CaseIDMap["row-2"] {
		t.Fatalf("commit = %#v", committed)
	}
	if decoded, err := hex.DecodeString(localID); err != nil || len(decoded) != 16 {
		t.Fatalf("local ID is not random opaque ID: %q", localID)
	}
	input.StateVersion, input.TemplateID = committed.State.Version, "b"
	input.Format, input.Content = "jsonl", content+"\n"+content+"\n"
	h.api("POST", "/api/cases/import", input, 200, &committed)
	if committed.NewCount != 0 || committed.ExistingCount != 2 || committed.CaseIDMap["row-1"] != localID || len(committed.State.Cases) != 1 || !reflect.DeepEqual(committed.State.Draft, base.Draft) {
		t.Fatalf("cross-template reimport = %#v", committed)
	}
	for _, format := range []string{"json", "jsonl"} {
		raw := h.api("POST", "/api/cases/export", map[string]any{"state_version": committed.State.Version, "format": format, "case_ids": []string{localID}}, 200, nil)
		exported, err := parseCasePackage(format, string(raw))
		if err != nil || len(exported.Cases) != 1 || !reflect.DeepEqual(exported.Cases[0].Variables, wantVariables) {
			t.Fatalf("%s export changed original input: %#v, %v", format, exported, err)
		}
	}
	input.StateVersion, input.Format, input.Content = committed.State.Version, "json", `[{},{"PriorText":""}]`
	h.api("POST", "/api/cases/import", input, 200, &committed)
	if committed.NewCount != 2 || committed.ExistingCount != 0 || committed.CaseIDMap["row-1"] == committed.CaseIDMap["row-2"] {
		t.Fatalf("missing and explicit empty values collapsed: %#v", committed)
	}
}

func TestTemplateVariablesAPIAtomicityVersionAndTemplateValidation(t *testing.T) {
	h := newHarness(t, nil)
	s := fixtureState("http://127.0.0.1:1")
	s.Providers = []Provider{}
	s.Draft = Draft{}
	s = h.save(s)
	base := h.view()
	input := casePackageImportInput{StateVersion: base.Version, InputFormat: "variables", TemplateID: "t", Format: "json", Content: `{"text":"valid-before-bad"}`}
	for _, path := range []string{"/api/cases/import/preview", "/api/cases/import"} {
		for _, tc := range []struct {
			mode, templateID, format, content string
			status                            int
			message                           string
		}{
			{"variables", "", "json", "invalid", 400, "template_id is required"},
			{"variables", "missing", "json", "invalid", 404, "missing"},
			{"eve-vocat", "t", "json", "invalid", 400, "input_format must be variables or package"},
			{"unknown", "t", "json", "invalid", 400, "input_format must be variables or package"},
			{"package", "t", "json", "invalid", 400, "template_id is only supported for variables import"},
			{"", "t", "json", "invalid", 400, "template_id is only supported for variables import"},
			{"variables", "t", "yaml", "{}", 400, "format must be json or jsonl"},
			{"variables", "t", "json", `[{},null]`, 400, "row 2"},
			{"variables", "t", "jsonl", "{}\n42", 400, "JSONL line 2"},
			{"variables", "t", "json", `[{},{"TargetLanguageNameMap":{}}]`, 400, "row 2"},
			{"variables", "t", "jsonl", "{}\n{\"SourceLanguage\":null}", 400, "SourceLanguage must be a string"},
		} {
			bad := input
			bad.InputFormat, bad.TemplateID, bad.Format, bad.Content = tc.mode, tc.templateID, tc.format, tc.content
			raw := h.api("POST", path, bad, tc.status, nil)
			if !strings.Contains(string(raw), tc.message) {
				t.Fatalf("%s validation = %s, want %q", path, raw, tc.message)
			}
			bad.StateVersion--
			h.api("POST", path, bad, 409, nil)
		}
		bad := input
		bad.CollectionIDs = []string{"missing-target"}
		h.api("POST", path, bad, 400, nil)
		if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
			t.Fatalf("failed %s partially committed", path)
		}
	}
	var preview casePackagePreview
	h.api("POST", "/api/cases/import/preview", input, 200, &preview)
	// Removing the template after preview must be checked again in the atomic
	// commit against its current state, not trusted from a preview response.
	updated := base.State
	updated.Templates = []Template{}
	h.api("PUT", "/api/state", updated, 200, &updated)
	h.api("POST", "/api/cases/import", input, 409, nil)
	input.StateVersion = updated.Version
	h.api("POST", "/api/cases/import", input, 404, nil)
	input.TemplateID = ""
	h.api("POST", "/api/cases/import/preview", input, 400, nil)
	if got := h.view(); !reflect.DeepEqual(got.State, updated) {
		t.Fatal("failed import after template removal changed state")
	}
	// A standard backup still imports with no template, Provider or Group.
	input.InputFormat = "package"
	p := casePackage{Format: casePackageFormat, Version: 1, Cases: []Case{{ID: "backup", Variables: map[string]any{"text": "backup"}}}, Collections: []Collection{}}
	input.Content = packageTestContent(t, p, "json")
	preview = casePackagePreview{}
	h.api("POST", "/api/cases/import/preview", input, 200, &preview)
	if preview.TemplateID != "" || preview.InputKeys != nil || preview.DynamicInputs {
		t.Fatalf("package import acquired template guidance: %#v", preview)
	}
	var response struct {
		State StateView `json:"state"`
	}
	h.api("POST", "/api/cases/import", input, 200, &response)
	if len(response.State.Cases) != len(updated.Cases)+1 || !reflect.DeepEqual(response.State.Draft, updated.Draft) {
		t.Fatalf("package import without template = %#v", response.State)
	}
}

func TestTemplateVariablesAndPackageImportLeaveDraftAndFrozenRunUntouched(t *testing.T) {
	requests := make(chan string, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		requests <- string(raw)
		success(w)
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := fixtureState(provider.URL)
	s.Collections = []Collection{{ID: "selected", Name: "Selected", CaseIDs: []string{"a", "b"}}, {ID: "other", Name: "Other", CaseIDs: []string{"b"}}}
	s.Draft.CaseIDs, s.Draft.CollectionIDs, s.Draft.ExcludedCaseIDs = []string{"b"}, []string{"selected"}, []string{"b"}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s.Metrics = []Metric{{ID: "code", Name: "Code", Kind: "code", ReturnType: "boolean", Code: "function evaluate(){return {value:true}}"}}
	s.Draft.Metrics = []MetricSelection{{MetricID: "code", Target: MetricTarget{Mode: "output"}}}
	s = h.save(s)
	base := h.view()
	selection := Selection{CaseIDs: base.Draft.CaseIDs, CollectionIDs: base.Draft.CollectionIDs, ExcludedCaseIDs: base.Draft.ExcludedCaseIDs}
	var batch Batch
	h.api("POST", "/api/runs", RunInput{StateVersion: base.Version, CaseIDs: selection.CaseIDs, CollectionIDs: selection.CollectionIDs, ExcludedCaseIDs: selection.ExcludedCaseIDs, Groups: base.Draft.Groups, Concurrency: 1}, 202, &batch)
	frozen := h.wait(batch.ID)
	if len(frozen.Snapshot.CaseIDs) != 1 || frozen.Snapshot.CaseIDs[0] != "a" || len(requests) != 1 {
		t.Fatalf("unexpected original frozen run: %#v", frozen.Snapshot)
	}
	var response struct {
		State     StateView         `json:"state"`
		CaseIDMap map[string]string `json:"case_id_map"`
	}
	for _, mode := range []string{"variables", "package"} {
		input := casePackageImportInput{StateVersion: s.Version, InputFormat: mode, Format: "json", CollectionIDs: []string{"other"}}
		if mode == "variables" {
			input.TemplateID, input.Content = "t", `{"text":"variables-only","large":9007199254740993}`
		} else {
			input.Content = packageTestContent(t, casePackage{Format: casePackageFormat, Version: 1, Cases: []Case{{ID: "file", Variables: map[string]any{"text": "package-only"}}}, Collections: []Collection{}}, "json")
		}
		h.api("POST", "/api/cases/import", input, 200, &response)
		s = response.State.State
		resolved, err := resolveSelection(s, selection)
		if err != nil || !reflect.DeepEqual(resolved, []string{"a"}) || !reflect.DeepEqual(s.Draft, base.Draft) {
			t.Fatalf("%s import changed Draft or unselected collection scope: %#v, %v", mode, s.Draft, err)
		}
	}
	input := casePackageImportInput{StateVersion: s.Version, InputFormat: "variables", TemplateID: "t", Format: "json", Content: `{"text":"new-selected-member"}`, CollectionIDs: []string{"selected"}}
	h.api("POST", "/api/cases/import", input, 200, &response)
	selectedID := response.CaseIDMap["row-1"]
	resolved, err := resolveSelection(response.State.State, selection)
	if err != nil || !reflect.DeepEqual(resolved, []string{"a", selectedID}) || !reflect.DeepEqual(response.State.Draft, base.Draft) {
		t.Fatalf("selected collection append did not preserve Draft IDs: %#v, %v", response.State.Draft, err)
	}
	for _, path := range []string{"/api/runs/" + batch.ID, "/api/runs/" + batch.ID + "/export"} {
		var current Detail
		h.api("GET", path, nil, 200, &current)
		if !reflect.DeepEqual(current.Snapshot, frozen.Snapshot) || !reflect.DeepEqual(current.Results, frozen.Results) {
			t.Fatal("import changed an already frozen run")
		}
	}
	if len(requests) != 1 {
		t.Fatal("import issued a model request")
	}
}
