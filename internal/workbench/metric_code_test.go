package workbench

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func codeMetricForTest(returnType, code string) Metric {
	return Metric{
		ID: "test-code", Name: "Code metric", Kind: "code", ReturnType: returnType, Code: code,
		Labels: []MetricLabel{{Label: "pass"}, {Label: "fail"}},
	}
}

func requireCodeMetricError(t *testing.T, out MetricOutcome) {
	t.Helper()
	if out.Status != "error" || out.Error == "" || out.Value != nil || out.Reason != "" {
		t.Fatalf("expected an error without a partial result, got %#v", out)
	}
	if out.MetricID != "test-code" || out.StartedAt == "" || out.FinishedAt == "" || out.DurationMS < 0 {
		t.Fatalf("missing outcome metadata: %#v", out)
	}
}

func TestCodeMetricValues(t *testing.T) {
	input := MetricInput{Output: "hello", Target: map[string]any{"answer": "world"}, Group: MetricGroup{ID: "g", Name: "Group", Model: "model"}, Iteration: 3}
	for _, tt := range []struct {
		name, returnType, code string
		want                   any
		wantReason             string
	}{
		{"boolean", "boolean", `function evaluate(input) { return {value: input.output === "hello" && input.target.answer === "world" && input.group.id === "g" && input.group.model === "model" && input.iteration === 3, reason: "checked"}; }`, true, "checked"},
		{"false", "boolean", `function evaluate(input) { return {value: false}; }`, false, ""},
		{"number", "number", `function evaluate(input) { return {value: input.output.length / 2}; }`, 2.5, ""},
		{"zero", "number", `function evaluate(input) { return {value: 0}; }`, float64(0), ""},
		{"classification", "classification", `function evaluate(input) { return {value: "pass"}; }`, "pass", ""},
		{"null prototype", "boolean", `function evaluate(input) { const result = Object.create(null); result.value = true; return result; }`, true, ""},
		{"closure", "number", `const multiplier = 2; const evaluate = input => ({value: input.iteration * multiplier});`, float64(6), ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			out := runCodeMetric(codeMetricForTest(tt.returnType, tt.code), input)
			if out.Status != "completed" || out.Error != "" || out.Value != tt.want || out.Reason != tt.wantReason {
				t.Fatalf("unexpected outcome: %#v", out)
			}
			if out.MetricID != "test-code" || out.StartedAt == "" || out.FinishedAt == "" {
				t.Fatalf("missing outcome metadata: %#v", out)
			}
		})
	}
}

func TestCodeMetricRejectsInvalidResults(t *testing.T) {
	for _, tt := range []struct{ name, returnType, code string }{
		{"string boolean", "boolean", `function evaluate() { return {value: "true"}; }`},
		{"number boolean", "boolean", `function evaluate() { return {value: 1}; }`},
		{"string number", "number", `function evaluate() { return {value: "1"}; }`},
		{"boolean number", "number", `function evaluate() { return {value: true}; }`},
		{"unknown label", "classification", `function evaluate() { return {value: "PASS"}; }`},
		{"numeric label", "classification", `function evaluate() { return {value: 1}; }`},
		{"NaN", "number", `function evaluate() { return {value: NaN}; }`},
		{"positive infinity", "number", `function evaluate() { return {value: Infinity}; }`},
		{"negative infinity", "number", `function evaluate() { return {value: -Infinity}; }`},
		{"undefined value", "number", `function evaluate() { return {value: undefined}; }`},
		{"function value", "number", `function evaluate() { return {value: function() {}}; }`},
		{"bigint", "number", `function evaluate() { return {value: 1n}; }`},
		{"symbol", "number", `function evaluate() { return {value: Symbol("v")}; }`},
		{"null value", "number", `function evaluate() { return {value: null}; }`},
		{"boxed boolean", "boolean", `function evaluate() { return {value: new Boolean(true)}; }`},
		{"object value", "number", `function evaluate() { return {value: {toJSON() { return 1; }}}; }`},
		{"undefined result", "boolean", `function evaluate() {}`},
		{"null result", "boolean", `function evaluate() { return null; }`},
		{"primitive result", "boolean", `function evaluate() { return true; }`},
		{"array result", "boolean", `function evaluate() { const a = []; a.value = true; return a; }`},
		{"missing value", "boolean", `function evaluate() { return {reason: "missing"}; }`},
		{"inherited value", "boolean", `function evaluate() { return Object.create({value: true}); }`},
		{"getter value", "boolean", `function evaluate() { return {get value() { return true; }}; }`},
		{"extra property", "boolean", `function evaluate() { return {value: true, other: 1}; }`},
		{"symbol property", "boolean", `function evaluate() { return {value: true, [Symbol("extra")]: 1}; }`},
		{"undefined reason", "boolean", `function evaluate() { return {value: true, reason: undefined}; }`},
		{"number reason", "boolean", `function evaluate() { return {value: true, reason: 1}; }`},
		{"null reason", "boolean", `function evaluate() { return {value: true, reason: null}; }`},
		{"getter reason", "boolean", `function evaluate() { return {value: true, get reason() { return "reason"; }}; }`},
		{"Promise", "boolean", `function evaluate() { return Promise.resolve({value: true}); }`},
		{"Promise with value", "boolean", `function evaluate() { const p = Promise.resolve(); p.value = true; return p; }`},
		{"Promise null prototype", "boolean", `function evaluate() { const p = Promise.resolve(); p.value = true; Object.setPrototypeOf(p, null); return p; }`},
		{"Promise plain prototype", "boolean", `function evaluate() { const p = Promise.resolve(); p.value = true; Object.setPrototypeOf(p, Object.prototype); return Object.freeze(p); }`},
		{"async", "boolean", `async function evaluate() { return {value: true}; }`},
		{"missing function", "boolean", `const unrelated = 1;`},
		{"syntax error", "boolean", `function evaluate( {`},
		{"exception", "boolean", `function evaluate() { throw new Error("private case data"); }`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			out := runCodeMetric(codeMetricForTest(tt.returnType, tt.code), MetricInput{})
			requireCodeMetricError(t, out)
			if strings.Contains(out.Error, "private case data") || out.RawResponse != "" {
				t.Fatalf("exception leaked untrusted data: %#v", out)
			}
		})
	}
}

func TestCodeMetricNoHostAccess(t *testing.T) {
	metric := codeMetricForTest("boolean", `function evaluate() {
  const names = ["fetch", "XMLHttpRequest", "WebSocket", "process", "require", "Deno", "Bun", "std", "os", "print", "console", "read", "loadScript", "setTimeout"];
  return {value: names.every(name => typeof globalThis[name] === "undefined")};
}`)
	out := runCodeMetric(metric, MetricInput{})
	if out.Status != "completed" || out.Value != true {
		t.Fatalf("host globals were exposed: %#v", out)
	}
	for _, code := range []string{
		`import * as std from "std"; function evaluate() { return {value: true}; }`,
		`import * as os from "os"; function evaluate() { return {value: true}; }`,
		`function evaluate() { return import("file:///etc/passwd"); }`,
		`function evaluate() { return import("https://example.invalid/metric.js"); }`,
		`function evaluate() { return {value: Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000) === "timed-out"}; }`,
	} {
		requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", code), MetricInput{}))
	}
}

func TestCodeMetricTimeoutAndRegex(t *testing.T) {
	for _, tt := range []struct{ name, code string }{
		{"top level", `while (true) {} function evaluate() { return {value: true}; }`},
		{"evaluate", `function evaluate() { while (true) {} }`},
		{"regex", `function evaluate() { return {value: /^(a+)+$/.test("a".repeat(10000) + "!")}; }`},
		{"proxy validation", `function evaluate() { return new Proxy({}, {getPrototypeOf() { while (true) {} }}); }`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			started := time.Now()
			out := runCodeMetric(codeMetricForTest("boolean", tt.code), MetricInput{})
			requireCodeMetricError(t, out)
			if out.Error != "code metric exceeded the 200 ms evaluation timeout" {
				t.Fatalf("timeout was not identified: %#v", out)
			}
			if elapsed := time.Since(started); elapsed > 5*time.Second {
				t.Fatalf("200ms evaluation limit failed: %s", elapsed)
			}
		})
	}
}

func TestCodeMetricMemoryLimitAndIsolation(t *testing.T) {
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", `globalThis.previousInvocation = true; function evaluate() { return {value: new ArrayBuffer(32 * 1024 * 1024).byteLength > 0}; }`), MetricInput{}))
	out := runCodeMetric(codeMetricForTest("boolean", `function evaluate() { return {value: typeof previousInvocation === "undefined"}; }`), MetricInput{})
	if out.Status != "completed" || out.Value != true {
		t.Fatalf("fresh VM did not recover after OOM: %#v", out)
	}
	out = runCodeMetric(codeMetricForTest("boolean", `globalThis.previousInvocation = true; function evaluate() { return {value: true}; }`), MetricInput{})
	if out.Status != "completed" {
		t.Fatalf("ordinary invocation failed: %#v", out)
	}
	out = runCodeMetric(codeMetricForTest("boolean", `function evaluate() { return {value: typeof previousInvocation === "undefined"}; }`), MetricInput{})
	if out.Status != "completed" || out.Value != true {
		t.Fatalf("global state leaked between invocations: %#v", out)
	}
}

func TestCodeMetricBounds(t *testing.T) {
	code := `function evaluate() { return {value: true}; }`
	atCodeLimit := code + strings.Repeat(" ", metricCodeMaxBytes-len(code))
	if out := runCodeMetric(codeMetricForTest("boolean", atCodeLimit), MetricInput{}); out.Status != "completed" {
		t.Fatalf("code at exact bound was rejected: %#v", out)
	}
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", atCodeLimit+" "), MetricInput{}))
	base, err := json.Marshal(MetricInput{})
	if err != nil {
		t.Fatal(err)
	}
	input := MetricInput{Output: strings.Repeat("a", metricInputMaxBytes-len(base))}
	if out := runCodeMetric(codeMetricForTest("boolean", code), input); out.Status != "completed" {
		t.Fatalf("input at exact bound was rejected: %#v", out)
	}
	input.Output += "a"
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", code), input))
	input = MetricInput{Target: math.Inf(1)}
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", code), input))
	// {"value":true,"reason":""} is 26 UTF-8 bytes.
	for _, tt := range []struct {
		name, reason string
		wantOK       bool
	}{
		{"exact output limit", `"a".repeat(65510)`, true},
		{"one byte over", `"a".repeat(65511)`, false},
		{"UTF-8 over", `"界".repeat(22000)`, false},
		{"astral over", `"😀".repeat(17000)`, false},
		{"escaping over", `"\"".repeat(33000)`, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			out := runCodeMetric(codeMetricForTest("boolean", `function evaluate() { return {value: true, reason: `+tt.reason+`}; }`), MetricInput{})
			if tt.wantOK {
				if out.Status != "completed" || len(out.Reason) != 65510 {
					t.Fatalf("bounded result was rejected: %#v", out)
				}
			} else {
				requireCodeMetricError(t, out)
			}
		})
	}
}

func TestCodeMetricUntrustedIntrinsics(t *testing.T) {
	out := runCodeMetric(codeMetricForTest("boolean", `function evaluate() {
  JSON.stringify = () => '{"value":false}';
  Reflect.ownKeys = () => [];
  Object.getOwnPropertyDescriptor = () => ({value: false});
  Object.prototype.toJSON = () => ({value: false});
  String.prototype.charCodeAt = () => 0;
  return {value: true};
}`), MetricInput{})
	if out.Status != "completed" || out.Value != true {
		t.Fatalf("user mutation replaced runtime validation: %#v", out)
	}
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", `function evaluate() { Object.prototype.value = true; return {get value() { return true; }}; }`), MetricInput{}))
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("number", `function evaluate() { Number.isFinite = () => true; return {value: Infinity}; }`), MetricInput{}))
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", `function evaluate() { throw {toString() { while (true) {} }}; }`), MetricInput{}))
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", `function evaluate() { JSON.stringify = () => ""; return {value: true, reason: "a".repeat(65536)}; }`), MetricInput{}))
	requireCodeMetricError(t, runCodeMetric(codeMetricForTest("boolean", `function evaluate() { RegExp.prototype.exec = () => null; RegExp.prototype.test = () => false; return {value: true, reason: "界".repeat(22000)}; }`), MetricInput{}))
}

func TestCodeMetricResourceErrorsCannotBeSpoofed(t *testing.T) {
	for _, code := range []string{
		`function evaluate() { throw new InternalError("interrupted"); }`,
		`function evaluate() { throw new InternalError("out of memory"); }`,
		`function evaluate() { String.prototype.name = "InternalError"; String.prototype.message = "interrupted"; throw "secret"; }`,
		`function evaluate() { throw {name: "InternalError", message: "out of memory"}; }`,
	} {
		out := runCodeMetric(codeMetricForTest("boolean", code), MetricInput{})
		requireCodeMetricError(t, out)
		if out.Error != "code metric evaluation failed (invalid result or exception)" {
			t.Fatalf("user exception was misclassified as a resource failure: %#v", out)
		}
	}
}
