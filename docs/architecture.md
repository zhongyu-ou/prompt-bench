# Architecture

This document owns the current code structure, execution/storage boundaries and recorded design rationale. [API](api.md) and [Case API](case-api.md) own client-visible request/response contracts; [GLOSSARY](../GLOSSARY.md) owns domain vocabulary. Start at the [documentation index](README.md). Reusable checks belong in [verification](verification.md); historical measurements and migration observations belong in [evidence](evidence/validation.md), not in the current contract.

## System boundary

Promptbench is a single-user, loopback-only prompt workbench. It isolates prepared LLM input, Go prompt rendering, explicit comparison configurations, generation and independent single-pass evaluation from a complete production audio/translation/TTS pipeline. It does not retrieve context or truncate upstream history, and it does not use an Agent Evals account or platform database.

One Go process serves an embedded browser application and owns execution and PostgreSQL persistence. There is no external queue, frontend framework/bundler or service/repository layer. Generation currently uses OpenAI Chat Completions; decision-model metrics use Typesafe System One (JEV). Provider brand/model and protocol are separate concepts. Metric values are evidence under the selected rule, not an automatic claim about output quality.

## Repository and module ownership

- `main.go` is the thin process entry: it calls `workbench.Run()` and reports process failure.
- `internal/workbench/` owns application implementation, white-box tests and the embedded seed. Private constructor seams remain private; the root depends only on `Run`.
- `web/` exports embedded `Assets`, rooted at `index.html`. The server uses `http.FileServer(http.FS(web.Assets))` directly, without `fs.Sub`.
- `cmd/fixture/` is the standalone unpaid OpenAI-compatible HTTP fixture.
- `database/` is private local runtime/key material, not test fixtures. Historical private files and backups are not application source.

### Backend navigation

Paths below are relative to `internal/workbench/`.

| Responsibility | Source entry points |
|---|---|
| Process startup, launch flags and strict YAML | `run.go` (`Run`), `config.go` |
| HTTP security, common JSON helpers, state/preview/generation routes | `server.go` (`newAPI`, `ServeHTTP`, `decode`) |
| Domain/wire types, validation, prompt rendering and generation freeze | `model.go`, `render.go` (`validateState`, `renderRequest`, `freeze`) |
| Shared input definitions, compatibility and impact preview | `input_contract.go` (`validateContract`, `contractErrors`, `inputContractAPI`) |
| Case mutations, selection/routes, lossless package IO | `case_workflow.go`, `case_package.go` |
| Generation scheduling and upstream calls | `engine.go` (`newEngine`, `start`, `worker`, `call`) |
| Generation protocol contract/catalog | `protocol.go` (`Protocol`, `protocolCatalog`) |
| Metric definitions, targets, outcomes and summaries | `metric.go`; local trial route in `metric_api.go` |
| Bounded code runtime and native decision transport | `metric_code.go`, `metric_typesafe.go` |
| Independent evaluation sources, scheduling and routes | `evaluation.go`, `metric_engine.go`, `evaluation_api.go` |
| PostgreSQL, schema initialization and evaluation persistence | `store.go` (`openStore`), `migrate.go`, `evaluation_store.go` |
| Encryption, availability and redaction | `credentials.go`; credential state transaction in `store.go` |
| First-use configuration | `seed.go`, `seed.tmpl` |

Tests remain beside the implementation. `newTestStoreTarget`, `newHarness`, `fixtureState`, `h.api` and `h.wait` provide the existing isolated test seams; test execution requirements are in [verification](verification.md).

### Browser ownership

`web/js/main.js` boots native ES modules with direct named imports. `state.js` owns the session `App`; it is not a `window` global. Keep feature event handlers with their feature and cross-feature rendering in `main.js`.

| Area | Modules in `web/js/` |
|---|---|
| Shared state, values and transport | `state.js`, `constants.js`, `utils.js`, `model.js`, `api.js`, `feedback.js` |
| Shell, navigation, template and run configuration | `shell-view.js`, `navigation.js`, `workbench-view.js`, `templates.js`, `contracts.js`, `groups.js`, `selection.js`, `run-plan.js` |
| Versioned save/adoption and resource mutations | `persistence.js`, `mutations.js` |
| Case library, lossless editor and import/export | `case-library.js`, `case-editor.js`, `case-io.js` |
| Generation, output, frozen history and comparison | `runs.js`, `output.js`, `json-preview.js`, `snapshot.js`, `history-view.js`, `history.js`, `compare.js` |
| Metric authoring, version selection in output/preview/summary and independent execution polling | `metrics.js`, `evaluation.js`, `evaluation-summary.js`, `evaluations.js` |
| Connections, settings and startup composition | `providers.js`, `settings.js`, `main.js` |

`navigation.js`, `persistence.js` and `mutations.js` use concrete composition hooks installed by `main.js` for cross-feature rendering and state adoption. There is no barrel, event bus, exported handler registry or global-script API. Preserve dirty/edit-generation guards, stale-preview tokens, pending credential edits and numeric lexemes when adopting asynchronous responses.

`web/index.html` is the static shell and links ordered stylesheets in `web/css/`. Cascade order is behavioral: `responsive-base.css` precedes later workflow overrides; collecting all responsive rules at the end changes behavior. The former `web/app.js`, `web/case.js` and `web/style.css` are not current entrypoints. Assets are embedded at compilation, so serving a modified asset requires rebuilding/restarting the application; there is no frontend build step. Node's built-in runner is used by `web/*.test.mjs`, not by production serving.

## Startup and data flow

1. `Run` parses flags, reads strict nested `server`/`database` YAML, applies an explicit `--listen` override, validates loopback, then loads the optional Provider env file. Existing process environment wins. YAML database settings do not come from environment overrides; `--data-dir` selects only the private local credential-key directory.
2. The process binds the loopback listener before opening storage. `openStore(databaseURL, dataDir)` acquires the database/schema session lock, initializes/upgrades the schema, loads credential material and marks unfinished work interrupted. It then constructs `newEngine(store, getenv)` and `newAPI(store, engine, host)`.
3. The browser saves editable configuration with optimistic versions. Generic state PUT owns templates, shared input contracts, Providers, metrics, settings and draft; dedicated mutations own Cases and collections. State and credential updates commit atomically. A stale write cannot partially replace state or keys.
4. Generation preview and launch share `renderRequest`: resolve concrete Case/template/Provider, check the optional shared contract, resolve language targets, inject `TargetLanguageNameMap` into a copy, render messages and let the protocol adapter prepare exact request bytes. Preview makes no outbound call and requires no credentials. `freeze` captures the selected configuration, inputs, contract definitions and request bytes.
5. Immediately before launch, the engine rechecks the state version and resolves credentials under the same synchronization boundary as state/credential saves. Workers issue frozen requests, redact known sensitive echoes and persist results. The browser polls durable detail; it does not own execution lifetime.
6. Independent evaluation selects successful concrete Results from one terminal generation. It freezes source output, original Case/request context, metric definitions and targets. Code metrics run locally; model metrics use the separate decision transport. Each source output is judged once per selected metric and retained separately. Selecting metrics on a generation creates that same durable server-owned evaluation as a queued single-pass child, not an inline stage of generation.
7. The browser presents evaluation in the existing generation output table, result preview and summary, not a standalone evaluation workspace. One version selection supplies all three views: each independent execution stays separate from every other execution and from original inline evidence. Recalculation submits the current saved metric selection against all successful outputs of the loaded terminal generation, retaining their frozen source context; it creates a new execution without generation, even when an older subset version is displayed.

## Execution and history invariants

- **Explicit selection:** selected Case IDs and collection membership are unioned, deduplicated and temporarily excluded. Groups explicitly select a template, Provider, model, parameters, repeat count and language routes; target languages do not multiply calls. See [Case selection and rendering](case-api.md#selection-and-rendering) for ordering and exact routing semantics.
- **Prepared inputs:** Cases contain already prepared variables. Shared input contracts validate shape/meaning without coercion, defaults or upstream processing. A shared edit affects future uses of every referencing template; snapshots freeze definitions. Collections organize Cases and are not schemas.
- **Single execution owner:** at most one generation or independent evaluation runs/stops at a time, with at most 20 requests in flight globally. The only queued exception is the child attached to the active generation. There are no automatic retries or redirects.
- **Stop is not cancellation of an issued request:** unissued work is cancelled; issued requests finish and persist. Browser close/refresh does not stop work. Restart marks unfinished work interrupted rather than automatically resending something that may already have been billed. A persistence failure stops dispatch and requires process restart.
- **Immutable replay:** generation replay uses frozen generation protocol, endpoint, headers, body, timeout and concurrency; it never rebuilds from current templates/Cases or launches metrics. Evaluation replay reuses frozen successful sources/metrics/concurrency for one pass, never generates new text, and even a historical multi-round record replays as one pass without mutating the old outcomes. Both resolve current credentials at the original frozen references. Current credential changes cannot alter keys already resolved for an in-flight execution.
- **Separate evaluation identity:** concrete Result IDs distinguish groups and generation iterations. Every `(Result, Metric)` pair is judged exactly once; generation repetitions and valid-value denominators are different quantities. Historical `(Result, Metric, Round)` rows remain readable, but new records only use round 1. Only completed judgments enter value summaries. Generation owns original request/response bytes; evaluation copies context/output, not redundant transport payloads.
- **Version-local presentation:** selecting an evaluation never merges outcomes or summary denominators with another execution or inline history. A historical subset keeps its exact source coverage; absent outcomes remain absent. Historical multi-round versions use a round selector so the table, filters, preview and summary refer to one recorded round; inline evidence remains separately selectable. The UI's current-metric recalculation is a new execution, not frozen API replay or a rewrite of the displayed version.
- **Automatic one-pass evaluation:** when a generation request selects metrics, generation and its queued single-pass child are inserted atomically. Metric definitions freeze at launch; successful sources freeze at activation. Generation becomes terminal before the child starts and is never reopened by evaluation errors. Stopping generation stops its queued child; stopping that child alone does not stop generation. Startup never automatically activates queued children. No selected metrics means generation-only, with no decision-key lookup.
- **Legacy evidence remains legacy:** old inline evaluation fields and historical snapshot `after_generation_evaluation` metadata remain readable under their original generation; the snapshot field stays readable on GET/export and the stored blob is not rewritten, but it is never executed and whitespace-level HTTP byte identity is not guaranteed. New generation does not execute/populate inline outcomes, generation replay discards inline and chained configuration, and additive schema migration does not rewrite old outcome bytes.
- **Lossless input/history:** use `UseNumber` and raw `variables_json` paths rather than JavaScript float round-trips. Omitted, null, zero, literal strings, numeric lexemes and array order remain distinct. Import fingerprints canonicalize object-key ordering only. Preview, frozen/sent request and persisted request bytes must agree; redaction is the deliberate exception to exact raw preservation.

## Storage and migration

PostgreSQL is the sole runtime backend. Fresh empty schemas initialize atomically at `schema_version(id=1,version=2)`. Released schema1 upgrades additively to schema2 by creating `evaluations` and `evaluation_outcomes`; it does not rewrite state, generation snapshots, results or legacy inline outcome BYTEA. Evaluation outcomes have a unique `(evaluation_id,result_id,metric_id,round)` key and stable sequence ordering. Nonempty unversioned schemas, missing/invalid version rows, unsupported versions and newer versions are rejected before credential/recovery writes. Physical schema version is independent of optimistic `state.version`.

State, snapshots, summaries, results, encrypted credentials and migration archives use BYTEA; existing bytes and numeric literals are not normalized through JSONB. `created_at` remains TEXT. Historical snapshot/result/archive bytes remain immutable except unfinished records updated by normal recovery. Offline imports must preserve matching credential refs, ciphertext and local key material. Runtime does not open SQLite: historical SQLite schema2→3 is a different lineage, not a current startup migration. Concrete historical inventories and byte/hash comparisons are retained in [migration evidence](evidence/migrations.md), not asserted as today's database contents.

The advisory lock is scoped to the current database/schema and held by one physical SQL session. A second process using that schema fails before mutating live work, regardless of local key directory. Transactions serialize through the single session. The pool never silently reconnects after session loss: losing the session also loses lock ownership, so persistence/dispatch must fail and the process must restart. Use a direct connection or session pooling, never transaction pooling.

## Security and protocol boundaries

Loopback binding plus exact Host/supplied-Origin checks protects the single-user local HTTP surface; this is not a public authenticated multi-user server. HTTP decoding rejects unknown fields and uses number-preserving decoding. Generic role/content rendering is protocol-neutral. `Protocol` owns generation validation, request preparation, authorization and decoding; scheduling/storage do not parse Bearer headers or OpenAI choice fields. Decision capabilities are catalogued separately and cannot be selected for generation.

Providers share credential ownership regardless of capability. Manual overrides are write-only, AES-256-GCM encrypted and authenticated to an immutable reference. The private 32-byte `credentials.key` must be preserved with the database; missing/corrupt/mismatched material with encrypted records fails safely. Encryption protects a database-only copy, not an OS user who can read both database and key. Frozen requests contain no auth/cookie headers or keys; current authentication is injected only at issue time. Provider deletion retains historical credentials unless explicitly cleared, and recreating an ID receives a new reference. Exact client mutation/revocation semantics belong to [the credential API](api.md#state-and-write-only-credentials).

Do not put secrets into user-authored variables, templates, parameters or URLs: those inputs are persisted. Known key echoes are redacted before persistence, including escaped echoes, but arbitrary user data is not a secret store. Bounded local JavaScript is defense-in-depth, not a formal security certification or total-process RSS bound; the exact runtime/input/output limits are in [the code metric API](api.md#code-function-and-local-trial).

## Design decisions and rationale

These are recorded choices, not an authorization for deployment, migration or further redesign.

- **Shared editable contracts rather than copies/versions per template.** Compatible templates share one editable input definition and future changes together. Copy a contract when incompatible formats must coexist instead of adding contract versions and per-template upgrade workflows. Frozen snapshots, not mutable definitions, own historical evidence. Neither contracts nor collections reproduce retrieval/history truncation.
- **Independent evaluation rather than another generation pass.** Judging an existing output must not generate it again. One-source-batch selection avoids cross-batch ambiguity, concrete Result IDs preserve output identity, and each selected Result/Metric pair receives exactly one outcome. Historical multi-round records remain visible but are never extended. Selecting metrics on a generation chains the same evaluation once without merging their lifecycle. This replaces the original coupled execution design while preserving inline history.
- **Explicit capabilities and separate request interfaces.** JEV is decision-only, not a chat-generation adapter or hardcoded special connection. It reuses Provider credentials without forcing `state/questions` into a chat-message shape. A metric gets its own selected target and at most one model request, preserving target isolation and partial failures without discarding other successful judgments.
- **Go standard-library REST rather than an SDK sidecar.** The official SDK catalog reviewed for the decision listed Python and JavaScript/TypeScript, not Go; the reviewed SDKs' default retries conflicted with the visible-call/no-retry contract. Direct REST keeps the existing process and credential boundary. This is a documented basis, not a claim that SDK availability can never change.
- **Native JEV quantities rather than fabricated scores/reasons.** Noul probabilities use frozen thresholds; Score preserves its native fractional `0..N-1` range over ordered levels; Choice preserves declared labels. Confidence is not accuracy, and no model reason is invented. Exact character counting/arithmetic belongs in code metrics. The cited JEV 1.13 limitations are version-specific, not proof about later releases or account model access. The [native decision API section](api.md#native-typesafe-transport) links the official contracts.
- **Fresh bounded QuickJS rather than unbounded scripts or host-enabled WASI.** The recorded QuickJS probe supported allocator and execution limits without host bridges. The probed Goja version lacked an independent hard JavaScript-heap limit and required newer Go; the probed `fastschema/qjs` default exposed std/os/CWD and had a timeout teardown panic. Owning a custom WASI ABI just to close those holes added maintenance. These were observations about specific alternatives, not universal claims about their future versions.
- **One process, embedded native modules and durable PostgreSQL.** The local execution boundary does not require an external queue, frontend build or speculative service/repository layers. Native imports and concrete composition hooks preserve module ownership without an event bus. BYTEA storage and additive schema2 preserve frozen evidence rather than normalizing/reinterpreting it.

Exact official URLs, alternative versions, probe outputs and temporary artifact provenance are retained in [feasibility and alternative evidence](evidence/validation.md#feasibility-and-alternatives). That history explains the choices; it does not establish that the current checkout passes checks. Use [verification](verification.md) for a new scoped check, and keep its observations separate from this architecture contract.
