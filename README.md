# Promptbench

A standalone local prompt workbench with Go `text/template` rendering, editable Cases/templates/Providers, explicit comparison configurations, concurrent repeated calls, reusable evaluation metrics and durable PostgreSQL history. **OpenAI Chat Completions** is supported for text generation and **Typesafe System One (JEV)** for decision-only model metrics. Provider brand/model is separate from protocol. No Agent Evals account or platform database is involved. Browser assets are embedded; no Node build is required.

## Layout

- `main.go` is a thin process entry: it calls `workbench.Run()` and only handles process failure reporting.
- `internal/workbench/` owns configuration, HTTP API, domain/wire types, rendering and protocol adapters, execution, PostgreSQL persistence, credentials, seed data, and white-box tests. The root entrypoint depends only on `Run`; no speculative service/repository layers.
- `web/` exports the embedded `Assets` (`index.html`, `js`, `css`), served directly by the workbench. The browser app boots from the native ES module `web/js/main.js`: shared `state.js`, `model.js` and `api.js`; `persistence.js` and `mutations.js` own saves and optimistic-version adoption; feature modules cover templates, the case library/editor/IO, groups, selection, runs, history, metrics/evaluation summaries, providers and settings, with supporting modules for navigation, views, preview/output, snapshots/run plans and feedback. Ordered stylesheets live in `web/css/` and are linked from `index.html`; preserve that order.
- `cmd/fixture/` is the standalone local OpenAI-compatible fixture. `docs/` holds API contracts and scoped historical verification evidence; `database/` is private runtime state. The architecture refactor scope and verification status are recorded in [docs/tasks/architecture-refactor.md](docs/tasks/architecture-refactor.md).

Existing commands remain the interface: `go run .`, `make run`, `make build`, `make test`, and `go test ./...`.

## Run

Requires Go 1.25+ on macOS or Linux and a PostgreSQL database. Create a dedicated empty UTF-8 database owned by the configured role, then copy `config/config.example.yml` to `config/config.yml`, edit its connection settings, and restrict it with `chmod 600 config/config.yml`. The actual file is Git-ignored; the example contains no secrets. Initial `go run` downloads Go modules.

```sh
cd /path/to/promptbench
cp config/config.example.yml config/config.yml
chmod 600 config/config.yml
# Edit config/config.yml with your PostgreSQL connection settings before starting.
go run . --env-file "$HOME/.config/promptbench/keys.env" --listen 127.0.0.1:8787
```

Open the exact printed URL, normally **http://127.0.0.1:8787**. `--env-file` is optional: use environment keys, a manually entered Provider override, or an explicitly anonymous fixture. Public binds are rejected; `localhost` normalizes to `127.0.0.1`, and literal IPv6 loopback is supported. A hostname different from the printed URL is deliberately rejected.

With Make installed, `make dev` starts development mode using pinned [Air v1.64.5](https://github.com/air-verse/air/tree/v1.64.5), downloaded automatically without changing application dependencies. It watches Go source, embedded templates, HTML/CSS/JS and Go module files. Refresh the browser after restart. Runtime data, docs, fixture sources, test files and build output are excluded. YAML configuration, `.air.toml` and env-file changes require restarting the watcher.

Use `make run` (or `go run .`) for normal runs without watching, `make build` to build `./promptbench`, and `make test` to run all Go tests. Development restarts use graceful shutdown: unissued attempts stop, and issued requests finish and persist before the replacement process starts (up to the configured upstream timeout, with a 61-minute forced-shutdown ceiling). Use `make run` when running real batches so saving code does not stop the batch.

Both `make run` and `make dev` automatically load project-local `.env` if present; otherwise startup uses the existing process environment or saved Provider credentials. Existing process environment variables take priority. `make` lists available targets; `make run ARGS='--help'` shows application flags. Pass flags with `ARGS`; an explicit `--env-file` overrides the automatic `.env` selection:

```sh
make run ARGS='--env-file /path/to/keys.env --listen 127.0.0.1:8787'
```

Create your own private credentials file (do not copy another project's `.env`). For `make run`, use a project-local `.env` with variable names matching each Provider's `api_key_env` setting and restrict its permissions with `chmod 600 .env`. Alternatively, keep credentials outside the project and pass `--env-file`:

```sh
mkdir -p "$HOME/.config/promptbench"
chmod 700 "$HOME/.config/promptbench"
# Edit $HOME/.config/promptbench/keys.env with your actual credentials:
# AZURE_OPENAI_API_KEY=...
# AZURE_OPENAI_4O_KEY=...
# TYPESAFE_API_KEY=...
chmod 600 "$HOME/.config/promptbench/keys.env"
# .env.example in this project is an empty reference, not a credential source.
```

The env file accepts blank/comment lines, `NAME=value`, `export NAME=value`, single-quoted literals and Go-style double-quoted escaped strings. No shell execution/expansion. Existing process environment overrides env-file values. Provider manual override takes priority over its configured env key; an untouched/blank password field preserves the existing override. Explicit **Clear** removes it and falls back to env. An initial blank field uses env, or anonymous mode only when the env reference is also empty. Missing/invalid required credentials fail before calls, never downgrade authenticated history to anonymous. Restart to reload env-file changes; manual override edits take effect on later batches/replays without restart. Each in-flight batch retains its initially resolved key. Shared env names do not merge separate provider overrides.

## Manual credentials and protocol types

Provider management lists the actual protocol catalog from `/api/protocols`. `openai-chat-completions` provides text generation and appends `/chat/completions`; `typesafe-systemone` provides decision evaluation, appends `/systemone`, and is accepted only by model metrics, never generation groups. Capabilities come from the catalog, so the generation selector and model-metric selector filter Providers by purpose. Role/message rendering is generic; each adapter owns endpoint/method/nonsecret headers/body, runtime authentication and response decoding. Replay freezes protocol, endpoint, nonsecret headers and exact body, but resolves current credentials at the frozen immutable reference.

Type a new key into the Provider password field to replace the manual override, then save. Passwords are write-only transient edits: GET/state/history/export never return a value or masked replacement. Nonsecret metadata reports actual manual/env/anonymous/missing/invalid availability, not just a configured env name. State and credential saves commit atomically with one optimistic version; stale tabs cannot mix old endpoint configuration with newly replaced keys.

The Provider dialog's **Save Provider** submits changes to the backend immediately through the shared state save, including any other pending draft edits. Successful saves survive refresh; failed saves leave the dialog open with its input intact and show an error. Retrying a failed creation saves the same staged Provider rather than creating a duplicate.

Manual keys are AES-256-GCM encrypted in PostgreSQL using private generated `credentials.key` under the owner-only key directory. The keyfile is 32 bytes and must be backed up with the database. Missing/corrupt/mismatched master material with encrypted rows fails safely, never generates a replacement or pretends no override exists. This protects database-only copies, **not against the OS user who can read both database and key**. Actual keys never enter editable state, frozen providers, raw requests, exports or logs; known upstream key echoes are redacted. Never paste keys into case variables/template/model parameters/URL: arbitrary user-authored data is persisted.

Deleting a Provider intentionally retains its encrypted override for historical replay. To revoke it, **Clear before deleting or Clear and delete in the same save**; otherwise the historical reference remains usable. Recreating the same Provider ID gets a new reference and cannot inherit/read an old secret. Clear/removal does not cancel or change an already-started batch. An authenticated original whose credential is no longer available fails replay unless its frozen env reference supplies a valid fallback.

Initial state contains four example ASR input Cases and an embedded `seed.tmpl`; no Agent Evals files are read at runtime. Luna, GPT-4o and Typesafe Providers are examples with URLs and env names, not included keys; Typesafe is the default `typesafe-systemone` decision Provider for model metrics and is never added to generation groups. **Startup creates no requests or fabricated history.** Check configurations and the visible request count before running: new installations default to 20 repeats per Case per enabled group and may incur real provider charges.

## Workbench behavior

- Cases have random IDs and input variables only; no name or execution target map. Dedicated Case/Collection operations own those resources; generic settings/template/provider/draft saves preserve Case JSON exactly. The lossless advanced editor uses a derived JSON string; form updates patch only changed fields, preserving unknown large integers/decimal literals.
- The workbench places template editing on the left and comparison configurations on the right. Choose a template once; use Rename for its name, and choose message roles from the backend protocol catalog. **保存更改** persists pending edits together; **保存并运行 N 次** saves before starting and aborts if another edit occurs during that save. Saving keeps the current editor template; selecting a comparison configuration explicitly switches to its bound template.
  Standard Go template `if`, `range`, map ordering, whitespace trimming and builtins are used unchanged; no filesystem/process/network functions are exposed.
- Add each comparison configuration explicitly. No hidden Cartesian product. Each enabled group specifies its own model, parameters, template, provider and repeat count. An omitted temperature/reasoning parameter is not the same as an explicit `null`, `0` or `"none"`; Promptbench does not silently rewrite unsupported parameters.
- Shared Collections are many-to-many references, not copies. Deleting a collection leaves Cases; editing a shared Case affects future use, never frozen history. Run selection unions explicit Cases and collections, deduplicates IDs and applies temporary exclusions. Applying/previewing a selection sends no calls.
- Manage run data, collections and temporary exclusions in **Case 库**, not in the workbench. The workbench shows the applied scope and a link back to its controls. Global concurrency and default repeats are edited only in **全局设置**; changing default repeats does not rewrite existing configurations.
- Result previews in both workbench and history use 输出 / 请求 / 响应 / 详情 / 评估 tabs. The bottom panel keeps 运行输出 / 评估汇总 / 批次快照. JSON is formatted, highlighted and wrapped by default; the copy icon copies the full original content, not the clipped display or reserialized numbers. Plain or malformed JSON remains text. The standalone Case/request preview cards have been removed; the preview HTTP API remains available.
- Each group owns exact raw-source language routes and custom target key/name descriptors. `zh-CN` does not match `zh`. Unmatched sources always use English (`en`), including en→en without a rule. Effective target maps are injected at render time; several targets still mean one request.
- Import defaults to **Eve / Vocat 变量**: paste a variables object directly, a JSON array, or one object per JSONL line; no header or ID is needed. The data-format selector also accepts exported **Promptbench 标准包** with optional collection relationships. Both paths preview new/existing inputs and only add/reuse by full input fingerprint (object key order only), never update by ID. Membership export never expands selected Cases through shared collections. Examples and exact endpoints are in [docs/case-api.md](docs/case-api.md).
- One active batch at a time, with 1–20 concurrent calls across **all groups/cases**. A second start or replay returns an explicit 409 while a batch is running/stopping. Requests interleave group within case within repeat. No automatic retries or outbound redirects.
- Refreshing/closing the browser does not stop backend execution. Stop cancels only unissued generation/metric work; in-flight calls finish and persist. Graceful server shutdown stops unissued work and waits for issued calls (up to their configured timeout).
- Every attempt is visible as pending/running/completed/failed/cancelled/interrupted. History preserves frozen input sources, endpoint, requested/returned model identities, parameter presence, rendered request bytes, raw response, HTTP errors, decode errors and duration. Evaluation metrics add declared judgments beside the output; they are not an implicit pass/fail gate.
- Replay creates a new batch from the old frozen snapshot even if current cases/templates/providers were changed or deleted. It does not silently resend on restart. Missing credentials fail before sending any calls.
- A crash/restart marks unfinished work interrupted/unknown. An unknown response may still have been billed; Promptbench never assumes it was safe to resend. A PostgreSQL session advisory lock rejects another server on the same database/schema before initialization or recovery, even with a different local key directory.

## Evaluation metrics

- **指标** manages reusable code and model metrics. Code metrics use a restricted, synchronous `evaluate(input) → { value, reason? }` function. Model metrics select a decision-capable Provider (Typesafe JEV), a model version, and a boolean threshold, ordered numeric levels, or fixed classification labels. New model metrics default the version field to `jev-latest`; changing it never rewrites saved metrics. The editor validates declared return values and can trial code metrics against synthetic local output without writing history. Each result keeps the requested version string and the provider's resolved `response_model`. A batch freezes the version string it sent; replay reuses that frozen alias, so it may resolve to a different model after the alias moves.
- **复制 AI 编写提示词** copies only the current rule, exact function/input/output contract, declared labels/type, runtime bounds and synthetic examples. It never copies real Case data, output history or credentials.
- Metric selection is batch-wide and ordered: every enabled group uses the same metrics and target. Targets are the exact output or an RFC 6901 JSON Pointer such as `/en`; an empty pointer means the JSON root. The selected model-metric count and preflight credential errors are visible before **运行**. Failed generations skip their content metrics; one metric error does not discard other judgments or stop independent work.
- Generation and evaluation progress are separate (`生成 x/y · 评估 a/b`). The batch remains active until both settle. Stop starts no new generation or metric call; issued calls finish, and unissued metrics are marked cancelled. There is no historical-only re-evaluation endpoint; replay creates a new complete batch from the frozen snapshot.
- The bottom panel keeps **运行输出 / 评估汇总 / 批次快照**. Evaluation badges on result rows are independent of generation status. The **评估** tab inside the existing result preview shows target, value/reason, probabilities/legend, errors and a configuration link. The summary honors the original group/Case filters; only completed judgments enter valid denominators, and errors/pending/cancelled/interrupted remain separate.
- Deleting a metric that is currently selected also removes that draft selection; frozen history and already-started batches keep their own metrics and are never re-evaluated. If a Provider used by model metrics is deleted, its metrics and selections are removed together.

## Persistence, backups and limits

Service configuration defaults to **`config/config.yml`**, relative to the working directory; select another file with `--config`. Only `server` (`host`, `port`) and `database` (`host`, `port`, `user`, `password`, `name`, `sslmode`) are accepted. Unknown/duplicate keys, empty files, multiple documents and missing files fail explicitly. Listen addresses remain loopback-only. Environment variables do not override YAML; `--env-file` supplies Provider credentials only.

`--listen` explicitly overrides the YAML server address for that launch. `--data-dir` defaults to **`./database`** and now stores only the private `credentials.key`; directory/key permissions are 0700/0600. `--env-file` defaults to empty. `--help` needs neither a configuration file nor a database.

```sh
go run . --config config/config.yml --listen 127.0.0.1:8788 --data-dir /path/to/private-keys
go build -o promptbench .
./promptbench --config config/config.yml
```

PostgreSQL is the only runtime/test backend. The current schema version is 1, separate from optimistic `state.version`. Empty schemas initialize atomically; nonempty unversioned and unsupported schemas are rejected, never reset. Historical JSON/request/response/ciphertext bytes use BYTEA, not JSONB. Existing SQLite files require a separately verified one-time offline migration; the application does not open or upgrade them. See [storage guarantees](docs/api.md#storage-and-migration).

One physical PG session serializes transactions and holds the advisory lock. Connect directly or through **session pooling**, never transaction pooling. If that session is lost, the process refuses reconnection and further dispatch; restart to reacquire the lock and recover unfinished work. Unspecified connection/statement timeouts default to 5/30 seconds.

For backup, stop the application, use PostgreSQL backup tooling (for example `pg_dump`), and preserve the matching `credentials.key` securely. Restore both before starting against the restored database. Keep the key when moving the database to another host. Per-batch JSON exports are history exports, not credential/database backups. No automatic history deletion.

Limits: 8 MiB inbound JSON, 1 MiB rendered content per message, 16 MiB captured response body per attempt, 100000 attempts per batch, 1000 repeats per group and 3600-second maximum request timeout (default 120). Oversized response capture fails explicitly and retains its prefix. These are local accident guards, not a sandbox for untrusted templates; Go template builtins can still perform substantial computation. Non-UTF-8 response bytes are preserved in `raw_response_base64`. Actual resolved keys echoed by upstream are redacted before persistence/UI/export; redaction is the intentional exception to exact raw-response preservation. Auth headers are never persisted. Provider URLs with credentials/query/fragment are rejected. The local API checks Host/Origin, requires JSON mutations and does not enable CORS.

## Local verification without paid services

```sh
# Set PROMPTBENCH_TEST_DATABASE_URL securely to a dedicated database ending in _test.
# Tests require it explicitly and create/drop only their own unique schemas.
go test -race ./...
# Terminal 1: an HTTP fixture, NOT a real model or quality assessment:
go run ./cmd/fixture --listen 127.0.0.1:9797 --delay 150ms
# Terminal 2: use a separate empty smoke database in a private smoke YAML:
go run . --config /path/to/smoke.yml --listen 127.0.0.1:8788 --data-dir /tmp/promptbench-browser-smoke
```

In the workbench at `http://127.0.0.1:8788`, configure a provider with base URL `http://127.0.0.1:9797/v1` and empty credential env name, then point explicit groups at it. Any model name returns an unmistakably labeled fixture echo with a distinct returned-model identity. Model `fixture-http-error` returns HTTP 422; `fixture-invalid-json` returns a decode failure. Set a longer fixture `--delay 1s` to observe progress, refresh and stopping. Inspect history, frozen request/response details, replay and Download JSON. This only verifies HTTP/lifecycle/UI integration; it does **not** verify Azure, model access, model behavior or translation quality.

Credential fixture smoke uses synthetic values only: start the fixture with `PROMPTBENCH_FIXTURE_MANUAL_KEY=fixture-manual-only PROMPTBENCH_FIXTURE_ENV_KEY=fixture-env-only go run ./cmd/fixture --listen 127.0.0.1:9797`. Start the app with a separate smoke database/config and `FAKE_PROVIDER_ENV=fixture-env-only`. Configure Provider env name `FAKE_PROVIDER_ENV`, manual key `fixture-manual-only`, model `fixture-auth-manual`: output says `AUTH MATCH: manual`. Clear the override and use `fixture-auth-env`: output says `AUTH MATCH: env`. Wrong auth returns 401; credentials are never echoed. Never use real secrets or the normal application database for these checks.

See [docs/api.md](docs/api.md) for the precise JSON contract.

For exercised coverage and limits, see [Case backend and migration evidence](docs/case-backend-check.md), [Case browser evidence](docs/case-ui-check.md), [credential/protocol backend evidence](docs/backend-check.md), [credential/protocol browser evidence](docs/ui-check.md), [evaluation backend evidence](docs/evaluation-backend-check.md) and [evaluation UI browser evidence](docs/evaluation-ui-check.md). Fixture checks are unpaid; preview checks never send model calls. The evaluation UI evidence used a loopback decision-model fixture and does not claim real JEV access or quality.
