# Case workflow API

All endpoints share the host/origin, JSON and credential protections in [api.md](api.md). Mutations below require `state_version` and return updated `StateView` (including recomputed credential metadata); stale versions return409 before semantic validation. GET state includes `collections:[]`.

## Models

Persisted/exported Case is exactly `{id,variables}`. ID is server-generated random opaque hex. StateView read responses add derived `variables_json:"<canonical JSON object text>"` for lossless editing; this is never a second persisted input. Variables is an object; `TargetLanguageNameMap` is forbidden. No name/description. Collection is `{id,name,case_ids:[]}`. Draft adds `collection_ids:[]` and `excluded_case_ids:[]` alongside explicit `case_ids`.

`PUT /api/state` edits only `{version,templates,providers,settings,draft,credential_updates?,credentials?}`. Omit cases/collections: the server retains their exact stored JSON numbers and variables rather than round-tripping them through JavaScript. Explicit echoed cases/collections must be exactly unchanged; mutations return400 and must use dedicated endpoints. Stale versions return409 first, even for old name-bearing Case schemas. Generic saves never round or normalize imported numeric values.

Read responses serialize empty root cases/collections resource lists as `[]`; unchanged empty-list echoes treat root null/[] as equivalent for old databases only. This does not normalize any nested Case input: null versus [], array order, numeric literals and text remain fingerprint-significant and unchanged.

Group adds `language_routes:[{source_language:"zh-CN",targets:[{key:"en",name:"English"}]}]`. Matching is exact against the raw string SourceLanguage (no trim or locale normalization). No match resolves to `[{key:"en",name:"English"}]`, even en→en. Empty route list is valid; an individual rule requires a nonempty exact source and nonempty targets, unique source and unique target keys. Custom target keys/names are supported; whitespace-surrounded source/key/name is rejected, never normalized. Convenient names: en=English, jp=Japanese, es=Spanish.

## Case and collection editing

- `POST /api/cases` `{state_version,variables,collection_ids?:[]}` creates a new Case, including intentional identical copies. Instead of variables, use `variables_json:"<JSON object text>"` to retain raw numeric literals.
- `PUT /api/cases/{id}` accepts full replacement with either variables or variables_json, or partial edit `{state_version,variable_patch:{<changed fields>},remove_variables:[<keys>],collection_ids?:[]}`. Partial edits preserve every untouched value/number server-side. Full replacement and patch/removal cannot be mixed; patch/removal cannot target the same key. Supplying collection_ids replaces that Case's memberships; omitting preserves them. Shared edits affect future use only. Form editors should send actual changed fields only; advanced editors should use variables_json rather than parse/stringify unknown values.
- `POST /api/cases/variables/preview` `{variables_json:"<base JSON object text>",variable_patch:{<changed fields>},remove_variables:[<keys>]}` returns `{variables_json:"<canonical exact JSON object text>"}`. Pure projection: no state_version, persisted writes or model calls. Uses the same Case validation/patch logic; forbids TargetLanguageNameMap, malformed JSON and patch/removal overlap. Unknown numeric literals, nested arrays/types and untouched CRLF are preserved. Use for unsaved form→advanced mode switches and copying edited input without saving the original Case; send only actually changed form fields.
- `DELETE /api/cases/{id}` `{state_version}` removes current Case, collection memberships, draft explicit/excluded refs; frozen history is untouched.
- `POST /api/collections` `{state_version,name}` creates an empty collection.
- `PUT /api/collections/{id}` `{state_version,name}` renames.
- `DELETE /api/collections/{id}` `{state_version}` removes only the collection and its draft selection ref.
- `POST /api/collections/{id}/members` `{state_version,add_case_ids:[],remove_case_ids:[]}` atomically changes membership. Unknown refs and overlapping add/remove fail.

The complete state supports client-side search, filtering, all-matching-ID selection and paginated rendering; the API does not paginate Cases.

## Selection and rendering

`POST /api/selection/preview` accepts `{state_version,case_ids:[],collection_ids:[],excluded_case_ids:[],groups:[<full groups>]}` and returns `{state_version,case_ids:[<final ordered IDs>],case_count,request_count,resolutions:[{case_id,group_id,source_language,targets,used_default}]}`. IDs are unioned in explicit then collection order, deduplicated by ID; exclusions are temporary. Every referenced ID must exist. This endpoint never sends calls.

`POST /api/runs` resolves the same selection under version guards and freezes concrete Cases, `snapshot.selection` provenance, Group rules and each request's `language_resolution:{source_language,targets,used_default}`. Targets do not multiply request_count. The effective TargetLanguageNameMap is injected into a copy of variables, never Case state. Full run and single-request preview contracts are in [api.md](api.md#preview).

Snapshots also include optional `collections:[{id,name,case_ids}]`: only chosen collections, deduplicated in selection order, with their names and original full membership frozen at start (before temporary exclusions). Together with selection IDs and final concrete Cases this makes historical provenance independent of current State after collection rename/membership edits/deletion. Old snapshots may omit this field; do not reconstruct historical names from mutable current collections.

## Standard packages

JSON format: `{format:"promptbench-cases",version:1,cases:[{id,variables}],collections:[{id,name,case_ids:[]}]}`. Empty collections round-trip. JSONL starts with `{type:"package",format:"promptbench-cases",version:1}`, followed by `{type:"case",id,variables}` and `{type:"collection",id,name,case_ids:[]}` records. Nothing else is exported: no providers, keys, routes or runs.

`POST /api/cases/import/preview` and `/api/cases/import` accept `{state_version,format:"json"|"jsonl",content:"<file text>",collection_ids?:[]}`. Preview returns `{state_version,new_count,existing_count,cases:[{file_id,status:"new"|"existing",local_id?,variables}],collection_count,warnings:[]}`. Commit validates the entire package atomically and returns `{state:<StateView>,new_count,existing_count,case_id_map:{<file ID>:<local ID>},warnings:[]}`. Optional collection_ids adds all imported Cases to existing local collections. Same input reuses the first existing local Case; new inputs get random IDs regardless of file ID. No existing Case is edited. Fingerprinting canonicalizes object key ordering only, preserving numeric literals, types, text and array order. Duplicate file IDs with different input and dangling collection refs are errors, with no writes. Batch-internal equal inputs reuse the first local Case. New_count counts distinct new inputs; existing_count counts other unique file IDs reused. Reimport is membership-idempotent. Imported collections retain their file ID on creation; an existing collection ID is reused with its current name preserved and only missing members added. Distinct collection IDs are not merged by name. Only current standard packages are supported: legacy Case name/description/TargetLanguageNameMap, whole-state files and run logs are rejected with actionable errors, never silently dropped.

`POST /api/cases/export` accepts `{state_version,format:"json"|"jsonl",case_ids:[],collection_ids:[],include_memberships:false}` and downloads the explicit/selected-collection Case union. With false (default), collections are omitted. With true, include collections associated with exported Cases, with members filtered to exported IDs, plus explicitly selected empty collections. Sharing a collection never pulls in additional unselected Cases. Empty selection exports an empty package. `GET /api/cases/example?format=json|jsonl` downloads a valid illustrative package (not inserted into user state).
