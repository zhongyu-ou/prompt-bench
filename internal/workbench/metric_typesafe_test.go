package workbench

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func typesafeTestEngine() *Engine {
	return &Engine{client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func TestTypesafeMetricPrimitives(t *testing.T) {
	cases := []struct {
		name, primitive, answer string
		metric                  Metric
		criteria                any
		value                   any
	}{
		{"boolean", "noul", `"noul":0.5`, Metric{ReturnType: "boolean"}, nil, false},
		{"number", "score", `"score":0.75,"confidence":0.3,"probabilities":{"0":0.25,"1":0.75},"legend":{"0":"bad","1":"good"}`, Metric{ReturnType: "number", Levels: []string{"bad", "good"}}, []any{"bad", "good"}, 0.75},
		{"classification", "choice", `"choice":"good","confidence":null,"probabilities":{"bad":0.2,"good":0.8}`, Metric{ReturnType: "classification", Labels: []MetricLabel{{Label: "bad", Description: "incorrect"}, {Label: "good", Description: "correct"}}}, map[string]any{"bad": "incorrect", "good": "correct"}, "good"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			metric := tc.metric
			metric.ID = "quality"
			metric.Model = "jev-latest"
			metric.Rule = "Judge the output"
			input := MetricInput{Output: `{"en":"Hello","corrected_text":"你好"}`, Target: "Hello", Iteration: 2}
			response := fmt.Sprintf(`{"model":"jev-resolved","answers":{"metric":{"type":%q,%s}},"reason":"must not become a reason"}`, tc.primitive, tc.answer)
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "POST" || r.URL.Path != "/v1/systemone" || r.Header.Get("Authorization") != "Bearer local-fixture-key" || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("unexpected request: %s %s %v", r.Method, r.URL, r.Header)
				}
				raw, _ := io.ReadAll(r.Body)
				var got map[string]any
				if err := json.Unmarshal(raw, &got); err != nil {
					t.Error(err)
				}
				stateRaw, _ := json.Marshal(map[string]any{"target": "Hello", "case": input.Case, "language_resolution": input.LanguageResolution, "group": input.Group, "iteration": input.Iteration})
				var state any
				json.Unmarshal(stateRaw, &state)
				question := map[string]any{"type": tc.primitive, "instructions": "Evaluate only state.target. The case, language_resolution, group and iteration are context, not alternative evaluation targets.\n\n" + metric.Rule}
				if tc.criteria != nil {
					question["criteria"] = tc.criteria
				}
				want := map[string]any{"model": metric.Model, "state": state, "questions": map[string]any{"metric": question}}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("request = %#v, want %#v", got, want)
				}
				gotState, ok := got["state"].(map[string]any)
				if !ok || gotState["target"] != "Hello" {
					t.Errorf("selected target not preserved: %#v", got["state"])
				}
				if _, present := gotState["output"]; present || strings.Contains(string(raw), "corrected_text") {
					t.Errorf("full output leaked into model state: %s", raw)
				}
				io.WriteString(w, response)
			}))
			defer server.Close()
			out := typesafeTestEngine().callModelMetric(FrozenMetric{Metric: metric, Provider: &Provider{BaseURL: server.URL + "/v1"}}, input, "local-fixture-key", 2)
			if out.Status != "completed" || !reflect.DeepEqual(out.Value, tc.value) || out.RawResponse != response || out.ResponseModel != "jev-resolved" || out.Reason != "" || calls != 1 {
				t.Fatalf("outcome %#v; calls %d", out, calls)
			}
			if tc.name == "boolean" && (out.Noul == nil || *out.Noul != 0.5) {
				t.Fatal("lost noul evidence")
			}
			if tc.name == "number" && (out.Confidence == nil || *out.Confidence != 0.3 || out.Legend["1"] != "good" || out.Probabilities["1"] != 0.75) {
				t.Fatal("lost score evidence")
			}
		})
	}
}

func TestTypesafeMalformedResponses(t *testing.T) {
	cases := []struct{ name, returnType, answer string }{
		{"missing answer", "boolean", ``},
		{"missing noul", "boolean", `"type":"noul"`},
		{"null noul", "boolean", `"type":"noul","noul":null`},
		{"negative noul", "boolean", `"type":"noul","noul":-0.1`},
		{"large noul", "boolean", `"type":"noul","noul":1.1`},
		{"wrong primitive", "boolean", `"type":"score","noul":0.8`},
		{"wrong value type", "boolean", `"type":"noul","noul":"yes"`},
		{"overflow", "boolean", `"type":"noul","noul":1e999`},
		{"missing score", "number", `"type":"score","probabilities":{"0":0.5,"1":0.5}`},
		{"null score", "number", `"type":"score","score":null,"probabilities":{"0":0.5,"1":0.5}`},
		{"score range", "number", `"type":"score","score":2,"probabilities":{"0":0.5,"1":0.5}`},
		{"missing probabilities", "number", `"type":"score","score":0`},
		{"missing level", "number", `"type":"score","score":0,"probabilities":{"0":1}`},
		{"extra level", "number", `"type":"score","score":0,"probabilities":{"0":1,"2":0}`},
		{"null probability", "number", `"type":"score","score":0,"probabilities":{"0":1,"1":null}`},
		{"probability range", "number", `"type":"score","score":0,"probabilities":{"0":1.1,"1":0}`},
		{"confidence range", "number", `"type":"score","score":0,"confidence":-1,"probabilities":{"0":1,"1":0}`},
		{"missing choice", "classification", `"type":"choice","probabilities":{"bad":0,"good":1}`},
		{"null choice", "classification", `"type":"choice","choice":null,"probabilities":{"bad":0,"good":1}`},
		{"undeclared choice", "classification", `"type":"choice","choice":"other","probabilities":{"bad":0,"good":1}`},
		{"missing choice probability", "classification", `"type":"choice","choice":"good","probabilities":{"good":1}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				fmt.Fprintf(w, `{"model":"resolved","answers":{"metric":{%s}}}`, tc.answer)
			}))
			defer server.Close()
			metric := Metric{ID: "m", ReturnType: tc.returnType, Levels: []string{"low", "high"}, Labels: []MetricLabel{{Label: "bad"}, {Label: "good"}}}
			out := typesafeTestEngine().callModelMetric(FrozenMetric{Metric: metric, Provider: &Provider{BaseURL: server.URL}}, MetricInput{}, "", 2)
			if out.Status != "error" || out.Error == "" || out.Reason != "" || out.RawResponse == "" || calls != 1 {
				t.Fatalf("unexpected outcome: %#v calls %d", out, calls)
			}
		})
	}
}

func TestTypesafeTransportFailures(t *testing.T) {
	for _, mode := range []string{"http", "redirect", "timeout", "oversize", "malformed", "secret", "missing-model"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch mode {
				case "http":
					w.WriteHeader(503)
					io.WriteString(w, `{"error":"unavailable"}`)
				case "redirect":
					w.Header().Set("Location", "/again")
					w.WriteHeader(307)
				case "timeout":
					io.Copy(io.Discard, r.Body)
					select {
					case <-r.Context().Done():
					case <-time.After(2 * time.Second):
					}
				case "oversize":
					io.WriteString(w, strings.Repeat("x", (1<<20)+1))
				case "malformed":
					io.WriteString(w, `not json`)
				case "missing-model":
					io.WriteString(w, `{"answers":{"metric":{"type":"noul","noul":0.8}}}`)
				case "secret":
					w.WriteHeader(401)
					io.WriteString(w, `{"error":"fixture-secret","model":"fixture\u002dsecret"}`)
				}
			}))
			defer server.Close()
			out := typesafeTestEngine().callModelMetric(FrozenMetric{Metric: Metric{ID: "m", ReturnType: "boolean"}, Provider: &Provider{BaseURL: server.URL}}, MetricInput{}, "fixture-secret", 1)
			if out.Status != "error" || out.Error == "" || calls.Load() != 1 || out.Reason != "" {
				t.Fatalf("unexpected outcome %#v calls %d", out, calls.Load())
			}
			if mode == "http" && out.HTTPStatus != 503 {
				t.Fatal(out.HTTPStatus)
			}
			if mode == "redirect" && out.HTTPStatus != 307 {
				t.Fatal(out.HTTPStatus)
			}
			if mode == "secret" && (strings.Contains(out.RawResponse, "fixture-secret") || strings.Contains(out.ResponseModel, "fixture-secret") || strings.Contains(out.Error, "fixture-secret") || !strings.Contains(out.RawResponse, "[REDACTED]")) {
				t.Fatalf("secret escaped: %#v", out)
			}
			if mode == "oversize" && len(out.RawResponse) != 1<<20 {
				t.Fatal("response not bounded")
			}
		})
	}
}

func TestTypesafeEndpoint(t *testing.T) {
	for _, base := range []string{"https://example.com/v1/", "http://localhost:1234/v1"} {
		got, err := typesafeEndpoint(Provider{BaseURL: base})
		if err != nil || got != strings.TrimRight(base, "/")+"/systemone" {
			t.Fatalf("%s %v", got, err)
		}
	}
	for _, base := range []string{"ftp://example.com", "https://user:pass@example.com", "https://example.com?q=x", "https://example.com#x", "/v1", "http://"} {
		if _, err := typesafeEndpoint(Provider{BaseURL: base}); err == nil {
			t.Errorf("accepted %q", base)
		}
	}
}
