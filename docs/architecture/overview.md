# Architecture overview

This document owns current structure, responsibilities and cross-module constraints. The root [README](../../README.md) owns operations and checks, [GLOSSARY](../../GLOSSARY.md) owns concepts, and the [client contract](client-contract.md) owns HTTP semantics, including Cases, collections and import/export.

## System boundary

Promptbench is a single-user, loopback-only prompt workbench for prepared inputs, Go prompt rendering, explicit comparison configurations, generation and independent single-pass evaluation. It does not retrieve context, truncate upstream history or implement a production audio/translation/TTS pipeline. No Agent Evals account or platform database is involved.

One Go process serves embedded browser assets and owns execution and PostgreSQL persistence. There is no external queue, frontend framework/bundler, ORM or service/repository layer. OpenAI Chat Completions handles text generation; Typesafe System One (JEV) handles decision-model metrics. Provider brand/model and protocol are separate concepts. Metric values describe the selected rule, not an automatic claim of output quality.

## Module responsibilities

- `main.go` is the thin entry calling `workbench.Run()`. Application implementation, white-box tests and embedded seed live in `internal/workbench/`; constructor seams stay private.
- Startup and HTTP composition own strict configuration, loopback/Host/Origin checks, number-preserving JSON decoding and route dispatch. `openStore(databaseURL, dataDir)`, `newEngine(store, getenv)` and `newAPI(store, engine, host)` are the existing composition seams; environment lookup is injected.
- Rendering owns validation and generation freeze. Case operations own lossless edits, selection and package IO; input contracts own structural compatibility and impact preview. Protocol adapters own generation validation, preparation, authorization and decoding, not scheduling or storage.
- The engine owns generation scheduling and calls. Evaluation modules own frozen source selection, metric execution, outcomes and independent persistence. Code runtime and decision transport are separate execution boundaries; neither changes generation results.
- Storage owns PostgreSQL transactions, migrations, recovery and atomic state/credential saves. Credential helpers own encryption, availability and redaction.
- `web/` exports embedded `Assets` rooted at `index.html`; the server serves that filesystem directly. `cmd/fixture/` is an unpaid generation fixture. `database/` is private key material, never test data.

### Browser composition

`web/js/main.js` is the sole entry, using native ES modules and direct named imports. `state.js` owns session `App`, not a `window` global. Feature modules own their handlers; `main.js` composes cross-feature rendering through existing concrete hooks, without a barrel, event bus or exported handler registry.

`api.js` owns transport; `persistence.js` and `mutations.js` own versioned save/adoption. Preserve dirty/edit-generation guards, stale-preview tokens, pending credential edits and numeric lexemes across asynchronous responses. Output, preview and summary use the same selected evaluation version and, for historical multi-round records, the same round; they never fill missing judgments from another version. Recalculation uses current saved metrics against the loaded terminal generation's successful outputs, not the displayed version's subset.

`web/index.html` owns stylesheet order. `responsive-base.css` precedes later workflow overrides; moving all responsive rules to the end changes the cascade. Assets are embedded at compilation and require restart/rebuild after changes; Node's built-in tests are development tools, not a production asset build.

## Startup and data flow

1. `Run` parses flags, reads strict `server`/`database` YAML, applies explicit `--listen`, validates loopback and loads optional Provider env values. Process environment wins; database settings never come from environment overrides. `--data-dir` selects only the credential-key directory.
2. The process binds the listener, then opens storage, acquires the database/schema session lock, initializes/upgrades storage, loads key material and interrupts unfinished work before constructing engine and API.
3. The browser saves editable state optimistically. Generic state PUT owns templates, shared contracts, Providers, metrics, settings and draft; dedicated mutations own Cases and collections. State and credential edits commit atomically; stale writes cannot partially replace either.
4. Preview and generation share `renderRequest`: resolve Case/template/Provider, validate the optional contract, resolve language targets, inject `TargetLanguageNameMap` into a copy, render and prepare exact protocol bytes. Preview sends no request and needs no credential. Freeze captures inputs, definitions, configuration and prepared bytes.
5. Launch rechecks state version and resolves credentials under the same synchronization boundary as saves. Workers issue frozen requests, redact known sensitive echoes and persist results. Browser polling observes durable execution; it does not own its lifetime.
6. Independent evaluation freezes successful concrete Results from one terminal generation, original input/request context, metric definitions and targets. Each source/metric pair is judged once. Selecting metrics at generation launch atomically creates the same evaluation as a queued server-owned child, activated only after generation becomes terminal.

## Execution and history constraints

- **Explicit inputs and configurations:** selection unions Case IDs and collection membership, deduplicates and applies temporary exclusions. Groups explicitly choose configurations; multiple language targets do not multiply requests. Exact ordering and routes belong to the [client contract](client-contract.md).
- **Shared prepared-input contract:** contracts validate without coercion, defaults or upstream processing. Edits affect future referencing templates; snapshots freeze definitions. Collections organize inputs, not schemas. See [shared contract decision](../adr/0002-shared-input-contracts.md).
- **Single owner:** at most one generation or independent evaluation runs/stops, with at most 20 calls globally. The child attached to active generation is the only queued exception. No automatic retries or redirects.
- **Stop/recovery:** Stop cancels unissued work; issued requests finish and persist. Browser closure does not stop work. Restart interrupts unfinished work without resending possibly billed calls; persistence failure stops dispatch and requires restart. Startup never activates queued children automatically.
- **Separate identities:** generation owns transport bytes and outputs; evaluation owns frozen source context, rules, status and judgments. Only completed judgments enter value-summary denominators. Historical multi-round and inline outcomes remain readable, not extended or merged. See [generation/evaluation decision](../adr/0001-independent-generation-and-evaluation.md).
- **Frozen replay:** generation replay uses original request configuration and never launches metrics. Evaluation replay uses frozen sources/rules for one pass and generates no text, including replay of an old multi-round record. Both resolve current credentials at frozen immutable references; changes cannot replace keys already resolved in flight.
- **Server-owned chaining:** metric definitions freeze at generation launch and successful sources at child activation. Evaluation failure never reopens generation. Stopping generation stops its queued child; stopping the child alone does not stop generation. No selected metrics means no child or decision-key lookup.
- **Legacy preservation:** old inline fields and `after_generation_evaluation` snapshot metadata remain readable on GET/export but never execute or become new write input. Generation replay discards them. Stored blobs are not rewritten; HTTP whitespace-level byte identity is not promised.
- **Lossless history:** `UseNumber` and raw `variables_json` paths preserve numeric lexemes; omitted, null, zero, strings and array order differ. Import fingerprints normalize object-key order only. Preview, sent and persisted request bytes agree; known-secret redaction is the deliberate exception to exact raw-response preservation.

## Storage and migration

PostgreSQL is the sole runtime backend. Empty schemas initialize atomically at `schema_version(id=1,version=2)`. Released schema1 upgrades additively with `evaluations` and `evaluation_outcomes`, without rewriting state, generation snapshots/results or legacy inline BYTEA. Outcome identity includes evaluation, Result, metric and historical round, with stable sequence ordering. Invalid, nonempty unversioned, unsupported and newer schemas fail before credential/recovery writes. Physical schema version is independent of optimistic `state.version`.

State, snapshots, summaries, results, encrypted credentials and migration archives use BYTEA; JSONB normalization must not change their bytes or numeric literals. `created_at` remains TEXT. Historical bytes remain immutable except unfinished records changed by normal recovery. Offline imports preserve refs, ciphertext and matching key material. Runtime never opens SQLite; its old schema numbering is unrelated to PostgreSQL's.

One physical SQL session serializes transactions and holds the database/schema advisory lock. A second process fails before live mutation, regardless of key directory. Session loss forbids reconnect/dispatch until process restart; direct connections or session pooling are required, never transaction pooling. See [session ownership decision](../adr/0003-postgres-session-ownership.md).

## Security and metric execution boundaries

Loopback plus exact Host/supplied-Origin checks protects a single-user local surface, not a public authenticated service. Protocol adapters own authorization and wire decoding; scheduling/storage do not parse Bearer headers or OpenAI choice fields. Decision-capable Providers cannot serve generation groups.

Manual credentials are write-only AES-256-GCM records authenticated to immutable references. Preserve the private 32-byte `credentials.key` with the database; missing/corrupt/mismatched material with encrypted records fails safely. Encryption protects database-only copies, not an OS user with database and key. Authentication is injected at issue time, never frozen with requests. Deletion retains historical credentials unless cleared; recreating an ID gets a new reference. User-authored variables, templates, parameters and URLs are persisted, not secret storage. Exact mutation/revocation behavior belongs to the [client contract](client-contract.md#state-and-write-only-credentials).

### Native decision transport

JEV uses a separate Go standard-library REST transport and shared Provider credential ownership, rather than coercing `state/questions` and typed answers into chat messages. One selected target per metric call isolates targets and partial failures. Noul retains probability and frozen threshold; Score retains its native ordered-level fractional scale; Choice retains declared labels. Confidence is not correctness and no free-form reason is fabricated.

The recorded selection research used the official [SDK catalog](https://docs.typesafe.ai/sdk.md), [System One contract](https://docs.typesafe.ai/api/system-one.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), [Score](https://docs.typesafe.ai/primitives/score.md), [Choice](https://docs.typesafe.ai/primitives/choice.md) and [SDK retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md). The catalog then listed Python and JS/TS, not Go; default retries conflicted with visible-call/no-retry ownership. This explains direct REST, not an assertion about future SDK availability. [JEV 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) motivated using code for exact counting/arithmetic; they do not establish limitations of every later model. These are recorded design sources, not newly verified remote service or account-access evidence.

### Bounded code runtime

Each code judgment gets a fresh QuickJS VM with no host/module bridges and bounded execution/allocation, plus input/output and concurrency limits. The selection probe used `modernc.org/quickjs v0.24.2`, demonstrated interruption and allocation limits, and found no exposed std/os/process/filesystem/network bridges in its basic probes. The then-probed Goja lacked an independent JavaScript heap limit and required newer Go; `fastschema/qjs v0.0.6` exposed std/os/CWD by default and exhibited timeout teardown panic. Owning a replacement WASI ABI added maintenance without improving this boundary. These are version-specific selection observations, not claims about all later alternatives.

The allocator quota is not a total-process RSS bound or formal sandbox certification. Timeout/OOM must not be downgraded into a valid metric value; unsafe thrown objects must not be converted through attacker-controlled behavior. Exact runtime/input/output constraints belong to the [client contract](client-contract.md#code-function-and-local-trial).
