# Repository Guidelines

## Project Overview

Promptbench is a single-user, loopback-only prompt workbench: edit Cases and Go prompt templates, configure explicit comparison groups and Providers, preview requests, run repeated calls, and inspect durable history. It currently supports OpenAI Chat Completions. It does not judge output quality; the local fixture verifies transport and lifecycle, not model behavior.

## Architecture & Data Flow

- One flat Go `package main`, an embedded vanilla-JavaScript SPA, and local SQLite (`modernc.org/sqlite`). No framework, ORM, frontend bundler, or external database.
- Startup: `main.go` loads optional environment values, validates loopback binding, opens/locks storage, constructs `newEngine(store, getenv)` and `newAPI(store, engine, host)`, then serves HTTP.
- Execution: browser saves configuration → `/api/preview` or `/api/runs` → `renderRequest`/`freeze` → immutable request snapshot → engine workers → upstream HTTP → redacted persisted results. The browser polls run detail; replay uses the stored snapshot, not current configuration.
- Current editable state is one versioned JSON document. SQLite also stores batches, results, encrypted credentials, and migration archives. Store locking and a single DB connection serialize writes; an exclusive data-directory lock prevents multiple processes sharing state.
- Exactly one active batch; at most 20 requests in flight globally. No automatic retries or redirects. Stop cancels unissued attempts only; in-flight requests finish and persist. Restart marks unfinished work interrupted, not safe to resend automatically.
- Cases are `{id, variables}` inputs. Collections reference Cases; groups choose template, Provider, model, parameters, repeats, and language routes. Selection unions Case IDs and collection membership, deduplicates, then excludes temporary omissions. See `GLOSSARY.md` before changing these concepts.

## Key Directories

- Root Go files: backend, domain types, persistence, execution, and white-box tests; no separate `src/` tree.
- `web/`: embedded HTML/CSS and global scripts. `app.js` loads before `case.js`; both share `App` state and API helpers.
- `cmd/fixture/`: standalone, unpaid OpenAI-compatible HTTP fixture.
- `docs/`: API contracts and backend/browser QA evidence; `docs/tasks/` contains historical task context.
- `database/`: private local runtime state, not fixtures. Never use it for experiments or tests.

## Development Commands

```sh
make help                      # available targets
make run                       # loads .env if present
make run ARGS="--help"          # application flags
make build                     # builds ./promptbench, including web assets
make test                      # go test ./...
go test -race ./...             # concurrency regression check
go test ./... -run TestName     # targeted test
```

No repository lint target/config exists. Use standard `gofmt` for changed Go files; `go vet ./...` is available as an additional check. Optional frontend syntax checks: `node --check web/app.js` and `node --check web/case.js`.

For isolated smoke work, use two terminals:

```sh
go run ./cmd/fixture --listen 127.0.0.1:9797 --delay 150ms
go run . --listen 127.0.0.1:8788 --data-dir /tmp/promptbench-smoke
```

Configure a Provider at `http://127.0.0.1:9797/v1` with no credential env name and select it in a group. Models `fixture-http-error` and `fixture-invalid-json` exercise failures; increase `--delay` to observe Stop/progress. Check the planned request count before using real Providers: initial groups default to 20 repeats per Case.

## Code Conventions & Common Patterns

- Follow existing Go naming and `gofmt`; domain/wire types live in `model.go`. Keep protocol-specific behavior in `Protocol` adapters (`Validate`, `Prepare`, `Authorize`, `Decode`), not rendering or scheduling.
- Reuse constructor seams: `openStore(path)`, `newEngine(store, getenv)`, and `newAPI(store, engine, host)`. Environment lookup is injected as `func(string) string`; avoid new global configuration machinery.
- Preserve optimistic concurrency. Generic `PUT /api/state` uses `version` and only edits templates, Providers, settings, and draft. Dedicated resource mutations use `state_version` and `mutateState`; stale writes return 409. Cases/collections cannot be written through generic state PUT.
- Preserve JSON fidelity: use existing `decode`/`decodeStored` (`UseNumber`) and raw `variables_json` paths. Omitted, `null`, zero, and literal strings are distinct. Case form edits send changed-field patches; do not round-trip imported numbers through JavaScript floats.
- Preview, sent request, and persisted request bytes must agree. Preserve frozen history and raw-body/hash fidelity; migrations must not rewrite historical snapshot/result blobs. Import fingerprints canonicalize object-key order only; file IDs never update existing Cases.
- Use `sendJSON`, `fail`, and `statusFor`; API errors are `{"error":"..."}`. `statusFor` defaults to 400, so internal failures need explicit handling rather than accidental validation errors.
- Frontend: reuse `App`, render functions, `apiRaw` wrappers, and `stateMutation`. Preserve dirty/edit-generation guards and stale-preview tokens so async responses cannot overwrite newer edits. Escape interpolated server text with `esc()` or use `textContent`. UI copy is Chinese; machine statuses and backend errors are English.
- Keep manual credentials write-only; resolve them through existing credential helpers and redact upstream text before persistence. Never serialize secrets into state, snapshots, exports, or logs. Preserve Host/Origin checks and loopback-only binding.

## Important Files

| Files | Responsibility |
| --- | --- |
| `main.go`, `server.go` | Flags, lifecycle, embedded assets, HTTP security/routing/JSON helpers |
| `model.go`, `render.go` | Domain/wire types, validation, templates, previews, frozen run plans |
| `engine.go`, `protocol.go` | Scheduling, HTTP execution, protocol boundary |
| `store.go`, `migrate.go`, `credentials.go` | SQLite, locking/recovery, schema upgrades, encryption/redaction |
| `case_workflow.go`, `case_package.go` | Cases, collections, selection, lossless edits, JSON/JSONL import/export |
| `seed.go`, `seed.tmpl` | First-run example configuration and prompt |
| `Makefile`, `go.mod`, `.env.example` | Commands, Go/dependency versions, credential env examples |
| `docs/api.md`, `docs/case-api.md` | API contracts; consult before changing endpoints |

## Runtime/Tooling Preferences

- `go.mod` requires Go 1.25.0 or newer; use Go modules. SQLite is pure Go, with no external DB or C compiler needed. Node is optional for JS syntax checks; there is no npm/Bun build or package manager workflow.
- Defaults: `--listen 127.0.0.1:8787`, `--data-dir database`, no env file. `make run` conditionally passes `--env-file .env`; direct `go run .` does not load it automatically. Process environment wins over env-file values; restart after changing them.
- Manual Provider credentials override env credentials. Seeded env names are `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_4O_KEY`; consult `.env.example`, never real `.env` contents.
- Assets are embedded at compilation: restart `go run .` or rebuild the executable after changing `web/`.
- Never commit `.env`, SQLite files, `credentials.key`, locks, or built binaries. For backups, stop the app and preserve both `promptbench.sqlite` and its matching `credentials.key`. Do not reset real data to bypass migration errors or unsupported schema versions.

## Testing & QA

- Tests use standard `testing`, `httptest`, real temporary SQLite, and local HTTP Providers; no paid service required. Reuse `newHarness`, `fixtureState`, `h.api`, and `h.wait` in `backend_test.go`, with `t.TempDir()` and injected env lookup.
- Exercise public HTTP mutations rather than using `h.save` to bypass version checks. Use channel-controlled Providers for in-flight scheduling/credential tests, release blocked handlers in cleanup, and bound asynchronous waits.
- Do not add `t.Parallel()` indiscriminately: protocol tests mutate the global adapter registry. Restore any modified globals.
- Protect consumer-visible invariants: preview/sent/persisted byte equality, frozen replay, number fidelity, atomic failed writes, stale-version rejection, migration/history preservation, credential secrecy, concurrency cap, and Stop/recovery behavior.
- There is no configured coverage percentage or frontend automated test suite. `docs/backend-check.md` and `docs/case-backend-check.md` record backend evidence; `docs/ui-check.md` and `docs/case-ui-check.md` record actual browser checks. These are scoped historical evidence, not proof that current changes pass.
- For UI changes, run the app with isolated data and the fixture, exercise the affected browser flow, and record relevant evidence/limitations. Fixture success never establishes real-provider access or translation quality.
