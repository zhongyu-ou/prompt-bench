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

func TestEveVocatImportObjectsAndNumberFidelity(t *testing.T) {
	first := `{"CurrentText":"帮我 schedule 一下明天的 meeting。","SourceLanguage":"zh-CN","PriorText":"","ReplacementMap":"","large":9007199254740993,"nested":{"n":1.2300e+2},"values":[1.0,null]}`
	second := `{"CurrentText":"second","SourceLanguage":"en"}`
	for _, tc := range []struct {
		name, format, content string
		count                 int
	}{
		{"object", "json", first, 1},
		{"array", "json", "[" + first + "," + second + "]", 2},
		{"jsonl", "jsonl", "\n" + first + "\n \n" + second + "\n", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := parseCaseImport("eve-vocat", tc.format, tc.content)
			if err != nil || len(p.Cases) != tc.count || len(p.Collections) != 0 {
				t.Fatalf("parse = %#v, %v", p, err)
			}
			for i, c := range p.Cases {
				if c.ID != fmt.Sprintf("row-%d", i+1) {
					t.Fatalf("row ID = %q", c.ID)
				}
			}
			if p.Cases[len(p.Cases)-1].Variables["PriorText"] != "" || p.Cases[len(p.Cases)-1].Variables["ReplacementMap"] != "" {
				t.Fatal("missing optional fields were not defaulted to empty strings")
			}
			if !reflect.DeepEqual(p.Cases[0].Variables, packageTestVariables(t, first)) {
				t.Fatalf("variables changed: %#v", p.Cases[0].Variables)
			}
			if n, ok := p.Cases[0].Variables["large"].(json.Number); !ok || n.String() != "9007199254740993" {
				t.Fatalf("large number changed: %#v", p.Cases[0].Variables["large"])
			}
			encoded := packageTestContent(t, p, "json")
			roundTrip, err := parseCaseImport("package", "json", encoded)
			if err != nil || !reflect.DeepEqual(roundTrip, p) {
				t.Fatalf("package round trip = %#v, %v", roundTrip, err)
			}
		})
	}
	for _, format := range []string{"json", "jsonl"} {
		rows := []string{
			`{"CurrentText":"same","SourceLanguage":"en","value":1}`,
			`{"CurrentText":"same","SourceLanguage":"en","value":1.0}`,
			`{"CurrentText":"same","SourceLanguage":"en","value":1e0}`,
		}
		content := strings.Join(rows, "\n")
		if format == "json" {
			content = "[" + strings.Join(rows, ",") + "]"
		}
		p, err := parseCaseImport("eve-vocat", format, content)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := planCasePackageImport(State{}, p, nil)
		if err != nil || plan.Preview.NewCount != 3 {
			t.Fatalf("number lexemes collapsed: %#v, %v", plan, err)
		}
	}
}

func TestEveVocatImportRejectsInvalidInputs(t *testing.T) {
	for _, content := range []string{"", " ", "null", "true", "42", `"text"`, "[]", "[null]", "[{} , 1]", `{"TargetLanguageNameMap":null}`, `[{},{"TargetLanguageNameMap":{}}]`, "{} {}", "[{}"} {
		if _, err := parseCaseImport("eve-vocat", "json", content); err == nil {
			t.Errorf("accepted JSON %q", content)
		}
	}
	for _, content := range []string{"", "\n \n", "null", "[]", "{}\n42", "{} {}\n", "{}\n{\"TargetLanguageNameMap\":{}}"} {
		if _, err := parseCaseImport("eve-vocat", "jsonl", content); err == nil {
			t.Errorf("accepted JSONL %q", content)
		}
	}
	for _, tc := range []struct{ inputFormat, format string }{{"unknown", "json"}, {"eve-vocat", "yaml"}, {"", "json"}, {"package", "json"}} {
		if _, err := parseCaseImport(tc.inputFormat, tc.format, `{}`); err == nil {
			t.Errorf("accepted input_format=%q format=%q", tc.inputFormat, tc.format)
		}
	}
	for _, content := range []string{
		`{}`,
		`{"CurrentText":"text"}`,
		`{"SourceLanguage":"en"}`,
		`{"CurrentText":"","SourceLanguage":"en"}`,
		`{"CurrentText":" \n","SourceLanguage":"en"}`,
		`{"CurrentText":null,"SourceLanguage":"en"}`,
		`{"CurrentText":42,"SourceLanguage":"en"}`,
		`{"CurrentText":"text","SourceLanguage":" "}`,
		`{"CurrentText":"text","SourceLanguage":null}`,
		`{"CurrentText":"text","SourceLanguage":42}`,
	} {
		for _, format := range []string{"json", "jsonl"} {
			if _, err := parseCaseImport("eve-vocat", format, content); err == nil {
				t.Errorf("accepted missing/invalid required field: %s %q", format, content)
			}
		}
	}
}

func TestEveVocatAPIAtomicityDedupAndStaleVersion(t *testing.T) {
	h := newHarness(t, nil)
	base := h.view()
	input := casePackageImportInput{
		StateVersion: base.Version, InputFormat: "eve-vocat", Format: "json",
		Content: `[{"CurrentText":"raw-import-unique","SourceLanguage":"en","n":1.00},{"n":1.00,"CurrentText":"raw-import-unique","SourceLanguage":"en","PriorText":"","ReplacementMap":""}]`,
	}
	var preview casePackagePreview
	h.api("POST", "/api/cases/import/preview", input, 200, &preview)
	if preview.NewCount != 1 || preview.ExistingCount != 1 || len(preview.Cases) != 2 || preview.Cases[0].FileID != "row-1" || preview.Cases[1].FileID != "row-2" {
		t.Fatalf("preview = %#v", preview)
	}
	if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
		t.Fatal("preview wrote state")
	}
	for _, path := range []string{"/api/cases/import/preview", "/api/cases/import"} {
		for _, content := range []string{`[{"CurrentText":"valid-before-bad","SourceLanguage":"en"},null]`, `[{"CurrentText":"valid-before-bad","SourceLanguage":"en"},{"CurrentText":"missing-language"}]`, `[{},{"TargetLanguageNameMap":{}}]`} {
			bad := input
			bad.Content = content
			h.api("POST", path, bad, 400, nil)
		}
		bad := input
		bad.CollectionIDs = []string{"missing-target"}
		h.api("POST", path, bad, 400, nil)
		bad = input
		bad.StateVersion--
		bad.InputFormat, bad.Content = "unknown", "invalid"
		h.api("POST", path, bad, 409, nil)
		if got := h.view(); !reflect.DeepEqual(got.State, base.State) {
			t.Fatalf("failed %s wrote state", path)
		}
	}
	var committed struct {
		State         StateView         `json:"state"`
		NewCount      int               `json:"new_count"`
		ExistingCount int               `json:"existing_count"`
		CaseIDMap     map[string]string `json:"case_id_map"`
	}
	h.api("POST", "/api/cases/import", input, 200, &committed)
	localID := committed.CaseIDMap["row-1"]
	if committed.NewCount != 1 || committed.ExistingCount != 1 || len(committed.State.Cases) != len(base.Cases)+1 || localID == "" || localID == "row-1" || localID != committed.CaseIDMap["row-2"] {
		t.Fatalf("commit = %#v", committed)
	}
	if decoded, err := hex.DecodeString(localID); err != nil || len(decoded) != 16 {
		t.Fatalf("local ID is not random opaque ID: %q", localID)
	}
	for _, path := range []string{"/api/cases/import/preview", "/api/cases/import"} {
		h.api("POST", path, input, 409, nil)
	}
	input.StateVersion = committed.State.Version
	input.Format, input.Content = "jsonl", "{\"CurrentText\":\"raw-import-unique\",\"SourceLanguage\":\"en\",\"n\":1.00}\n{\"n\":1.00,\"CurrentText\":\"raw-import-unique\",\"SourceLanguage\":\"en\"}\n"
	h.api("POST", "/api/cases/import", input, 200, &committed)
	if committed.NewCount != 0 || committed.ExistingCount != 2 || committed.CaseIDMap["row-1"] != localID || len(committed.State.Cases) != len(base.Cases)+1 {
		t.Fatalf("reimport = %#v", committed)
	}
}
