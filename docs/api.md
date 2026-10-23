# Promptbench local API

JSON at the UI's same origin. Errors: `{ "error": "message" }`; arrays have no envelope. Mutations require `Content-Type: application/json` (stop/replay accept `{}`). No CORS. Host must match the printed loopback address; supplied Origin must match. Times are UTC RFC3339Nano; IDs are opaque.

This document owns the state, credential, generation and evaluation HTTP contracts.
See [Case API](case-api.md) for Case/collection mutations, selection and packages;
[architecture](architecture.md) for module ownership, storage/session constraints
and design rationale; [verification](verification.md) for reusable check procedures.
Historical evidence is not a claim that the current checkout has passed them.

JSON request bodies are limited to 8 MiB, contain exactly one JSON value and reject
unknown struct fields. JSON numbers are decoded without float normalization.
Malformed/invalid input normally returns 400, missing resources 404, stale state
or active-execution conflicts 409, and unsupported content types 415. Storage/read
failures may return 500; the endpoint-specific evaluation error handling is
described below. Host/Origin rejection returns 403.

## Providers and protocol catalog

Provider: `{id,name,protocol,base_url,api_key_env,credential_ref}`. Brand/model names do not determine protocol. `protocol` is required on new saves. Only a genuine implemented adapter is advertised; unknown protocols fail before any request.

`GET /api/protocols` returns the implemented generation and decision catalog:
```json
[{"id":"openai-chat-completions","name":"OpenAI Chat Completions","base_url_hint":"Base URL ending in /v1; /chat/completions is appended","credential_hint":"Manual key overrides environment; empty env plus no manual key explicitly permits anonymous requests","roles":["system","developer","user","assistant"],"reserved_parameters":["model","messages","stream"],"parameter_hints":["temperature","reasoning_effort"],"capabilities":["generation"]},{"id":"typesafe-systemone","name":"Typesafe SystemOne","base_url_hint":"https://api.typesafe.ai/v1; /systemone is appended","credential_hint":"Manual key overrides environment; authentication required","roles":[],"reserved_parameters":[],"parameter_hints":[],"capabilities":["decision"]}]
```
Use `capabilities` to filter Providers for generation versus model metrics, and the
remaining metadata for options/hints, not hardcoded vendor names. No native
Anthropic/Gemini adapter is implemented or advertised. Generation preparation and
decision transport have separate request shapes; neither infers protocol from a
brand/model name.

## State and write-only credentials

`GET /api/state` example (credential availability is computed from actual backend state):
```json
{"version":1,"cases":[{"id":"9cbd7a175f2b4204a153905f4b817d49","variables":{"CurrentText":"Hello","SourceLanguage":"en"},"variables_json":"{\"CurrentText\":\"Hello\",\"SourceLanguage\":\"en\"}"}],"collections":[],"templates":[{"id":"asr","name":"ASR","messages":[{"role":"user","content":"{{.CurrentText}}"}]}],"input_contracts":[],"providers":[{"id":"luna","name":"Luna","protocol":"openai-chat-completions","base_url":"https://example.openai.azure.com/openai/v1","api_key_env":"AZURE_OPENAI_API_KEY","credential_ref":"cred_example"}],"metrics":[],"settings":{"default_runs":20,"concurrency":20,"timeout_seconds":120},"draft":{"name":"Comparison","case_ids":["9cbd7a175f2b4204a153905f4b817d49"],"collection_ids":[],"excluded_case_ids":[],"groups":[{"id":"luna","name":"Luna","enabled":true,"template_id":"asr","provider_id":"luna","model":"example-model","parameters":{"reasoning_effort":"none"},"runs":20,"language_routes":[]}],"metrics":[]},"credentials":{"luna":{"manual_set":false,"env_available":false,"source":"missing","available":false,"requires_auth":true}}}
```
`credentials` is separate read-only metadata keyed by provider ID; it is not part of persisted editable state. `source`: `manual`, `env`, `anonymous`, `missing`, `invalid`. `manual_set` indicates stored override presence, not its value. `env_available` means a currently valid actual env value, not merely a configured name. `available` indicates a usable resolved credential or explicit anonymous endpoint. `requires_auth` is true when a manual override exists or an env name is configured.

`PUT /api/state` accepts optimistic `version` and editable `templates,input_contracts,providers,metrics,settings,draft`, plus optional write-only:
```json
{"credential_updates":{"luna":{"action":"set","key":"new private value"},"other":{"action":"clear"}}}
```
The snippet is added to the normal editable state body, not submitted alone. Omit cases/collections: those resources are server-owned through the [Case workflow API](case-api.md). They are retained exactly, including JSON numeric literals; explicit mutations in PUT are rejected (unchanged plain resource echoes are accepted). Stale409 precedes old Case schema validation. Missing credential mutation entries retain overrides. Blank passwords omit their entry; never submit a mask. `set` requires nonblank input without surrounding whitespace/control characters, maximum16KiB. `clear` must not carry a key and removes the override, falling back to env. `clear` may target an EXISTING provider removed in the same save; `set` for removed providers and unknown IDs fail. This permits atomic revocation+deletion. Provider deletion without clear retains encrypted material for historical replay; **clear before deletion or in the same save to revoke it**.

Every state/credential PUT commits together and increments state version, including credential-only changes. Stale409 or invalid saves modify neither. Response is normal state plus recomputed metadata, never keys or `credential_updates`. Echoed `credentials` metadata is accepted but ignored/recomputed. Errors never echo pending passwords.

`credential_ref` is generated by the backend for new providers (omit/empty when creating); preserve it for existing providers. Client-assigned new refs, changed existing refs, duplicate refs and reuse/resurrection of retained history refs are rejected. Two profiles sharing an env name still have independent manual overrides. Deleting then recreating a provider ID gets a new ref, never an old credential.

Resource IDs are unique within each resource type; a Case may belong to multiple collections. Draft references must exist, including disabled groups; delete/update references atomically. Empty collections/draft are allowed. URL must be HTTP(S), without userinfo/query/fragment. Template syntax is validated on save. Current adapter reserves `model`, `messages`, `stream` (streaming unsupported). Auth-like top-level parameters `authorization`, `api_key`, `api-key`, `apikey`, `headers`, `extra_headers` are rejected case-insensitively. Other fields are passed unchanged: omission differs from null/zero/`none`; no temperature/reasoning defaults. Runs1–1000; concurrency1–20; timeout1–3600s.

Manual overrides are AES-256-GCM encrypted in PostgreSQL, authenticated to their ref, using private 32-byte `credentials.key` in the owner-only local key directory. Back up database **and keyfile** together with the server stopped. This protects database-only copies, not against the OS user who can read both. Missing/corrupt/mismatched keyfile with encrypted records fails startup; never silently regenerate or fall back as if no override existed. No plaintext manual key is stored in state, snapshots, raw requests, exports, logs or GET responses. Browser passwords exist only as transient pending edits until a confirmed save.

## Shared input contracts

`GET /api/state` includes `input_contracts:[]`; generic versioned `PUT /api/state`
owns this list alongside templates/providers/metrics/settings/draft. Omission
preserves existing contracts; explicit `[]` deletes contracts only after all
template references are removed in the same save. Templates optionally reference
`input_contract_id`. Existing unbound templates keep their old rendering behavior;
there is no forced migration or implicit contract assignment.

```json
{"id":"prepared","name":"Prepared translation variables","description":"Context has already been prepared upstream","fields":{"CurrentText":{"type":"string","required":true,"nullable":false,"description":"Current source sentence"},"Context":{"type":"object","required":false,"nullable":true,"description":"Prepared context","fields":{"items":{"type":"array","required":true,"nullable":false,"description":"Ordered context entries","items":{"type":"string","required":false,"nullable":false,"description":"One entry"}}}}}}
```

Field types are `string,number,integer,boolean,object,array`. Objects use `fields`;
arrays require one recursive `items` definition. Nesting is limited to 32.
Required presence and null permission are separate. Types are checked without
coercion, filling defaults or changing a Case; unknown extra object fields are
allowed at every level. Field semantics are editable descriptions, not processing
instructions. Root `TargetLanguageNameMap` cannot be declared: it remains runtime
configuration injected separately from Case input.

`POST /api/input-contracts/impact` accepts `{state_version,contract:<definition>}`
without saving. Response `{state_version,template_ids:[],cases:[{case_id,before_errors:[],after_errors:[]}]}`
lists saved referencing templates and every current Case's compatibility before
and after the proposed definition. Each error is `{case_id,path,message}`, with
JSON Pointer field paths including array indices. Stale version is 409.
Preview/start reject incompatible input before any generation call, with the
concrete Case ID and field paths in `error`. Saving a shared contract is allowed
even if some Cases are incompatible; it affects future uses of all referencing
templates. New generation snapshots freeze the referenced definitions in
`snapshot.input_contracts`; editing a contract never changes historical blobs or
frozen replay.

## Preview

`POST /api/preview` body `{ "state_version":1, "case_id":"9cbd7a175f2b4204a153905f4b817d49", "group":<full group> }` resolves one saved state and returns `{ "protocol":"openai-chat-completions", "method":"POST", "headers":{"Content-Type":"application/json"}, "request":<actual JSON body>, "raw_request":"exact serialized body", "endpoint":".../chat/completions", "prompt_hash":"sha256" }`.

Missing/stale version409 before render. No credentials required or outbound call. Same Go `text/template` renderer as execution: standard builtins only, default missing-key behavior, no file/process/network functions,1MiB message-output bound. Hash covers exact serialized body. Roles/messages render generically before protocol preparation.

Per-group exact raw SourceLanguage routes, execution-only target-map injection, authoritative selection counts, lossless Case editing, shared collections and JSON/JSONL packages are specified in [case-api.md](case-api.md). Preview additionally returns `language_resolution:{source_language,targets:[{key,name}],used_default}`; missing routes default to en, including en→en.

## Runs and immutable history

`POST /api/runs` body `{ "state_version":1, "name":"Comparison", "case_ids":[...], "collection_ids":[...], "excluded_case_ids":[...], "groups":[<full group>,...], "concurrency":20, "metrics":[<optional metric selection>,...] }` returns summary202. Selection is explicit/collection ID union minus temporary exclusions; Group targets never multiply calls. Saved state is loaded once; immediately before creation, version is checked again and credentials resolved under the same lock as state/credential saves. A concurrent config/key replacement cannot mix an old snapshot with a new key; stale409 before sending. Enabled groups require valid protocol/sources/runs and credentials before calls. Manual override takes precedence over frozen env reference; invalid required credentials fail without retry/fallback.

Total calls = sum(enabled group runs) × cases;1–100000 attempts/batch. **One active execution**, generation or evaluation: start/replay409 while another is running/stopping, including in-flight calls. The sole queued exception is the durable evaluation child of a generation launched with selected metrics. Whole-execution cap1–20 ensures a global20 limit. Dispatch order interleaves group within case within iteration. Zero automatic retries; no redirects.

`GET /api/runs` returns summaries newest first. `GET /api/runs/{id}` returns `{batch,snapshot,results}` including pending/running attempts immediately. Summary: `id,name,status,created_at,finished_at,total,completed,failed,cancelled,interrupted,in_flight,concurrency,replay_of`. `completed` counts successful attempts only. Batch statuses: `running`, `stopping`, `completed`, `completed_with_errors`, `stopped`, `interrupted`.

Snapshot: `cases,templates,providers,groups,case_ids,timeout_seconds,requests`, plus optional `selection` ID provenance and `collections` containing chosen collection IDs/names/original memberships frozen before exclusions. Each frozen request additionally records `language_resolution:{source_language,targets,used_default}`; legacy-only case_name remains historical metadata. Protocol/method/nonsecret headers/endpoint/body are frozen; auth/cookie header names are rejected and runtime credentials never enter snapshots. Authenticated originals retain requires_auth after source deletion/clear, never silently become anonymous. In-flight batches retain initially resolved values; later runs/replay resolve latest overrides. Known sensitive values, including old/new keys and JSON-escaped echoes, are redacted before persistence. Current Case variables never contain execution target maps; old historical Case metadata/body is not rewritten.

Attempt: `id,case_id,case_name,group_id,group_name,iteration` (1-based), `status` (`pending`,`running`,`completed`,`failed`,`cancelled`,`interrupted`), `model,response_model,request,raw_request,raw_response,output,error,http_status,duration_ms,started_at,finished_at,prompt_hash`. Requested and returned model identities separate. `raw_request` is the exact sent body string; `request` is JSON representation. `raw_response` retains HTTP/decode failures. Response cap16MiB: overflow fails explicitly, preserving captured prefix. Non-UTF8 bytes additionally preserved in `raw_response_base64`. Redaction is the deliberate exception to exact raw preservation. The generation adapter outputs first message content (string or serialized structured JSON); evaluation is a separate execution described below.

`POST /api/runs/{id}/stop` with `{}` returns summary: unissued work cancelled, issued calls finish and persist. Browser disconnect/refresh does not own job lifetime.

`POST /api/runs/{id}/replay` with `{}` returns NEW batch202 from frozen protocol/method/headers/endpoint/body/params/timeout/concurrency, ignoring mutable state versions/sources. It resolves latest manual override at original ref, else original env reference. Missing encrypted material or required credentials fails before any calls; no anonymous downgrade, automatic resend or current-config body rebuild.

Generation replay is always **generation-only**, including replay of old inline
evaluation history or a generation with a chained child. It neither resolves
evaluation credentials nor dispatches metrics. Old inline outcome bytes remain
owned by the original generation; replay never rewrites that original evidence.

`POST /api/runs` accepts an optional top-level `metrics:[{metric_id,target}]` using
the same selection shape as `draft.metrics`. Omitting it or sending `[]` means
generation-only: the launch neither resolves decision credentials nor creates an
evaluation. A nonempty selection automatically evaluates the generation's
successful outputs exactly once per source output and metric. The obsolete
`after_generation_evaluation` field and any `repeats` field are rejected as
unknown input, not silently ignored.

With selected metrics, metric/provider/target definitions freeze at launch while
decision credentials are resolved only when the evaluation starts. Generation
creation and its queued single-pass child are committed atomically; the returned
generation summary links `evaluation_execution_id`. Closing the browser does not
prevent chaining. When generation settles, successful outputs become the child's
frozen sources and the child moves from `queued` to `running`. Generation status
is already terminal and is never reopened or changed by judgment failures. No
successful outputs or missing decision credentials produce a terminal child
`failed` with explicit `error`; generation remains unchanged. Stopping generation
cancels the queued child, while stopping the queued child alone lets generation
continue. Startup marks a queued child interrupted, never starts it automatically
or sends calls. The launch rejects a planned selection above 100000 planned
outputs × metrics before generation.

The generation snapshot records the frozen selection as `evaluation:{metrics,concurrency}`.
Legacy schema2 snapshots may also contain `after_generation_evaluation`; that
metadata and its historical repeats value remain readable in GET/export, and the
stored snapshot blob is not rewritten. It is never executed again and is not
accepted as write input. Output formatting may normalize whitespace, so
byte-identical raw HTTP is not guaranteed.

`GET /api/runs/{id}/export` downloads the same detail JSON with attachment disposition and no secrets.

## History storage and health

Generation and evaluation history persists in PostgreSQL, independently of
browser storage. Frozen historical inputs and requests are not rebuilt from
current editable state. Unfinished work is interrupted on startup, never
automatically resent. See [storage and migration](architecture.md#storage-and-migration)
for schema2 compatibility, BYTEA preservation, session locking, connection-pooling
requirements and the distinction from historical SQLite migrations.

`GET /api/health` returns `{ "status":"ok" }`.

## Evaluation metrics

Metrics are reusable execution configuration, owned by the existing optimistic
`PUT /api/state` transaction. `GET /api/state` includes `metrics:[]` and
`draft.metrics:[]` (also for old databases). Supply the full editable state with
its current `version`; explicit `metrics:[]` deletes all metrics, while an omitted
metrics field preserves it. Cases and collections remain dedicated resources.
IDs are client-created opaque IDs, unique within metrics. Deleting referenced
metrics/providers requires updating draft selections/metric references atomically.

```json
{
  "metrics":[
    {"id":"han","name":"Chinese characters","kind":"code","return_type":"boolean","rule":"Detect Chinese characters in the selected target","code":"function evaluate(input) { return {value: /[\\u4e00-\\u9fff]/u.test(input.target)}; }"},
    {"id":"greeting","name":"Greeting","kind":"model","return_type":"boolean","rule":"Is input.target a greeting?","provider_id":"typesafe","model":"jev-1.13","threshold":0.5}
  ],
  "draft":{"metrics":[{"metric_id":"han","target":{"mode":"json_pointer","pointer":"/en"}}]}
}
```

The snippet illustrates the new fields, not a complete state write. `kind` is
`code` or `model`; `return_type` is `boolean`, `number`, or `classification`.
Every metric needs ID/name; code metrics need `code`, and model metrics need
`rule,provider_id,model`. Rules and code are each limited to 64 KiB. Classification
uses `labels:[{label,description}]`: 2–100 unique nonblank labels, at most 256
bytes each; model labels need nonblank descriptions. Model numbers use
`levels:["lowest description", "...", "highest description"]`, 2–10 nonblank
ordered descriptions. Model booleans optionally configure finite `threshold`
in `[0,1]`, default `0.5`; `value` is strictly `noul > threshold`. Code numbers
are finite numbers, not normalized scores; booleans carry no pass/fail semantics.

Protocol catalog entries expose `capabilities:["generation"]` or `["decision"]`.
`typesafe-systemone` is decision-only, with provider base URL
`https://api.typesafe.ai/v1` (`/systemone` appended). It uses the same
`api_key_env,credential_ref,credential_updates` and manual-over-env precedence as
generation providers, but always requires authentication. It is rejected in
generation groups, including preview and manually submitted run requests. No
automatic model discovery or paid call occurs when saving configuration.

### Frozen selection and shared input

`POST /api/evaluations` and the optional generation `metrics` field use the same
selection shape as `draft.metrics`; a selected run freezes and evaluates exactly
one pass automatically. Selection is execution-wide, ordered and unique by
metric ID.
`target:{mode:"output"}` for the exact output string, or
`target:{mode:"json_pointer",pointer:"/en"}` for RFC 6901 extraction. An empty
pointer means the JSON root. `~0`/`~1` escapes and canonical array indices are
supported; no URI-fragment pointers, Markdown stripping, key guessing, string
coercion, or missing-field fallback. Invalid JSON/missing fields produce a
separate metric error without discarding the output or other metrics.

Evaluation snapshot `metrics` contains `{metric:<full frozen rule>,target,provider?,requires_auth?}`.
The decision provider is frozen without secrets, including its credential
reference, original env name, URL/protocol and model. The UI initializes a new
model metric with `jev-latest`, but the API requires the version explicitly.
The model field is an alias string sent unchanged; each outcome also records the
provider's resolved `response_model`. Replay sends the frozen alias again rather
than pinning that resolved identity, so a moved alias may resolve differently.
Only evaluation start/replay resolves selected decision credentials under the
state/credential synchronization boundary. Generation-only never looks up those
keys. In-flight evaluations retain resolved keys; frozen replay resolves current
credentials against the original references without rebuilding metric configs.

Code runtime input and shared evaluation context are shown below. Model transport
uses the same selected target and context but deliberately omits `output` (see
[Native Typesafe transport](#native-typesafe-transport)); this is not an identical model wire payload.
```json
{
  "case":{"id":"opaque","variables":{"CurrentText":"synthetic example","SourceLanguage":"zh"}},
  "output":"{\"corrected_text\":\"原文\",\"en\":\"Hello\"}",
  "target":"Hello",
  "language_resolution":{"source_language":"zh","targets":[{"key":"en","name":"English"}],"used_default":false},
  "group":{"id":"g","name":"Example","model":"generation-model"},
  "iteration":1
}
```

`case` is frozen input, `output` is the complete generation output, and `target`
is extracted by the backend, retaining its JSON type. No credentials enter this
object. Maximum encoded input is 1 MiB. Do not assume a string target unless the
selected field actually contains one.

### Code function and local trial

Code defines the synchronous function `evaluate(input)` and returns an object
`{value,reason?}`. `value` must exactly match the declared type; classification
must exactly match a declared label. `reason`, if present, is a string.
Promises, undefined, NaN/Infinity and non-JSON return values are invalid.
Each call runs in a fresh `modernc.org/quickjs v0.24.2` VM, with a 16 MiB engine
heap limit and 200 ms execution limit, no host bridges or module loader.
There is no file/network/process/environment API. Encoded return data is limited
to 64 KiB. The heap limit covers the engine allocator, not total process RSS;
these bounds are defense-in-depth, not a formal security certification.

`POST /api/metrics/trial` accepts:
```json
{"metric":{"id":"trial","name":"Trial","kind":"code","return_type":"boolean","code":"function evaluate(input){return {value: input.target === 'Hello'}}"},"target":{"mode":"json_pointer","pointer":"/en"},"input":{"case":{"id":"synthetic","variables":{}},"output":"{\"en\":\"Hello\"}","group":{"id":"example","name":"Example","model":"synthetic"},"iteration":1}}
```
The backend fills/overwrites `input.target` using the same extraction rules.
No state write or provider call occurs. Config/target syntax errors are HTTP400;
execution/extraction errors are HTTP200 with a normal `MetricOutcome` carrying
`status:"error"` and `error`. Success is HTTP200 with `status:"completed"`.
The trial never automatically reads real Cases. A copied AI script-generation
prompt should contain the selected rule, exact function/input/output contract,
declared labels/type and runtime bounds above, using only synthetic examples;
it must not silently copy real Case data or credentials.

### Native Typesafe transport

The REST request is `{model,state,questions:{metric:{type,instructions,criteria?}}}`.
Its state contains `target,case,language_resolution,group,iteration`, deliberately
omitting the complete `output` so unrelated output fields cannot be alternate
targets. Fixed instructions require judging **only** `state.target`; the remaining
fields are context. This makes transport unambiguous, not a guarantee of model
semantic compliance.
Boolean uses `type:"noul"`; number uses `type:"score",criteria:<levels>` and
retains its native fractional range `0..N-1`; classification uses
`type:"choice",criteria:{label:description}`. Response model, raw response,
Noul probability, probability distribution, confidence and legend are preserved
when returned. Numeric values, probabilities and choices are validated.
Confidence is not accuracy, and no model reason is invented. JEV is not an
exact counting/arithmetic substitute. One metric makes at most one request;
there are no redirects or automatic retries. Responses are bounded to 1 MiB,
and failure preserves the redacted captured prefix. Official wire definitions:
[API](https://docs.typesafe.ai/api/system-one.md),
[Noul](https://docs.typesafe.ai/primitives/noul.md),
[Score](https://docs.typesafe.ai/primitives/score.md) and
[Choice](https://docs.typesafe.ai/primitives/choice.md).

### Results, progress and lifecycle

Independent evaluations use the following endpoints:

- `POST /api/evaluations` accepts `{state_version,name,generation_run_id,result_ids:[],metrics:[{metric_id,target}],concurrency:20}` and returns an evaluation summary (202). One terminal source generation only; omitted/empty result IDs selects all successful outputs, explicit IDs must be unique, belong to that source and be `completed`. Failed/cancelled/interrupted outputs are not silently accepted. At least one source and metric are required. Each selected source output is judged exactly once per metric; source count × metrics is capped at 100000 before allocating outcomes. The obsolete `repeats` field is rejected as unknown input. Stale state is 409 and active execution is 409.
- `GET /api/evaluations` returns summaries newest first.
- `GET /api/evaluations/{id}` returns `{evaluation,snapshot,outcomes,summary}`.
- `GET /api/evaluations/{id}/export` returns that detail with attachment disposition.
- `POST /api/evaluations/{id}/stop` accepts `{}`: unissued judgments become cancelled, issued calls finish and persist. A queued child can be stopped independently.
- `POST /api/evaluations/{id}/replay` accepts `{}` and creates a new single-pass execution using frozen sources/metrics/concurrency, not current Cases/metrics/providers. Replaying a historical multi-round record creates one pass and never mutates the old record. Editing metrics and submitting `POST /api/evaluations` creates a distinct execution using the modified definitions. Neither action retries errors automatically or generates new text.

The browser exposes these independent backend executions as evaluation versions
inside the existing output table, result preview and summary, with no standalone
evaluation workspace. Its **重新评估** action submits `POST /api/evaluations` with
the current saved metric selection/targets and all successful outputs of the
loaded terminal generation. It does not call generation or frozen evaluation
replay. Viewing a historical subset version does not narrow this new execution.
The version selector keeps each execution and original inline evidence separate:
it never fills missing judgments from another version or merges their summaries.
Historical subset coverage and multi-round identities remain unchanged. For a
historical multi-round version, the browser's round selector applies one recorded
round consistently to the table, filters, preview and summary.

For evaluation endpoints, invalid source/configuration/target input returns 400,
missing history returns 404, and stale state or an active execution returns 409.
Storage/internal execution failures return 500 with the generic error
`evaluation storage or execution failure; restart server`; individual judgment
errors remain persisted outcomes and do not turn a successful detail GET into an
HTTP error. Start/replay resolve required decision credentials before issuing
judgments; unavailable selected credentials reject launch rather than silently
using anonymous requests.

Evaluation summary fields are `id,name,generation_run_id,status,total,completed,failed,cancelled,interrupted,in_flight,concurrency,created_at,finished_at,replay_of,error?`. Historical multi-round records additionally expose their original `repeats`; new single-pass records omit it.
Statuses: `queued,running,stopping,completed,completed_with_errors,stopped,interrupted,failed`.
Generation has its own status/counters; an evaluation error never changes it.

Snapshot fields are `generation_run_id,results,metrics,timeout_seconds`, plus historical `repeats` when read from an old multi-round record.
Each source is `{result,case,request}`: original frozen Case variables, generation
identity/iteration/output/model, and original FrozenRequest/language context.
Redundant Result wire request/response payloads and old inline evaluations are
omitted from the evaluation's copy; their authoritative bytes remain in generation
history. Original Case values are never replaced by later current values.
Manual execution/replay freezes the entire snapshot at creation. A queued child's
metric config freezes at launch; sources freeze once at activation after output
exists. Later progress writes do not rewrite the snapshot.

Each new judgment is `{result_id,metric_id,round,outcome}` with `round` always
`1`. The field remains for the schema2 outcome key and historical multi-round
records, whose original rounds stay readable; `round` is not generation
iteration and no new repetition is created. Metric input `iteration` always
retains the original generation iteration. Outcome fields are
`metric_id,status,value?,reason?,error?,started_at?,finished_at?,duration_ms?,
response_model?,raw_response?,http_status?,noul?,probabilities?,confidence?,legend?`.
Statuses: `pending,running,completed,error,cancelled,interrupted` (legacy inline
history may additionally contain `skipped`). `reason` is code-only. Requested
metric model and provider-returned `response_model` remain distinguishable.

`summary` contains metric totals for all groups (`group_id:""`) and each source
group, with fields `metric_id,group_id,valid,true_count,false_count,mean?,min?,max?,
labels,error,skipped,cancelled,interrupted,pending,running`. Only completed judgments
enter value denominators. Each judgment is one metric applied to one concrete
output, not an additional independent generation sample.

Browser closure never stops server work. Restart marks queued/pending/running
evaluation work interrupted without resending, preserving completed judgments,
generation output, frozen snapshots and legacy inline evidence. Existing
generation `evaluations`, `evaluation_summary`, `evaluation` counters and
`max_model_calls` remain readable legacy fields; new generations do not populate
inline outcomes. Old successful outputs can be independently evaluated whenever
their historical frozen Case/request context is available.

