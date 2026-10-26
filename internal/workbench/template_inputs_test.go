package workbench

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTemplateInputsScopeAndDynamicReferences(t *testing.T) {
	tests := []struct {
		name    string
		content string
		keys    string
		dynamic bool
	}{
		{
			name: "top-level keys only",
			content: `{{.CurrentText}}{{if .PriorText}}{{.PriorText}}{{end}}` +
				`{{range $k, $v := .History}}{{.Content}}{{$v.Content}}{{$k}}{{$.Tenant}}{{end}}` +
				`{{with .Context}}{{.Name}}{{end}}{{$root := .}}{{$root.Locale}}` +
				`{{index . "custom-key"}}{{range .TargetLanguageNameMap}}{{.}}{{end}}`,
			keys: "Context,CurrentText,History,Locale,PriorText,Tenant,custom-key",
		},
		{name: "nested fields and chain", content: `{{.Context.Name}}{{$.Context.Deep.Name}}{{(index . "Context").Name}}`, keys: "Context"},
		{name: "field alias", content: `{{$ctx := .Context}}{{$ctx.Name}}{{index $ctx "other"}}`, keys: "Context"},
		{name: "root alias and constant pipeline", content: `{{$root := .}}{{index $root "x-y"}}{{"z" | index .}}`, keys: "x-y,z"},
		{name: "constant key alias", content: `{{$key := "x-y"}}{{index . $key}}`, keys: "x-y"},
		{name: "with preserves root", content: `{{with .}}{{.Name}}{{end}}`, keys: "Name"},
		{name: "with else restores dot", content: `{{with .Context}}{{.Name}}{{else}}{{.Fallback}}{{end}}`, keys: "Context,Fallback"},
		{name: "range else restores dot", content: `{{range .Items}}{{.Content}}{{else}}{{.Fallback}}{{end}}`, keys: "Fallback,Items"},
		{name: "nested range else", content: `{{with .Context}}{{range .Items}}{{.Content}}{{else}}{{.Name}}{{end}}{{end}}`, keys: "Context"},
		{name: "if keeps dot", content: `{{if .Flag}}{{.Yes}}{{else}}{{.No}}{{end}}`, keys: "Flag,No,Yes"},
		{name: "if declaration", content: `{{if $root := .}}{{$root.Name}}{{else}}{{$root.Other}}{{end}}`, keys: "Name,Other"},
		{name: "lexical shadowing", content: `{{$root := .}}{{if .Flag}}{{$root := .Context}}{{$root.Name}}{{end}}{{$root.Locale}}`, keys: "Context,Flag,Locale"},
		{name: "assignment updates nearest shadow", content: `{{$x := .Context}}{{if .Flag}}{{$x := .Other}}{{$x = $}}{{$x.Inner}}{{end}}{{$x.Name}}`, keys: "Context,Flag,Inner,Other"},
		{name: "same branch assignments", content: `{{$x := .Context}}{{if .Flag}}{{$x = $}}{{else}}{{$x = $}}{{end}}{{$x.Name}}`, keys: "Context,Flag,Name"},
		{name: "conflicting branch assignments", content: `{{$x := .Context}}{{if .Flag}}{{$x = $}}{{else}}{{$x = $.Context}}{{end}}{{$x.Name}}`, keys: "Context,Flag", dynamic: true},
		{name: "implicit else assignment", content: `{{$x := .Context}}{{if .Flag}}{{$x = $}}{{end}}{{$x.Name}}`, keys: "Context,Flag", dynamic: true},
		{name: "with branch assignment", content: `{{$x := .Context}}{{with .Other}}{{$x = $}}{{else}}{{$x = .Context}}{{end}}{{$x.Name}}`, keys: "Context,Other", dynamic: true},
		{name: "range assignment zero path", content: `{{$x := .Context}}{{range .Items}}{{$x = $}}{{end}}{{$x.Name}}`, keys: "Context,Items", dynamic: true},
		{name: "range assignment variables", content: `{{$x := .Context}}{{range $x = .Items}}{{$x.Name}}{{end}}{{$x.Name}}`, keys: "Context,Items", dynamic: true},
		{name: "later range iterations", content: `{{$x := .Context}}{{range .Items}}{{$x.Name}}{{$x = $}}{{end}}`, keys: "Context,Items", dynamic: true},
		{name: "range shadow does not escape", content: `{{$x := .}}{{range $x := .Items}}{{$x.Name}}{{end}}{{$x.Tenant}}`, keys: "Items,Tenant"},
		{name: "static range break", content: `{{range .Items}}{{.Content}}{{break}}{{end}}{{.Tenant}}`, keys: "Items,Tenant"},
		{name: "early loop exit assignment", content: `{{$x := .Context}}{{range .Items}}{{$x = $}}{{break}}{{$x = $.Context}}{{end}}{{$x.Name}}`, keys: "Context,Items", dynamic: true},
		{name: "dynamic index", content: `{{index . .KeyName}}`, keys: "KeyName", dynamic: true},
		{name: "dynamic root alias index", content: `{{$root := .}}{{with .Context}}{{index $root .KeyName}}{{end}}`, keys: "Context", dynamic: true},
		{name: "root output", content: `{{.}}`, dynamic: true},
		{name: "root traversal still visits body", content: `{{range .}}{{.Content}}{{$.Tenant}}{{end}}`, keys: "Tenant", dynamic: true},
		{name: "root passed to formatter", content: `{{printf "%v" .}}`, dynamic: true},
		{name: "builtins do not become keys", content: `{{printf "%s" .Text}}{{len .Items}}{{if eq .Flag true}}{{.Yes}}{{end}}`, keys: "Flag,Items,Text,Yes"},
		{name: "system key via index", content: `{{index . "TargetLanguageNameMap"}}`, keys: ""},
		{name: "comments and literals", content: `{{/* {{.Fake}} */}}{{".AlsoFake"}}plain .NotATemplate`, keys: ""},
		{name: "empty", content: " \n\t", keys: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inputs, err := templateInputs(Template{ID: "t", Name: "Scope", Messages: []Message{{Role: "user", Content: test.content}}})
			if err != nil {
				t.Fatal(err)
			}
			if inputs.Keys == nil || strings.Join(inputs.Keys, ",") != test.keys || inputs.Dynamic != test.dynamic {
				t.Fatalf("inputs = %#v, want keys %q dynamic=%v", inputs, test.keys, test.dynamic)
			}
		})
	}
}

func TestTemplateInputsNamedTemplatesStayWithinMessage(t *testing.T) {
	tests := []struct {
		name     string
		messages []string
		keys     string
		dynamic  bool
	}{
		{name: "root argument", messages: []string{`{{define "part"}}{{.Text}}{{$.Tenant}}{{end}}{{template "part" .}}`}, keys: "Tenant,Text"},
		{name: "field argument resets dollar", messages: []string{`{{define "part"}}{{.Name}}{{$.Tenant}}{{end}}{{template "part" .Context}}`}, keys: "Context"},
		{name: "no argument is nil", messages: []string{`{{define "part"}}{{.Hidden}}{{$.Tenant}}{{end}}{{template "part"}}`}},
		{name: "unused definition", messages: []string{`{{define "unused"}}{{.Hidden}}{{end}}{{.Visible}}`}, keys: "Visible"},
		{name: "repeated invocation is not recursion", messages: []string{`{{define "part"}}{{.Text}}{{end}}{{template "part" .}}{{template "part" .}}`}, keys: "Text"},
		{name: "range passes element as dollar", messages: []string{`{{define "part"}}{{$.Name}}{{end}}{{range .Items}}{{template "part" .}}{{end}}`}, keys: "Items"},
		{name: "range can pass root", messages: []string{`{{define "part"}}{{$.Tenant}}{{end}}{{range .Items}}{{template "part" $}}{{end}}`}, keys: "Items,Tenant"},
		{name: "range noarg does not inherit dot", messages: []string{`{{define "part"}}{{$.Hidden}}{{end}}{{range .Items}}{{template "part"}}{{end}}`}, keys: "Items"},
		{name: "missing definition", messages: []string{`{{.Known}}{{template "missing" .}}`}, keys: "Known", dynamic: true},
		{name: "definitions not shared across messages", messages: []string{`{{define "private"}}{{.Hidden}}{{end}}`, `{{template "private" .}}`}, dynamic: true},
		{name: "recursive same root", messages: []string{`{{define "part"}}{{.Leaf}}{{template "part" .}}{{end}}{{template "part" .}}`}, keys: "Leaf", dynamic: true},
		{name: "recursive changing dot", messages: []string{`{{define "part"}}{{.Leaf}}{{template "part" .Next}}{{end}}{{template "part" .}}`}, keys: "Leaf,Next", dynamic: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tmpl := Template{ID: "t", Name: "Named"}
			for _, content := range test.messages {
				tmpl.Messages = append(tmpl.Messages, Message{Role: "user", Content: content})
			}
			inputs, err := templateInputs(tmpl)
			if err != nil {
				t.Fatal(err)
			}
			if inputs.Keys == nil || strings.Join(inputs.Keys, ",") != test.keys || inputs.Dynamic != test.dynamic {
				t.Fatalf("inputs = %#v, want keys %q dynamic=%v", inputs, test.keys, test.dynamic)
			}
		})
	}
}

func TestTemplateInputsCompiledMessagesPreserveNativeSemantics(t *testing.T) {
	tmpl := Template{ID: "t", Name: "Ordered", Messages: []Message{
		{Role: "system", Content: "before \n{{- if .Text }}{{.Text}}{{end}}"},
		{Role: "user", Content: `{{define "part"}}local {{.Text}}{{end}}{{template "part" .}}`},
	}}
	compiled, err := compilePrompt(tmpl)
	if err != nil {
		t.Fatal(err)
	}
	if len(compiled.messages) != len(tmpl.Messages) {
		t.Fatalf("compiled %d messages, want %d", len(compiled.messages), len(tmpl.Messages))
	}
	for i, want := range []string{"beforehello", "local hello"} {
		var out bytes.Buffer
		if err := compiled.messages[i].Execute(&out, map[string]any{"Text": "hello"}); err != nil || out.String() != want {
			t.Fatalf("message %d = %q, %v; want %q", i, out.String(), err, want)
		}
	}
	for _, message := range []Message{{Content: "text"}, {Role: "user", Content: "{{if}}"}} {
		if _, err := compilePrompt(Template{Name: "Invalid", Messages: []Message{message}}); err == nil || !strings.Contains(err.Error(), "Invalid message 1") {
			t.Fatalf("invalid message error = %v", err)
		}
	}
}

func TestTemplateInputsAPIIsReadOnlyAndTemplateLocal(t *testing.T) {
	h := newHarness(t, nil)
	s := fixtureState("http://127.0.0.1:1")
	s.Cases, s.Collections, s.Providers = []Case{}, []Collection{}, []Provider{}
	s.Draft.CaseIDs, s.Draft.Groups = nil, nil
	s.Templates = []Template{
		{ID: "a", Name: "A", Messages: []Message{{Role: "user", Content: `{{.PriorText}}{{.CurrentText}}`}}},
		{ID: "b", Name: "B", Messages: []Message{{Role: "user", Content: `{{.text}}{{.context}}`}}},
		{ID: "empty", Name: "Empty", Messages: []Message{{Role: "user", Content: " \n\t"}}},
		{ID: "dynamic", Name: "Dynamic", Messages: []Message{{Role: "user", Content: `{{index . .KeyName}}`}}},
	}
	s = h.save(s)
	var before []byte
	if err := h.store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id, keys, example string
		dynamic           bool
	}{
		{"a", "CurrentText,PriorText", "{\n  \"CurrentText\": \"\",\n  \"PriorText\": \"\"\n}", false},
		{"b", "context,text", "{\n  \"context\": \"\",\n  \"text\": \"\"\n}", false},
		{"empty", "", "{}", false},
		{"dynamic", "KeyName", "{\n  \"KeyName\": \"\"\n}", true},
	} {
		var out struct {
			StateVersion int64  `json:"state_version"`
			TemplateID   string `json:"template_id"`
			TemplateInputs
			ExampleJSON string `json:"example_json"`
		}
		h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version, "template_id": test.id}, 200, &out)
		if out.StateVersion != s.Version || out.TemplateID != test.id || out.Keys == nil || strings.Join(out.Keys, ",") != test.keys || out.Dynamic != test.dynamic || out.ExampleJSON != test.example {
			t.Fatalf("template %s inputs = %#v", test.id, out)
		}
	}
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version}, 400, nil)
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version, "template_id": "unknown"}, 404, nil)
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version - 1}, 409, nil)
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version - 1, "template_id": "unknown"}, 409, nil)
	h.api("GET", "/api/templates/inputs", nil, 405, nil)
	var after []byte
	if err := h.store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("read-only template inputs changed stored state")
	}
}

func TestTemplateInputsAPIRejectsInvalidStoredTemplateAndStorageFailure(t *testing.T) {
	h := newHarness(t, nil)
	s, err := h.store.state()
	if err != nil {
		t.Fatal(err)
	}
	// Install a malformed historical fixture; public saves correctly reject it.
	s.Templates = []Template{{ID: "bad", Name: "Broken template", Messages: []Message{{Role: "user", Content: "{{if}}"}}}}
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec("UPDATE state SET data=$1 WHERE id=1", raw); err != nil {
		t.Fatal(err)
	}
	body := h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version, "template_id": "bad"}, 400, nil)
	if !bytes.Contains(body, []byte("Broken template")) {
		t.Fatalf("syntax error lost template identity: %s", body)
	}
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version - 1, "template_id": "bad"}, 409, nil)
	h.store.close()
	h.api("POST", "/api/templates/inputs", map[string]any{"state_version": s.Version, "template_id": "bad"}, 500, nil)
}

func TestTemplateInputsRenderDefaultsPreservePresentValuesAndCase(t *testing.T) {
	s := fixtureState("http://127.0.0.1:1")
	s.Cases[0].Variables = map[string]any{
		"CurrentText": "你好", "zero": json.Number("0"), "false": false, "nil": nil, "empty": "",
		"object": map[string]any{"value": "nested"}, "array": []any{json.Number("1"), "x"},
		"large": json.Number("9007199254740993"), "literal": "<no value>",
	}
	s.Templates[0].Messages = []Message{{Role: "user", Content: `{{.CurrentText}}|{{.PriorText}}|{{if .PriorText}}yes{{else}}no{{end}}|{{printf "%T:%v" .zero .zero}}|{{printf "%T:%v" .false .false}}|{{printf "%T" .nil}}|{{printf "%q" .empty}}|{{index .object "value"}}|{{range .array}}{{.}}{{end}}|{{.large}}|{{.literal}}`}}
	before := mustJSON(t, s.Cases[0].Variables)
	frozen, err := renderRequest(s, "a", s.Draft.Groups[0])
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Messages []Message `json:"messages"`
	}
	if err := json.Unmarshal(frozen.Request, &request); err != nil {
		t.Fatal(err)
	}
	want := `你好||no|json.Number:0|bool:false|<nil>|""|nested|1x|9007199254740993|<no value>`
	if len(request.Messages) != 1 || request.Messages[0].Content != want {
		t.Fatalf("rendered messages = %#v, want %q", request.Messages, want)
	}
	if mustJSON(t, s.Cases[0].Variables) != before {
		t.Fatal("rendering mutated original or nested Case variables")
	}
	if _, ok := s.Cases[0].Variables["PriorText"]; ok {
		t.Fatal("missing-key default escaped the rendering copy")
	}
}

func TestTemplateInputsRenderComplexAndDynamicBoundaries(t *testing.T) {
	for _, test := range []struct {
		name, content, want, errorText string
		variables                      map[string]any
	}{
		{name: "explicit empty list", content: `{{range .History}}{{.Content}}{{end}}`, variables: map[string]any{"History": []any{}}, want: ""},
		{name: "missing list is not guessed", content: `{{range .History}}{{.Content}}{{end}}`, variables: map[string]any{}, errorText: "range can't iterate"},
		{name: "null list stays null", content: `{{range .History}}{{.Content}}{{end}}`, variables: map[string]any{"History": nil}, want: ""},
		{name: "string list fails natively", content: `{{range .History}}{{.Content}}{{end}}`, variables: map[string]any{"History": "bad"}, errorText: "range can't iterate"},
		{name: "nested structure supplied", content: `{{.Context.Name}}`, variables: map[string]any{"Context": map[string]any{"Name": "nested"}}, want: "nested"},
		{name: "nested missing retains Go semantics", content: `{{.Context.Name}}`, variables: map[string]any{"Context": map[string]any{}}, want: "<no value>"},
		{name: "nested tree is not constructed", content: `{{.Context.Name}}`, variables: map[string]any{}, errorText: "can't evaluate field Name"},
		{name: "dynamic missing retains Go semantics", content: `{{index . .KeyName}}`, variables: map[string]any{"KeyName": "missing"}, want: "<no value>"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := fixtureState("http://127.0.0.1:1")
			s.Cases[0].Variables = test.variables
			s.Templates[0].Messages = []Message{{Role: "user", Content: test.content}}
			frozen, err := renderRequest(s, "a", s.Draft.Groups[0])
			if test.errorText != "" {
				if err == nil || !strings.Contains(err.Error(), test.errorText) {
					t.Fatalf("render error = %v, want %q", err, test.errorText)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var request struct {
				Messages []Message `json:"messages"`
			}
			if err := json.Unmarshal(frozen.Request, &request); err != nil {
				t.Fatal(err)
			}
			if len(request.Messages) != 1 || request.Messages[0].Content != test.want {
				t.Fatalf("rendered messages = %#v, want %q", request.Messages, test.want)
			}
		})
	}
}

func TestTemplateInputsPreviewEqualsSentDefaultsWithoutPersistingThem(t *testing.T) {
	calls := make(chan string, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		calls <- string(raw)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "fixture output"}}}})
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := fixtureState(provider.URL)
	s.Cases = []Case{{ID: "a", Variables: map[string]any{"CurrentText": "你好"}}}
	s.Templates[0].Messages = []Message{{Role: "user", Content: `{{.CurrentText}}|{{.PriorText}}|{{if .PriorText}}yes{{else}}no{{end}}`}}
	s.Draft.CaseIDs = []string{"a"}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s = h.save(s)
	var preview struct {
		Request    json.RawMessage `json:"request"`
		RawRequest string          `json:"raw_request"`
		PromptHash string          `json:"prompt_hash"`
	}
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": s.Draft.Groups[0]}, 200, &preview)
	if !strings.Contains(preview.RawRequest, "你好||no") {
		t.Fatalf("preview did not render missing text empty: %s", preview.RawRequest)
	}
	var batch Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &batch)
	detail := h.wait(batch.ID)
	if detail.Batch.Completed != 1 || detail.Batch.Failed != 0 || len(detail.Results) != 1 {
		t.Fatalf("generation failed: %#v", detail.Batch)
	}
	result := detail.Results[0]
	if sent := <-calls; sent != preview.RawRequest || result.RawRequest != sent || result.PromptHash != preview.PromptHash || !bytes.Equal(result.Request, preview.Request) {
		t.Fatalf("preview/sent/persisted request drift: preview=%s result=%s sent=%s", preview.RawRequest, result.RawRequest, sent)
	}
	var state State
	h.api("GET", "/api/state", nil, 200, &state)
	if mustJSON(t, state.Cases[0].Variables) != `{"CurrentText":"你好"}` {
		t.Fatalf("rendering default persisted into Case: %s", mustJSON(t, state.Cases[0].Variables))
	}
	raw := h.api("POST", "/api/cases/export", map[string]any{"state_version": state.Version, "format": "json", "case_ids": []string{"a"}}, 200, nil)
	if bytes.Contains(raw, []byte("PriorText")) {
		t.Fatalf("rendering default leaked into export: %s", raw)
	}
}

func TestTemplateInputsFreezeRejectsStructureBeforeAnyProviderRequest(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{}})
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := fixtureState(provider.URL)
	s.Cases = []Case{{ID: "a", Variables: map[string]any{"History": []any{}}}, {ID: "b", Variables: map[string]any{}}}
	s.Templates[0].Messages = []Message{{Role: "user", Content: `{{range .History}}{{.Content}}{{end}}`}}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s = h.save(s)
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "a", "group": s.Draft.Groups[0]}, 200, nil)
	h.api("POST", "/api/preview", map[string]any{"state_version": s.Version, "case_id": "b", "group": s.Draft.Groups[0]}, 400, nil)
	body := h.api("POST", "/api/runs", runInput(s, 1), 400, nil)
	if !bytes.Contains(body, []byte("range can't iterate")) || calls.Load() != 0 {
		t.Fatalf("freeze must fail before outbound calls: calls=%d, response=%s", calls.Load(), body)
	}
}
