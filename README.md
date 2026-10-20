# Promptbench

A standalone local prompt workbench: real Go `text/template` rendering, editable cases/templates/Providers, explicit comparison configurations, repeated concurrent calls through a protocol adapter, and durable SQLite history. The currently implemented protocol is **OpenAI Chat Completions**; provider brand/model is separate, and native protocols can be added behind the prepared-request/parser boundary without changing scheduling/storage. No unimplemented native vendor options are advertised. No Agent Evals account, platform database, scoring or quality judge. Vanilla browser assets are embedded; no Node build.

## Run

Requires Go 1.25+ on macOS or Linux. SQLite uses the pinned pure-Go `modernc.org/sqlite v1.39.1` driver; no C compiler or external database service is required. Initial `go run` downloads Go modules.

```sh
cd /Users/tmk/Documents/work/timekettle/workspace/promptbench
go run . --env-file "$HOME/.config/promptbench/keys.env" --listen 127.0.0.1:8787
```

Open the exact printed URL, normally **http://127.0.0.1:8787**. `--env-file` is optional: use environment keys, a manually entered Provider override, or an explicitly anonymous fixture. Public binds are rejected; `localhost` normalizes to `127.0.0.1`, and literal IPv6 loopback is supported. A hostname different from the printed URL is deliberately rejected.

Create your own private credentials file (do not copy another project's `.env`):

```sh
mkdir -p "$HOME/.config/promptbench"
chmod 700 "$HOME/.config/promptbench"
# Edit $HOME/.config/promptbench/keys.env with your actual credentials:
# AZURE_OPENAI_API_KEY=...
# AZURE_OPENAI_4O_KEY=...
chmod 600 "$HOME/.config/promptbench/keys.env"
# .env.example in this project is an empty reference, not a credential source.
```

The env file accepts blank/comment lines, `NAME=value`, `export NAME=value`, single-quoted literals and Go-style double-quoted escaped strings. No shell execution/expansion. Existing process environment overrides env-file values. Provider manual override takes priority over its configured env key; an untouched/blank password field preserves the existing override. Explicit **Clear** removes it and falls back to env. An initial blank field uses env, or anonymous mode only when the env reference is also empty. Missing/invalid required credentials fail before calls, never downgrade authenticated history to anonymous. Restart to reload env-file changes; manual override edits take effect on later batches/replays without restart. Each in-flight batch retains its initially resolved key. Shared env names do not merge separate provider overrides.

## Manual credentials and protocol types

Provider management lists the actual protocol catalog from `/api/protocols`; currently only `openai-chat-completions` is supported. Its base URL ends in `/v1` and it appends `/chat/completions`. Role/message rendering is generic; the adapter owns endpoint/method/nonsecret headers/body, runtime authentication and response decoding. Replay freezes protocol, endpoint, nonsecret headers and exact body, but resolves current credentials at the frozen immutable reference. There is no speculative plugin framework or vendor SDK.

Type a new key into the Provider password field to replace the manual override, then save. Passwords are write-only transient edits: GET/state/history/export never return a value or masked replacement. Nonsecret metadata reports actual manual/env/anonymous/missing/invalid availability, not just a configured env name. State and credential saves commit atomically with one optimistic version; stale tabs cannot mix old endpoint configuration with newly replaced keys.

Manual keys are AES-256-GCM encrypted in SQLite using private generated `credentials.key` under the owner-only data directory. The keyfile is32 bytes and must be backed up with the database. Missing/corrupt/mismatched master material with encrypted rows fails safely, never generates a replacement or pretends no override exists. This is local-at-rest protection for database-only copies, **not protection from the same OS user who can read both files**. Actual keys never enter editable state, frozen providers, raw requests, exports or logs; known upstream key echoes are redacted, including escaped JSON forms. Never paste keys into case variables/template/model parameters/URL: arbitrary user-authored data is persisted.

Deleting a Provider intentionally retains its encrypted override for historical replay. To revoke it, **Clear before deleting or Clear and delete in the same save**; otherwise the historical reference remains usable. Recreating the same Provider ID gets a new reference and cannot inherit/read an old secret. Clear/removal does not cancel or change an already-started batch. An authenticated original whose credential is no longer available fails replay unless its frozen env reference supplies a valid fallback.

Initial state contains four real ASR input cases copied from `scripts/evaluation/tmp_run_luna_prompt_base.py` and the supplied `luna_prompt_results/user_template_20261015/prompt.tmpl`, embedded locally as `seed.tmpl`. These files are not read from Agent Evals at runtime. The Luna and GPT-4o providers are examples using the supplied URLs and env names; no key is included. **No requests or fabricated history are created at startup.** Check configurations and the visible request count before running: default repeats are 20 per case per enabled group and may incur real provider charges.

## Workbench behavior

- Save cases, ordered role/content messages, providers, global defaults and the draft together. Cross-tab stale saves/previews/runs return 409 rather than silently selecting different inputs.
- Preview renders the same messages, roles and JSON parameters as execution. Standard Go template `if`, `range`, map ordering, whitespace trimming and builtins are used unchanged; no filesystem/process/network functions are exposed.
- Add each comparison configuration explicitly. No hidden Cartesian product. Each enabled group specifies its own model, parameters, template, provider and repeat count. An omitted temperature/reasoning parameter is not the same as an explicit `null`, `0` or `"none"`; Promptbench does not silently rewrite unsupported parameters.
- One active batch at a time, with 1–20 concurrent calls across **all groups/cases**. A second start or replay returns an explicit 409 while a batch is running/stopping. Requests interleave group within case within repeat. No automatic retries or outbound redirects.
- Refreshing/closing the browser does not stop backend execution. Stop cancels only unissued attempts; in-flight calls finish and persist. Graceful server shutdown stops unissued work and waits for issued calls (up to their configured timeout).
- Every attempt is visible as pending/running/completed/failed/cancelled/interrupted. History preserves frozen input sources, endpoint, requested/returned model identities, parameter presence, rendered request bytes, raw response, HTTP errors, decode errors and duration. There is no quality judgment.
- Replay creates a new batch from the old frozen snapshot even if current cases/templates/providers were changed or deleted. It does not silently resend on restart. Missing credentials fail before sending any calls.
- A crash/restart marks unfinished work interrupted/unknown. An unknown response may still have been billed; Promptbench never assumes it was safe to resend. A second server using the same data directory is rejected by an exclusive process lock before any recovery writes.

## Persistence, backups and limits

Default data directory: **`$HOME/.promptbench`**. SQLite file: `promptbench.sqlite`; owner-only directory/file permissions are enforced. `promptbench.lock` is an advisory process lock, released automatically when the process exits; its leftover filename is harmless. Use a dedicated directory, since Promptbench restricts its permissions.

```sh
go run . --listen 127.0.0.1:8788 --data-dir /tmp/promptbench-isolated
# Or build a self-contained executable with the current web assets:
go build -o promptbench .
./promptbench --listen 127.0.0.1:8787 --data-dir "$HOME/.promptbench"
```

Flags: `--listen` (default `127.0.0.1:8787`), `--data-dir` (default above), `--env-file` (default empty). `--help` prints usage. Stop the server, then copy **both `promptbench.sqlite` and `credentials.key`** for a consistent backup; restore matching files into a stopped server's private directory. Preserve the keyfile even if the database is moved. Per-batch Download JSON is a read-only history export, not state import or a credential backup. No automatic history deletion; watch disk use. Legacy env-only state/history migrates additively once, preserving user edits, original request bytes/hashes and results. A newer unsupported database schema is rejected, not downgraded.

Limits: 8 MiB inbound JSON, 1 MiB rendered content per message, 16 MiB captured response body per attempt, 100000 attempts per batch, 1000 repeats per group and 3600-second maximum request timeout (default 120). Oversized response capture fails explicitly and retains its prefix. These are local accident guards, not a sandbox for untrusted templates; Go template builtins can still perform substantial computation. Non-UTF-8 response bytes are preserved in `raw_response_base64`. Actual resolved keys echoed by upstream are redacted before persistence/UI/export; redaction is the intentional exception to exact raw-response preservation. Auth headers are never persisted. Provider URLs with credentials/query/fragment are rejected. The local API checks Host/Origin, requires JSON mutations and does not enable CORS.

## Local verification without paid services

```sh
go test ./...
# Terminal 1: an HTTP fixture, NOT a real model or quality assessment:
go run ./cmd/fixture --listen 127.0.0.1:9797 --delay 150ms
# Terminal 2: separate smoke-test state; do not contaminate your normal history:
go run . --listen 127.0.0.1:8788 --data-dir /tmp/promptbench-browser-smoke
```

In the workbench at `http://127.0.0.1:8788`, configure a provider with base URL `http://127.0.0.1:9797/v1` and empty credential env name, then point explicit groups at it. Any model name returns an unmistakably labeled fixture echo with a distinct returned-model identity. Model `fixture-http-error` returns HTTP 422; `fixture-invalid-json` returns a decode failure. Set a longer fixture `--delay 1s` to observe progress, refresh and stopping. Inspect history, frozen request/response details, replay and Download JSON. This only verifies HTTP/lifecycle/UI integration; it does **not** verify Azure, model access, model behavior or translation quality.

The Go behavior tests exercise actual HTTP fixture calls for Go template conditions/ranges/whitespace/dynamic targets, byte equality between preview/sent/persisted requests, roles/parameters/endpoint freezing, >53-bit JSON numbers, immutable replay after source deletion, rotated/missing keys, redacted upstream success/HTTP failure/decode errors, binary response preservation, zero retries, global cap, comparison interleaving, stop semantics, browser-independent execution, restart recovery, exclusive data locking, stale state versions, export secrecy, hostile Host/Origin, unsafe binds, invalid parameters and disabled redirects.

Credential fixture smoke (synthetic values only): run the fixture with `PROMPTBENCH_FIXTURE_MANUAL_KEY=fixture-manual-only PROMPTBENCH_FIXTURE_ENV_KEY=fixture-env-only go run ./cmd/fixture --listen 127.0.0.1:9797`. Run isolated app with `FAKE_PROVIDER_ENV=fixture-env-only go run . --listen 127.0.0.1:8788 --data-dir /tmp/promptbench-credential-ui`. Set Provider env name `FAKE_PROVIDER_ENV`, manual key `fixture-manual-only`, model `fixture-auth-manual`: output says `AUTH MATCH: manual`. Clear the override and use `fixture-auth-env`: output says `AUTH MATCH: env`. Wrong auth returns401; actual credential values are never echoed. Do not use real secrets or default user data for these checks.

See [docs/api.md](docs/api.md) for the precise JSON contract.

Executed evidence: [backend tests and final launch](docs/backend-check.md), [real-browser UI checks and screenshots](docs/ui-check.md). Both use unpaid local fixtures, not real-model quality evaluation.

The project-root `./promptbench` executable embeds the final web assets. Start it without rebuilding: `./promptbench --env-file /path/to/your/private/keys.env`. The `go run .` alternative above remains available.

The credential-enabled delivery is running at **http://127.0.0.1:8787** using preserved `$HOME/.promptbench` state, upgraded without resetting user edits/history. The final build passed `go test -race ./...`; private pre-upgrade and matching database/keyfile backups are under that data directory's `backups/`. Exact PID, binary hash, state-preservation comparisons and read-only health checks are in [backend-check.md](docs/backend-check.md). Before manually restarting an existing instance, wait for active batches and stop it gracefully; never reset the database to obtain a fresh process.
