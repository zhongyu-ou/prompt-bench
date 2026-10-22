package workbench

import (
	"encoding/json"
	"errors"
	"time"

	"modernc.org/quickjs"
)

const (
	metricCodeMaxBytes    = 64 << 10
	metricInputMaxBytes   = 1 << 20
	metricOutputMaxBytes  = 64 << 10
	metricCodeMemoryLimit = 16 << 20
	metricCodeTimeout     = 200 * time.Millisecond
)

// runCodeMetric creates a runtime for this invocation only. It deliberately never
// installs host functions, console helpers, or a module loader.
func runCodeMetric(metric Metric, input MetricInput) (out MetricOutcome) {
	started := time.Now()
	out = MetricOutcome{MetricID: metric.ID, Status: "error", StartedAt: now()}
	defer func() {
		if recover() != nil {
			out.Value = nil
			out.Reason = ""
			out.Status = "error"
			out.Error = "code metric runtime failed"
		}
		out.FinishedAt = now()
		out.DurationMS = time.Since(started).Milliseconds()
	}()
	if len(metric.Code) > metricCodeMaxBytes {
		out.Error = "metric code exceeds 64 KiB"
		return out
	}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		out.Error = "metric input is not valid JSON"
		return out
	}
	if len(inputJSON) > metricInputMaxBytes {
		out.Error = "metric input exceeds 1 MiB"
		return out
	}
	codeJSON, err := json.Marshal(metric.Code)
	if err != nil {
		out.Error = "metric code is not valid text"
		return out
	}
	// Pass JSON as a string to JSON.parse rather than an object literal: case
	// data may legitimately contain a property named __proto__.
	quotedInput, err := json.Marshal(string(inputJSON))
	if err != nil {
		out.Error = "metric input is not valid JSON"
		return out
	}
	vm, err := quickjs.NewVM()
	if err != nil {
		out.Error = "cannot create code metric runtime"
		return out
	}
	defer vm.Close()
	vm.SetMemoryLimit(metricCodeMemoryLimit)
	vm.SetCanBlock(false)
	if err = vm.SetEvalTimeout(metricCodeTimeout); err != nil {
		out.Error = "cannot configure code metric timeout"
		return out
	}
	result, err := vm.Eval(metricCodeProgram+string(codeJSON)+","+string(quotedInput)+")", quickjs.EvalGlobal)
	if err != nil {
		// Only classify exact engine errors that escape the JS catch below.
		// All catchable user exceptions become a private, fixed-name object.
		out.Error = "code metric evaluation failed (invalid result or exception)"
		var jsError *quickjs.Error
		if errors.As(err, &jsError) && jsError.Name == "InternalError" {
			switch jsError.Message {
			case "interrupted":
				out.Error = "code metric exceeded the 200 ms evaluation timeout"
			case "out of memory":
				out.Error = "code metric exceeded the 16 MiB memory limit"
			}
		}
		return out
	}
	encoded, ok := result.(string)
	if !ok || len(encoded) > metricOutputMaxBytes {
		out.Error = "code metric returned an invalid or oversized result"
		return out
	}
	var response struct {
		Value  any    `json:"value"`
		Reason string `json:"reason"`
	}
	if err = json.Unmarshal([]byte(encoded), &response); err == nil {
		err = validateMetricValue(metric, response.Value)
	}
	if err != nil {
		out.Error = "code metric result does not match its declared return type or labels"
		return out
	}
	out.Status = "completed"
	out.Value = response.Value
	out.Reason = response.Reason
	return out
}

// Capture every intrinsic before untrusted code runs. Evaluate that code through
// indirect eval so it cannot read or replace this closure's validation helpers.
// Only a bounded JSON string crosses back to Go; never let the binding serialize
// an untrusted object (which could invoke getters, toJSON, or return a Promise).
const metricCodeProgram = `(function(code, inputJSON) {
  "use strict";
  const indirectEval = eval;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const create = Object.create;
  const finite = Number.isFinite;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
  const promiseThen = Function.prototype.call.bind(Promise.prototype.then);
  const nonASCII = Function.prototype.call.bind(RegExp.prototype.exec, /[^\x00-\x7f]/);
  const input = parse(inputJSON);
  const failure = create(null);
  failure.name = "CodeMetricError";
  failure.message = "code metric evaluation failed";
  failure.toString = function() { return "code metric evaluation failed"; };
  try {
    const evaluate = indirectEval(code + "\n;typeof evaluate === 'function' ? evaluate : undefined");
    if (typeof evaluate !== "function") throw "evaluate(input) is required";
    const result = evaluate(input);
    if (result === null || typeof result !== "object") throw "result must be an object";
    let promise = false;
    try { promiseThen(result); promise = true; } catch (_) {}
    if (promise) throw "result must not be a Promise";
    const proto = prototype(result);
    if (proto !== objectPrototype && proto !== null) throw "result must be a plain object, not a Promise";
    const keys = ownKeys(result);
    if (keys.length < 1 || keys.length > 2) throw "result requires value and optional reason only";
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== "value" && keys[i] !== "reason") throw "unexpected result property";
    }
    const value = descriptor(result, "value");
    if (!value || !hasOwn(value, "value")) throw "result requires an own data value";
    const type = typeof value.value;
    if (type !== "boolean" && type !== "number" && type !== "string") throw "value must be a scalar";
    if (type === "number" && !finite(value.value)) throw "value must be finite";
    const reason = descriptor(result, "reason");
    if (reason && (!hasOwn(reason, "value") || typeof reason.value !== "string")) throw "reason must be a string";
    const clean = create(null);
    clean.value = value.value;
    if (reason) clean.reason = reason.value;
    const serialized = stringify(clean);
    // UTF-8 bytes, not UTF-16 code units. JSON.stringify escapes lone surrogates.
    if (serialized.length > 65536) throw "result exceeds 64 KiB";
    if (nonASCII(serialized) !== null) {
      let bytes = 0;
      for (let i = 0; i < serialized.length; i++) {
        const c = charCodeAt(serialized, i);
        if (c < 128) bytes++;
        else if (c < 2048) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
        else bytes += 3;
        if (bytes > 65536) throw "result exceeds 64 KiB";
      }
    }
    return serialized;
  } catch (_) {
    // Even a thrown Proxy or huge string must not be converted by the Go bridge.
    throw failure;
  }
})(`
