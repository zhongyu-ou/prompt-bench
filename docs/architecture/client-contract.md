# Promptbench local API

This document owns the local HTTP contracts for configuration, Cases, collections,
selection, generation, evaluation and packages. See [architecture](overview.md)
for module ownership, storage/session constraints and design rationale.

## General rules

- JSON is served at the UI's same origin. Errors are `{"error":"message"}`; arrays
  have no envelope. Mutations require `Content-Type: application/json`; stop and
  replay accept `{}`. No CORS. Host must match the printed loopback address and a
  supplied Origin must match. Host/Origin rejection returns 403.
- JSON request bodies are limited to 8 MiB, contain exactly one JSON value and
  reject unknown struct fields. JSON numbers are decoded without float
  normalization. Times are UTC RFC3339Nano; IDs are opaque.
- Invalid input normally returns 400, missing resources 404, stale state or active
  execution conflicts 409, unsupported content types 415, and storage/read
  failures 500. Evaluation-specific internal errors are described below.
- Generic state writes use `version`; dedicated persisted resource mutations use
  `state_version` and return updated `StateView`, including recomputed credential
  metadata. Stale versions return 409 before semantic validation, including old
  Case schema validation. Invalid or stale writes make no changes. Pure variable
  preview requires no version; selection/import previews and export require one.
- Resource IDs are unique within each resource type. Draft references must exist,
  including disabled groups; remove or update references atomically. Empty
  collections and draft are allowed.

## Resources

### Providers and protocol catalog

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

### State and write-only credentials

`GET /api/state` example (credential availability is computed from actual backend state):
```json
{"version":1,"cases":[{"id":"9cbd7a175f2b4204a153905f4b817d49","variables":{"CurrentText":"Hello","SourceLanguage":"en"},"variables_json":"{\"CurrentText\":\"Hello\",\"SourceLanguage\":\"en\"}"}],"collections":[],"templates":[{"id":"asr","name":"ASR","messages":[{"role":"user","content":"{{.CurrentText}}"}]}],"input_contracts":[],"providers":[{"id":"luna","name":"Luna","protocol":"openai-chat-completions","base_url":"https://example.openai.azure.com/openai/v1","api_key_env":"AZURE_OPENAI_API_KEY","credential_ref":"cred_example"}],"metrics":[],"settings":{"default_runs":20,"concurrency":20,"timeout_seconds":120},"draft":{"name":"Comparison","case_ids":["9cbd7a175f2b4204a153905f4b817d49"],"collection_ids":[],"excluded_case_ids":[],"groups":[{"id":"luna","name":"Luna","enabled":true,"template_id":"asr","provider_id":"luna","model":"example-model","parameters":{"reasoning_effort":"none"},"runs":20,"language_routes":[]}],"metrics":[]},"credentials":{"luna":{"manual_set":false,"env_available":false,"source":"missing","available":false,"requires_auth":true}}}
```
`credentials` is separate read-only metadata keyed by provider ID; it is not part of persisted editable state. `source`: `manual`, `env`, `anonymous`, `missing`, `invalid`. `manual_set` indicates stored override presence, not its value. `env_available` means a currently valid actual env value, not merely a configured name. `available` indicates a usable resolved credential or explicit anonymous endpoint. `requires_auth` is true when a manual override exists or an env name is configured.

`PUT /api/state` accepts optimistic `version` and editable `templates,input_contracts,providers,metrics,settings,draft`, plus optional write-only:
```json
{"credential_updates":{"luna":{"action":"set","key":"new private value"},"other":{"action":"clear"}}}
```
The snippet is added to the normal editable state body, not submitted alone.
Cases and collections are read-only through generic state saves; omit them to
retain their exact stored values, including JSON numeric literals. Unchanged
resource echoes are accepted, but mutations return 400. Empty root resource lists
read as `[]`; unchanged root `null`/`[]` echoes are equivalent for old databases
only. Nested null versus arrays, array order, numeric literals and text are never
normalized.

Missing credential mutation entries retain overrides. Blank passwords omit their
entry; never submit a mask. `set` requires nonblank input without surrounding
whitespace/control characters, maximum 16 KiB. `clear` must not carry a key and
removes the override, falling back to env. `clear` may target an existing provider
removed in the same save; `set` for removed providers and unknown IDs fail.
Provider deletion without clear retains encrypted material for historical
replay; **clear before deletion or in the same save to revoke it**.

Every state/credential PUT commits together and increments state version,
including credential-only changes. Response is normal state plus recomputed
metadata, never keys or `credential_updates`. Echoed `credentials` metadata is
accepted but ignored/recomputed. Errors never echo pending passwords.

`credential_ref` is generated by the backend for new providers (omit/empty when creating); preserve it for existing providers. Client-assigned new refs, changed existing refs, duplicate refs and reuse/resurrection of retained history refs are rejected. Two profiles sharing an env name still have independent manual overrides. Deleting then recreating a provider ID gets a new ref, never an old credential.

Provider URLs must be HTTP(S), without userinfo/query/fragment. Template syntax is
validated on save. The generation adapter reserves `model`, `messages`, `stream`
(streaming unsupported). Auth-like top-level parameters `authorization`,
`api_key`, `api-key`, `apikey`, `headers`, `extra_headers` are rejected
case-insensitively. Other fields pass unchanged: omission differs from
null/zero/`none`; no temperature/reasoning defaults. Runs are 1–1000, concurrency
1–20, timeout 1–3600 seconds.

No plaintext manual key is stored in state, snapshots, raw requests, exports, logs
or GET responses. Missing/corrupt encrypted credential material is never treated
as an absent override. See [architecture](overview.md) for encrypted storage,
keyfile and backup requirements.

### Cases and collections

Persisted/exported Case is exactly `{id,variables}`. ID is server-generated random
opaque hex. Variables is an object; `TargetLanguageNameMap` is forbidden because
it is execution-owned runtime configuration. Cases have no name or description.
StateView adds derived `variables_json:"<canonical JSON object text>"` for
lossless editing, never a second persisted input. Collection is
`{id,name,case_ids:[]}`; a Case may belong to multiple collections. Draft includes
`case_ids`, `collection_ids` and temporary `excluded_case_ids`.

- `POST /api/cases` accepts `{state_version,variables,collection_ids?:[]}` and
  creates a Case, including intentional identical copies. Use
  `variables_json:"<JSON object text>"` instead of `variables` to retain raw
  numeric literals.
- `PUT /api/cases/{id}` accepts full replacement with either `variables` or
  `variables_json`, or partial edit
  `{state_version,variable_patch:{<changed fields>},remove_variables:[<keys>],collection_ids?:[]}`.
  Full replacement and patch/removal cannot mix; patch/removal cannot target the
  same key. Partial edits preserve every untouched value/number server-side.
  Supplying `collection_ids` replaces that Case's memberships; omission preserves
  them. Shared edits affect future use only. Send only changed fields for partial
  edits; use `variables_json` rather than parse/stringify unknown values.
- `DELETE /api/cases/{id}` accepts `{state_version}` and removes the current Case,
  collection memberships and draft explicit/excluded references; frozen history
  is untouched.
- `POST /api/collections` accepts `{state_version,name}` and creates an empty
  collection.
- `PUT /api/collections/{id}` accepts `{state_version,name}` and renames it.
- `DELETE /api/collections/{id}` accepts `{state_version}` and removes only that
  collection and its draft selection reference.
- `POST /api/collections/{id}/members` accepts
  `{state_version,add_case_ids:[],remove_case_ids:[]}` and atomically changes
  membership. Unknown references and overlapping add/remove fail.

The API returns the complete Case resource list; it does not paginate Cases.


### Shared input contracts

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

### Evaluation metrics

Metrics are reusable configuration owned by the versioned `PUT /api/state`
transaction. `GET /api/state` includes `metrics:[]` and `draft.metrics:[]`, also
for old databases. Supply the full editable state with its current `version`;
explicit `metrics:[]` deletes all metrics, while omission preserves them.
Metric IDs are client-created opaque IDs. Delete referenced metrics/providers
only with the corresponding draft selections/metric references updated in the
same save.

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

## Selection and preview

### Language routes and selection

Cases are prepared template variables, not exclusive members of a template or
contract. A template's optional `input_contract_id` controls compatibility at
preview/start; validation does not fill import defaults or modify a Case.

Group has
`language_routes:[{source_language:"zh-CN",targets:[{key:"en",name:"English"}]}]`.
Matching is exact against raw string `SourceLanguage`, with no trimming or locale
normalization. No matching route resolves to
`[{key:"en",name:"English"}]`, including en→en. An empty route list is valid.
Each rule requires a nonempty exact source and nonempty targets; sources and
target keys must be unique within their respective lists. Custom target keys and
names are supported. Whitespace-surrounded source/key/name is rejected, never
normalized. Convenient names: en=English, jp=Japanese, es=Spanish.

`POST /api/selection/preview` accepts
`{state_version,case_ids:[],collection_ids:[],excluded_case_ids:[],groups:[<full groups>]}`.
It returns
`{state_version,case_ids:[<final ordered IDs>],case_count,request_count,resolutions:[{case_id,group_id,source_language,targets,used_default}]}`.
IDs are unioned in explicit then collection order, deduplicated by ID, then
temporarily excluded. Every referenced ID must exist. Targets do not multiply
`request_count`; the endpoint never sends calls.

### Variable preview

`POST /api/cases/variables/preview` accepts
`{variables_json:"<base JSON object text>",variable_patch:{<changed fields>},remove_variables:[<keys>]}`
and returns `{variables_json:"<canonical exact JSON object text>"}`. It is a pure
projection: no `state_version`, persisted writes or model calls. The same Case
validation/patch rules apply, including rejecting `TargetLanguageNameMap`,
malformed JSON and patch/removal overlap. Unknown numeric literals, nested
arrays/types and untouched CRLF are preserved. Send only changed fields to
project unsaved edits without saving or modifying the original Case.

### Request preview

`POST /api/preview` body `{ "state_version":1, "case_id":"9cbd7a175f2b4204a153905f4b817d49", "group":<full group> }` resolves one saved state and returns `{ "protocol":"openai-chat-completions", "method":"POST", "headers":{"Content-Type":"application/json"}, "request":<actual JSON body>, "raw_request":"exact serialized body", "endpoint":".../chat/completions", "prompt_hash":"sha256" }`.

Missing/stale version409 before render. No credentials required or outbound call. Same Go `text/template` renderer as execution: standard builtins only, default missing-key behavior, no file/process/network functions,1MiB message-output bound. Hash covers exact serialized body. Roles/messages render generically before protocol preparation.

Preview also returns
`language_resolution:{source_language,targets:[{key,name}],used_default}`. The
effective `TargetLanguageNameMap` is injected into a copy of variables for
rendering, never into Case state.

## Generation evaluation and history

### Runs and immutable history

`POST /api/runs` body `{ "state_version":1, "name":"Comparison", "case_ids":[...], "collection_ids":[...], "excluded_case_ids":[...], "groups":[<full group>,...], "concurrency":20, "metrics":[<optional metric selection>,...] }` returns summary202. Selection is explicit/collection ID union minus temporary exclusions; Group targets never multiply calls. Saved state is loaded once; immediately before creation, version is checked again and credentials resolved under the same lock as state/credential saves. A concurrent config/key replacement cannot mix an old snapshot with a new key; stale409 before sending. Enabled groups require valid protocol/sources/runs and credentials before calls. Manual override takes precedence over frozen env reference; invalid required credentials fail without retry/fallback.

Total calls = sum(enabled group runs) × cases;1–100000 attempts/batch. **One active execution**, generation or evaluation: start/replay409 while another is running/stopping, including in-flight calls. The sole queued exception is the durable evaluation child of a generation launched with selected metrics. Whole-execution cap1–20 ensures a global20 limit. Dispatch order interleaves group within case within iteration. Zero automatic retries; no redirects.

`GET /api/runs` returns summaries newest first. `GET /api/runs/{id}` returns `{batch,snapshot,results}` including pending/running attempts immediately. Summary: `id,name,status,created_at,finished_at,total,completed,failed,cancelled,interrupted,in_flight,concurrency,replay_of`. `completed` counts successful attempts only. Batch statuses: `running`, `stopping`, `completed`, `completed_with_errors`, `stopped`, `interrupted`.

Snapshot: `cases,templates,providers,groups,case_ids,timeout_seconds,requests`, plus
optional `selection` ID provenance and `collections` described below. Each frozen
request records `language_resolution:{source_language,targets,used_default}`;
legacy-only `case_name` remains historical metadata. Protocol, method, nonsecret
headers, endpoint and body are frozen; auth/cookie header names are rejected and
runtime credentials never enter snapshots. Authenticated originals retain
`requires_auth` after source deletion/clear, never silently becoming anonymous.
In-flight batches retain initially resolved values; later runs/replay resolve
latest overrides. Known sensitive values, including old/new keys and JSON-escaped
echoes, are redacted before persistence. Old historical Case metadata/body is not
rewritten.

Snapshot `collections` is optional
`[{id,name,case_ids}]`: only selected collections, deduplicated in selection order,
with names and original full membership frozen before temporary exclusions.
Together with selection IDs and final concrete Cases, this preserves provenance
after current collection renames, membership changes or deletion. Old snapshots
may omit it; never reconstruct historical names from current collections.

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

### Evaluations

#### Frozen selection and shared input

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
reference, original env name, URL/protocol and model. The API requires the model
version explicitly. The model field is an alias string sent unchanged; each
outcome also records the provider's resolved `response_model`. Replay sends the
frozen alias again rather than pinning that resolved identity, so a moved alias
may resolve differently.
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

#### Code function and local trial

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
The trial never automatically reads real Cases.

#### Native Typesafe transport

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

#### Results progress and lifecycle

Independent evaluations use the following endpoints:

- `POST /api/evaluations` accepts `{state_version,name,generation_run_id,result_ids:[],metrics:[{metric_id,target}],concurrency:20}` and returns an evaluation summary (202). One terminal source generation only; omitted/empty result IDs selects all successful outputs, explicit IDs must be unique, belong to that source and be `completed`. Failed/cancelled/interrupted outputs are not silently accepted. At least one source and metric are required. Each selected source output is judged exactly once per metric; source count × metrics is capped at 100000 before allocating outcomes. The obsolete `repeats` field is rejected as unknown input. Stale state is 409 and active execution is 409.
- `GET /api/evaluations` returns summaries newest first.
- `GET /api/evaluations/{id}` returns `{evaluation,snapshot,outcomes,summary}`.
- `GET /api/evaluations/{id}/export` returns that detail with attachment disposition.
- `POST /api/evaluations/{id}/stop` accepts `{}`: unissued judgments become cancelled, issued calls finish and persist. A queued child can be stopped independently.
- `POST /api/evaluations/{id}/replay` accepts `{}` and creates a new single-pass execution using frozen sources/metrics/concurrency, not current Cases/metrics/providers. Replaying a historical multi-round record creates one pass and never mutates the old record. Editing metrics and submitting `POST /api/evaluations` creates a distinct execution using the modified definitions. Neither action retries errors automatically or generates new text.

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

### History storage and health

Generation and evaluation history persists in PostgreSQL, independently of
browser storage. Frozen historical inputs and requests are not rebuilt from
current editable state. Unfinished work is interrupted on startup, never
automatically resent. See [storage and migration](overview.md#storage-and-migration)
for schema2 compatibility, BYTEA preservation, session locking, connection-pooling
requirements and the distinction from historical SQLite migrations.

`GET /api/health` returns `{ "status":"ok" }`.

## Import and export

### Eve Vocat variables

Raw variable imports use `input_format:"eve-vocat"` with `format:"json"|"jsonl"`.
The HTTP import default is package mode, described below; raw variable mode must
be explicit. For example:

```json
{"CurrentText":"法治的理念要得到践行。","PriorText":"问渠哪得清如许？为有源头活水来。\n我是一个长期生活在书斋里的人。","ReplacementMap":"","SourceLanguage":"zh-CN"}
```

`CurrentText` and `SourceLanguage` must be nonblank strings; source language is
explicit, never automatically detected. Missing `PriorText` and `ReplacementMap`
default to empty strings before preview, fingerprinting and commit. Explicit
values and custom variables are preserved. A single variables object needs no
package header, Case wrapper or ID. A JSON array of objects or JSONL with one
variables object per nonblank line imports multiple Cases. Records are Case
variables, not full upstream requests; exact numeric literals are retained.
`TargetLanguageNameMap` is rejected. Empty batches, null/scalar records and
malformed records reject the entire import.

Raw import preview `file_id` values are positional references (`row-1`, `row-2`,
…), never persisted Case IDs. New Cases receive random IDs on commit; identical
inputs reuse Cases under the shared import rules below. Package mode does not
apply the Eve/Vocat required fields or defaults.

### Standard packages

JSON format is
`{format:"promptbench-cases",version:1,cases:[{id,variables}],collections:[{id,name,case_ids:[]}]}`.
Empty collections round-trip. JSONL starts with
`{type:"package",format:"promptbench-cases",version:1}`, followed by
`{type:"case",id,variables}` and `{type:"collection",id,name,case_ids:[]}` records.
Packages contain no providers, keys, routes or runs.

Package mode accepts only current standard packages. Legacy Case
name/description/`TargetLanguageNameMap`, whole-state files and run logs are
rejected with actionable errors, never silently dropped.

### Import preview and commit

`POST /api/cases/import/preview` and `POST /api/cases/import` accept
`{state_version,input_format:"package"|"eve-vocat",format:"json"|"jsonl",content:"<file text>",collection_ids?:[]}`.
Omitted or empty `input_format` selects package mode. Optional `collection_ids`
adds all imported Cases to existing local collections.

Preview returns
`{state_version,new_count,existing_count,cases:[{file_id,status:"new"|"existing",local_id?,variables}],collection_count,warnings:[]}`.
It does not write state. Commit validates the entire input atomically and returns
`{state:<StateView>,new_count,existing_count,case_id_map:{<file ID>:<local ID>},warnings:[]}`.

Fingerprinting canonicalizes object-key ordering only. Numeric literals, types,
text, null versus arrays and array order remain significant. The first existing
local Case with equal input is reused; otherwise a random Case ID is generated
regardless of file ID. No existing Case is edited. Batch-internal equal inputs
reuse the same local Case. `new_count` counts distinct new inputs;
`existing_count` counts other unique file IDs reused. Duplicate file IDs with
different input and dangling collection references fail without writes.

Reimport is membership-idempotent. Imported collections retain their file ID on
creation. An existing collection ID keeps its current name and only adds missing
members; distinct collection IDs are never merged by name.

### Case package export

`POST /api/cases/export` accepts
`{state_version,format:"json"|"jsonl",case_ids:[],collection_ids:[],include_memberships:false}`
and downloads the explicit/selected-collection Case union. With
`include_memberships:false` (the default), collections are omitted. With `true`,
include collections associated with exported Cases, filtering members to
exported IDs, plus explicitly selected empty collections. Sharing a collection
never pulls in additional unselected Cases. Empty selection exports an empty
package.

`GET /api/cases/example?format=json|jsonl` downloads a valid illustrative package
without inserting it into user state.
