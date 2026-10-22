# Evaluation backend verification — 2026-10-21

## Scope and safety

Implementation/API contract: [api.md — Evaluation metrics](api.md#evaluation-metrics).
Commands below ran with `go version go1.27.1 darwin/arm64`. No `.env` was
opened, no real credential was read, and no paid/model-provider request was made.
Every generation/decision request used a loopback fixture. The standalone binary
received an isolated temporary data directory and an explicit environment
containing only `PATH` and a temporary `HOME`; its manual key was the synthetic
literal `fixture-only-secret`.

## Final commands and actual output

Formatting was applied with `gofmt -w` to the changed Go files. Dependency
normalization completed with:

```sh
env GOPROXY=https://goproxy.cn,direct go mod tidy
```

The default proxy/checksum path had transient TLS handshake timeouts downloading
`modernc.org/gc/v3 v3.1.5`; the alternate proxy succeeded without disabling
checksum validation. The module still declares Go 1.25.0. That minimum toolchain
and other OS/architectures were not separately exercised.

Final regression/build command:

```sh
go test ./... -count=1 -timeout=120s && \
  go test -race ./internal/workbench -count=1 -timeout=120s && \
  env CGO_ENABLED=0 go build -o /tmp/promptbench-evaluation-smoke-bin .
```

Actual output (exit 0):

```text
?   promptbench                         [no test files]
?   promptbench/cmd/fixture             [no test files]
ok  promptbench/internal/workbench     3.074s
?   promptbench/web                    [no test files]
ok  promptbench/internal/workbench     7.178s
```

The first race run exposed a real serializer cost: a valid 64 KiB ASCII result
spent its 200 ms allowance in a JS per-character UTF-8 counting loop under race
instrumentation. The final implementation uses a captured native regexp for the
ASCII fast path, retains byte counting for non-ASCII, and includes an intrinsic-
tampering regression. The time/memory/byte limits were not increased and the
boundary test was not skipped. An earlier superseded regression invocation was
cancelled while runtime edits were still being integrated; only the completed
final invocation above is acceptance evidence.

### Exercised regression assertions

- Existing complete Go suite: rendering, credentials/redaction, protocol adapter
  isolation, Case CRUD/import/export, schema migration archives and legacy replay.
- `metric_code_test.go`: strict bool/number/classification values; no coercion;
  invalid object/getter/Promise/async/nonfinite/unknown label rejection; no host
  globals or imports; 200 ms infinite-loop/catastrophic-regex interruption;
  16 MiB allocation failure followed by a successful fresh VM; exact code/input/
  output bounds including UTF-8 and escaped strings; hostile intrinsic mutation;
  attacker-thrown resource-error names cannot impersonate native limit errors.
- `metric_typesafe_test.go`: exact POST/auth/question/criteria/state contracts for
  Noul, Score and Choice; native score/probability/confidence/legend preservation;
  `0.5 > 0.5` is false; missing/null/wrong-type/out-of-range fields and missing
  model identity error; response size limit; HTTP/timeout/malformed failures;
  redirects do not produce a second request; literal/escaped secret echoes redact.
  Decision state has the exact selected `target:"Hello"`, excludes full `output`
  and unrelated Chinese `corrected_text`, and uses fixed target-only instructions.
- `metric_integration_test.go`: versioned Metric CRUD and omitted-field retention;
  decision-only generation rejection; missing decision credentials prevent any
  generation; selected JSON Pointer and RFC 6901 escapes/array indices; partial
  errors keep successful generation and other metric outcomes; effective default
  threshold is frozen; rules/providers/selections remain replayable after edits
  and source deletion; original history remains identical; independent valid
  denominators and numeric/boolean/classification summaries; generation failure
  skips metrics and missing fields never fall back; stop during in-flight JEV;
  restart independently interrupts pending/running metrics without losing
  successful generation/previous metrics or rewriting old historical blobs.
- `TestMixedGenerationDecisionGlobalConcurrency`: 60 generation requests and 60
  JEV requests share concurrency 20, 120 metric outcomes complete, and the
  fixture's combined active-request peak is asserted `>1` and `<=20`.

After the full-suite/standalone passes, a focused numeric-summary fix removed
naive summation overflow for finite values near `math.MaxFloat64`. The final
mean update uses a sign-aware online mean; no runtime limits/contracts changed.
Only the affected behavior was rechecked:

```sh
go test -race ./internal/workbench -run 'TestNumericMetricSummaryStaysFinite|TestMetricTrialPointerStrictnessAndSummary' -count=1 -timeout=30s
```

Actual output (exit 0):
```text
ok  promptbench/internal/workbench  1.566s
```
The new regression covers two maximal positive numbers, opposite signs, and two
maximal negative numbers; resulting means remain finite and JSON-serializable.

## Real standalone process/API smoke

This was not an `httptest` server. A temporary Python stdlib harness launched the
compiled CLI as a subprocess with:

```sh
/tmp/promptbench-evaluation-smoke-bin -listen 127.0.0.1:0 -data-dir "$ISOLATED_DATA"
```

The harness used a separate `ThreadingHTTPServer` loopback fixture and exercised
real HTTP endpoints through `urllib.request`. Exact final command:

```sh
python3 /tmp/promptbench-evaluation-smoke.py
```

The temporary script and binary were removed after recording evidence. The
script's first attempt expected Case creation HTTP200; the actual existing
endpoint correctly returned HTTP201. That assertion was corrected to 201 before
any accepted smoke run; no application behavior was changed for this fixture
mistake.

### API operations and assertions

1. `GET /api/health`, `GET /api/state`, `POST /api/cases` (201), and versioned
   `PUT /api/state` install a synthetic Case, one generation group, one Typesafe
   provider and five metrics: code bool, model bool/number/classification and an
   independent invalid-NaN code metric. All target `/en` in
   `{"corrected_text":"中文原文","en":"Hello"}`.
2. Before any key exists, `POST /api/runs` returns 400; fixture generation and
   decision call counts both remain zero. A subsequent state write sets the
   synthetic manual decision key using `credential_updates`.
3. `POST /api/metrics/trial` returns completed `false` for the Han-character
   detector on `/en`, unaffected by `corrected_text`.
4. `POST /api/runs` returns 202; polling detail yields one successful generation,
   four completed metrics and one error. Ordered values are
   `[false,true,1.4,"greeting",null]`. Noul is `0.8`; returned model is
   `jev-fixture-version`; no model `reason` is fabricated. Raw echoed key becomes
   `[REDACTED]`. Fixture checks `state.target == "Hello"`, absence of `output`,
   and the fixed target-only instruction prefix on every decision request.
5. Change the saved code rule to return true and remove draft selection, then
   `POST /api/runs/{id}/replay`: the new batch retains the entire original frozen
   snapshot and the original false code result.
6. Start three repetitions at concurrency 1 and block the first decision fixture.
   `POST /stop` yields stopping; a concurrent new run yields 409. Release the
   issued decision: it completes, remaining metrics/generations are cancelled,
   and final counters are generation completed 1/cancelled 2, metric completed
   2/cancelled 13 out of 15.
7. Start a new run, wait for generation and its first code metric to finish and
   the first JEV request to arrive, then send SIGKILL to the standalone server.
   Restart a new process on the **same isolated directory**. Detail reports
   interrupted batch, still-completed generation/output and first metric, and
   four interrupted remaining metrics. Fixture counts do not increase across
   restart. Earlier immutable history and export remain readable.
8. Query that isolated SQLite database: `PRAGMA user_version` remains 3 and the
   encrypted credential row is retained. Every API response is asserted not to
   contain the synthetic secret. No current user database is involved.

### Actual final smoke output (exit 0)

```text
PROCESS 2026/10/21 23:22:18 Promptbench http://127.0.0.1:64385 (SQLite: /var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/promptbench-evaluation-smoke-m295r5h2/promptbench.sqlite)
PASS decision preflight prevents all generation; zero fixture calls
PASS standalone local trial selects /en, not corrected_text
PASS mixed generation/code/Noul/Score/Choice and independent invalid-return error: {"cancelled": 0, "completed": 1, "concurrency": 2, "created_at": "2026-10-21T15:22:18.174963Z", "evaluation": {"cancelled": 0, "completed": 4, "error": 1, "interrupted": 0, "pending": 0, "running": 0, "skipped": 0, "total": 5}, "failed": 0, "finished_at": "2026-10-21T15:22:18.182351Z", "id": "bfbf837fffb9b927cd95e69f8f0a7362", "in_flight": 0, "interrupted": 0, "max_model_calls": 3, "name": "Standalone smoke", "replay_of": "", "status": "completed_with_errors", "total": 1}
PASS immutable replay uses old rule/target/provider snapshot after mutable edits
PASS in-flight stop finishes issued decision, cancels remaining generation/metrics: {"cancelled": 2, "completed": 1, "concurrency": 1, "created_at": "2026-10-21T15:22:18.206966Z", "evaluation": {"cancelled": 13, "completed": 2, "error": 0, "interrupted": 0, "pending": 0, "running": 0, "skipped": 0, "total": 15}, "failed": 0, "finished_at": "2026-10-21T15:22:18.212156Z", "id": "e80c3077acd0a23259a0a0177c7908a1", "in_flight": 0, "interrupted": 0, "max_model_calls": 9, "name": "Standalone smoke", "replay_of": "", "status": "stopped", "total": 3}
PROCESS 2026/10/21 23:22:18 Promptbench http://127.0.0.1:64419 (SQLite: /var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/promptbench-evaluation-smoke-m295r5h2/promptbench.sqlite)
PASS hard restart preserves generation/prior metrics/history, interrupts pending/running metrics, sends zero calls
PASS durable additive SQLite data and encrypted credential retained; schema3 migration behavior unchanged
PASS standalone smoke complete; fixture totals {"decision": 8, "generation": 4}
ISOLATED_DATA /var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/promptbench-evaluation-smoke-m295r5h2
```

## Limits of this evidence

No live Typesafe availability, account model access or semantic judgment quality
was tested. Target-only transport prevents ambiguous payload selection but does
not prove model instruction compliance. QuickJS engine bounds and hostile
fixtures are defense-in-depth, not a security certification or total-process RSS
limit. Native uncatchable timeout/OOM errors are distinguished; catchable script
exceptions, including catchable allocation failures, deliberately retain a safe
generic error rather than converting untrusted thrown objects. Frontend/browser
acceptance belongs to the frontend integration work.
