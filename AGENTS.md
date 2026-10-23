# Repository Guidelines

## Scope and entry points

Promptbench is a single-user, loopback-only prompt workbench with prepared Case inputs, Go prompt templates, explicit comparison groups, Providers, reusable metrics and durable history. Text generation and independent evaluation have separate records and lifecycles. User-configured judgments are not an implicit generation pass/fail gate; fixtures do not establish real model quality.

Read the root [README](README.md) for operations, checks and document navigation, [GLOSSARY](GLOSSARY.md) before changing concepts, and only the contracts relevant to the change. [Architecture](docs/architecture/overview.md) owns current responsibilities and cross-module constraints; its linked ADRs own consequential decisions and reasons. The [client contract](docs/architecture/client-contract.md) owns current HTTP semantics, including Cases and import/export. Resolve code/document conflicts in the same change, not with a dated correction appended later.

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

Use the root [README](README.md#development-checks) for commands, safe test database configuration and isolated fixture steps, and its operation sections for launch flags, backups and Docker.

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

- Give each durable fact one owner: operations and checks in README, concepts in GLOSSARY, current structure/constraints in the architecture overview, HTTP semantics in the client contract, and consequential decisions in ADRs. Other documents link rather than copy field contracts, module inventories or verification logs. Maintain current facts in place; do not append execution history.
- Documents describe repository behavior, not current deployment, process health or user inventory. Source/tests establish implementation, while current contracts establish intended behavior; resolve disagreements explicitly rather than promoting a bug or an unimplemented proposal into the contract.
- Keep approved but unimplemented behavior out of current contracts. Use `docs/tasks/<bounded-change>.md` only when unfinished work needs handoff; record current scope, confirmed choices/sources, open questions and next action rather than copied contracts or rounds of discussion. No task document is required for self-contained work.
- At completion, migrate still-valid knowledge to its owners and remove completed task material. A new requirement starts new bounded work. Verification limits or unperformed deployment do not create product requirements or authorize operations; do not create empty backlogs or retrospective change reports.
- Do not invent historical decision dates, approvals or universal claims from version-specific probes. ADRs record costly/surprising choices with real alternatives; no ADR index or template is required.
- Report actual verification results and limits in the response or change delivery by default; do not automatically create evidence documents, migration narratives or validation ledgers. Persist execution material only for an explicit audit/retention requirement or a concrete unresolved investigation, with a defined purpose and scope. Keeping an artifact does not make it part of default project context.
- Start investigations from current requirements, contracts, code, data and reproducible behavior. Consult relevant commits or historical artifacts only for a specific question that current state cannot answer. Old successful checks do not prove current correctness.
- Removing narrative documentation does not authorize deleting real backups, user data, images or original runtime artifacts. Never access secrets, live databases or backups merely to tidy documentation.
- After reorganizing documents, check local links and heading anchors. Keep the cleanup's own execution report out of permanent documentation.
