# Repository Guidelines

## Scope and entry points

Promptbench is a single-user, loopback-only prompt workbench with prepared Case inputs, Go prompt templates, explicit comparison groups, Providers, reusable metrics and durable history. Text generation and independent evaluation have separate records and lifecycles. User-configured judgments are not an implicit generation pass/fail gate; fixtures do not establish real model quality.

Read [docs/README.md](docs/README.md) for the documentation map and lifecycle, [GLOSSARY.md](GLOSSARY.md) before changing domain concepts, and only the contracts relevant to the change. The root [README](README.md) owns user operations; [architecture](docs/architecture.md) owns module responsibilities and consequential design rationale; [API](docs/api.md) and [Case API](docs/case-api.md) own current client semantics. Code/document conflicts must be resolved in the same change, not hidden with a dated correction at the end.

## Code ownership

- `main.go` is a thin entry calling `workbench.Run()`. Application implementation, embedded seed and white-box Go tests live in `internal/workbench/`; no separate `src/` tree or speculative service/repository layers.
- `web/embed.go` exports `Assets`, rooted at `index.html`. Browser assets are embedded at compilation: restart or rebuild after changing `web/`.
- `web/js/main.js` is the sole browser entry. Use native ES modules with direct named imports; no `window` globals, barrel or event bus. Install existing `configure*` composition hooks before startup. Detailed ownership is in architecture, not a second module inventory here.
- `web/index.html` owns stylesheet order. Preserve the existing `web/css/` cascade, including the original responsive rules before later workflow overrides.
- `cmd/fixture/` is an unpaid local generation fixture. `web/*.test.mjs` uses Node's built-in test runner. There is no frontend bundler, package manager, ORM or web framework.
- `database/` is a private credential-key directory, not a test fixture. Never use it for experiments.

## Implementation invariants

- Keep protocol behavior in `Protocol` adapters (`Validate`, `Prepare`, `Authorize`, `Decode`), not rendering or scheduling. Capabilities are not Provider brands: generation groups use text-generation protocols; model metrics use decision-capable protocols.
- Reuse `openStore(databaseURL, dataDir)`, `newEngine(store, getenv)` and `newAPI(store, engine, host)`. Environment lookup is injected as `func(string) string`; do not add global configuration machinery. Application database settings come only from strict YAML, not environment overrides.
- Keep PostgreSQL's single physical session and schema-scoped advisory lock. Session loss requires process restart; never silently reconnect or use transaction pooling. Do not reset data to bypass a migration/schema error. Preserve existing snapshot/result/request/ciphertext bytes and legacy inline outcomes.
- One active execution (generation or independent evaluation), at most 20 calls in flight globally. No automatic retries or outbound redirects. Stop cancels unissued work; issued requests finish and persist. Restart marks unfinished work interrupted, never safe to resend automatically.
- Preserve optimistic concurrency. Generic `PUT /api/state` uses `version`; Cases/collections belong to dedicated mutations using `state_version` and `mutateState`. Stale writes return 409. Generic saves must not rewrite Case JSON.
- Preserve JSON fidelity using `decode`/`decodeStored` (`UseNumber`) and raw `variables_json` paths. Omitted, null, zero and literal strings differ. Case form edits patch changed fields; imported numbers must not round-trip through JavaScript floats.
- Preview, sent and persisted request bytes must agree. Replay uses frozen inputs rather than current editable state. Import fingerprints normalize object-key order only; file IDs do not update existing Cases. API documents own the exact payloads and error rules.
- Evaluations freeze source selection, metrics, targets and model settings. Only completed judgments enter summary denominators. Do not convert legacy inline outcomes into independent evaluations or conflate generation repeats with evaluation rounds.
- Use `sendJSON`, `fail` and `statusFor`; errors are `{"error":"..."}`. `statusFor` defaults to 400, so internal failures need explicit classification.
- Frontend saves and version adoption belong to `persistence.js`/`mutations.js`; transport wrappers belong to `api.js`. Preserve dirty/edit-generation guards and stale-preview tokens so async responses cannot overwrite newer edits. Escape server text with `esc()` or `textContent`. UI copy is Chinese; machine statuses and backend errors are English.
- Keep credentials write-only; use existing credential helpers and redact upstream echoes before persistence. Never put secrets in state, snapshots, exports or logs. Preserve loopback binding, Host/Origin checks and JSON-only mutations.

## Commands and runtime safety

Use [Verification](docs/verification.md) for the command table, test setup and isolated smoke procedures; use the root README for launch flags, configuration, backups and Docker operation.

- Go 1.25+ is required; Node.js LTS is needed for JavaScript lint/tests, not asset building.
- `make ci-check` is the non-mutating formatting/lint/compile check and the GitHub Actions entry. `make check` runs `gofmt -w` first: do not use it when unrelated source formatting must remain untouched.
- `make test`, `test-backend` and `test-race` require an explicit test database ending in `_test`. Make may load the Git-ignored `.env.test`; direct `go test` needs the environment variable explicitly. Never load the application config or point tests at the application database.
- `go run . --help` returns before configuration, env-file or database access. Normal startup does not. `make run`/`make dev` conditionally load `.env`; direct `go run .` does not. Process environment wins over env-file values; manual Provider credentials override env credentials. Restart after YAML/env changes.
- Consult `.env.example`, `.env.test.example` and `config/config.example.yml`, never real secret files for exploration. Do not commit actual config, environment files, keys, locks or binaries. Backups require a PostgreSQL backup plus its matching `credentials.key`.
- Check planned call counts before using real Providers. Seeded groups default to 20 repeats per Case; fixture success does not authorize paid calls, deployment or user-data migration.

## Testing discipline

- Go tests use standard `testing`, `httptest`, local HTTP Providers and real isolated PostgreSQL schemas. Reuse `newTestStoreTarget`, `newHarness`, `fixtureState`, `h.api` and `h.wait`. Missing test database settings fail, never skip or fall back to real config. Cleanup closes stores before dropping only the test's newly created schema.
- Exercise public HTTP mutations rather than bypassing version checks through `h.save`. Use channel-controlled Providers for in-flight behavior, release blocked handlers in cleanup and bound asynchronous waits.
- Do not add `t.Parallel()` indiscriminately: protocol tests mutate the adapter registry. Restore modified globals.
- Protect consumer-visible invariants: byte equality, frozen replay, number fidelity, atomic failed writes, stale-version rejection, migration/history preservation, evaluation denominators, credential secrecy, concurrency limits and Stop/recovery behavior. There is no coverage-percentage target.
- Frontend behavior tests belong in `web/*.test.mjs`. For UI changes, exercise the affected flow in the browser with isolated data and fixtures; syntax checks and Node tests are not visual verification.
- Report checks actually run and their limits. Dry-run command expansion, compilation and historical evidence are not passing database tests or proof of real-provider access.

## Documentation closeout

Maintain current knowledge in place and link its owner; do not copy contract text or module lists into task records. Use `docs/tasks/<bounded-change>.md` only for unfinished work needing a handoff, with current state and next action. Approved but unimplemented designs stay there, not in current API documentation.

When a task completes, migrate durable facts to their owners, retain necessary evidence and remove the completed task after its unique information is preserved. New requirements get separate tasks. Do not create an empty backlog or turn verification limitations into product requirements.

Routine verification results belong in the response/change report, not a growing `*-check.md`. Persistent evidence is reserved for a real handoff, comparison, migration or audit need and belongs under `docs/evidence/`, with scope and limitations. Preserve irreplaceable migration evidence and available historical images; do not claim unavailable artifacts were restored. Check local links and anchors after reorganizing documents. See the documentation map for the complete retention policy.
