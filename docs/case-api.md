# Case workflow API

All endpoints share the host/origin, JSON and credential protections in [API](api.md). Persisted resource mutations require `state_version` and return updated `StateView` (including recomputed credential metadata); stale versions return 409 before semantic validation. GET state includes `collections:[]`. Pure variable preview does not require a version; selection/import previews and export require the version specified below.

This document owns Case/collection resources, selection/language routing and
import/export formats. [API](api.md) owns generic state saves, shared contract
definitions, generation and evaluation; [architecture](architecture.md) owns
implementation structure and design rationale. Use [verification](verification.md)
for checks rather than treating historical QA as the current contract.

## Models

Persisted/exported Case is exactly `{id,variables}`. ID is server-generated random opaque hex. StateView read responses add derived `variables_json:"<canonical JSON object text>"` for lossless editing; this is never a second persisted input. Variables is an object; `TargetLanguageNameMap` is forbidden. No name/description. Collection is `{id,name,case_ids:[]}`. Draft adds `collection_ids:[]` and `excluded_case_ids:[]` alongside explicit `case_ids`.

Cases and collections are read-only through generic `PUT /api/state`; use the dedicated endpoints below for changes. Omit their fields from generic saves so the server retains exact stored JSON numbers and variables. Explicit echoes must be exactly unchanged; mutations return 400. Stale versions return 409 first, even for old name-bearing Case schemas. Generic saves never round or normalize imported numeric values. The complete generic write shape belongs to [state and write-only credentials](api.md#state-and-write-only-credentials).

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

Cases are prepared template variables, not exclusive members of a template or
contract. The template's optional `input_contract_id` controls compatibility at
preview/start; see [Shared input contracts](api.md#shared-input-contracts) for the
definition, validation, impact and frozen-history contract.
`TargetLanguageNameMap` is runtime configuration, never a stored Case input.
Eve/Vocat import defaults below apply only to that import transformation; contract
validation does not add them.

`POST /api/selection/preview` accepts `{state_version,case_ids:[],collection_ids:[],excluded_case_ids:[],groups:[<full groups>]}` and returns `{state_version,case_ids:[<final ordered IDs>],case_count,request_count,resolutions:[{case_id,group_id,source_language,targets,used_default}]}`. IDs are unioned in explicit then collection order, deduplicated by ID; exclusions are temporary. Every referenced ID must exist. This endpoint never sends calls.

`POST /api/runs` resolves the same selection under version guards and freezes concrete Cases, `snapshot.selection` provenance, Group rules and each request's `language_resolution:{source_language,targets,used_default}`. Targets do not multiply request_count. The effective TargetLanguageNameMap is injected into a copy of variables, never Case state. Full run and single-request preview contracts are in [api.md](api.md#preview).

Snapshots also include optional `collections:[{id,name,case_ids}]`: only chosen collections, deduplicated in selection order, with their names and original full membership frozen at start (before temporary exclusions). Together with selection IDs and final concrete Cases this makes historical provenance independent of current State after collection rename/membership edits/deletion. Old snapshots may omit this field; do not reconstruct historical names from mutable current collections.

## Variable imports

The default browser import format is **Eve / Vocat 变量**. Paste a variables object directly, for example `{"CurrentText":"法治的理念要得到践行。","PriorText":"问渠哪得清如许？为有源头活水来。\n我是一个长期生活在书斋里的人。","ReplacementMap":"","SourceLanguage":"zh-CN"}`. CurrentText and SourceLanguage must be nonblank strings; language is explicit, not automatically detected. Missing PriorText and ReplacementMap default to empty strings before preview, fingerprinting and commit; explicitly supplied values and custom variables are preserved. No package header, Case wrapper or ID is required. A JSON array of objects or JSONL with one variables object per nonblank line imports multiple Cases. The browser detects JSON versus JSONL without parsing and reserializing the submitted variables. Select **Promptbench 标准包** explicitly to import exported packages with collection relationships; package mode does not apply these service-specific defaults or required fields.

`POST /api/cases/import/preview` and `/api/cases/import` accept `input_format:"eve-vocat"` for raw variables, alongside `format:"json"|"jsonl"`, `content`, `state_version` and optional `collection_ids`. All values are Case variables, not a full upstream request. Objects retain custom fields and exact numeric literals; `TargetLanguageNameMap` remains execution-owned and is rejected. Empty batches, null/scalar records and malformed records reject the entire import. The same fingerprint reuse, collection append, atomicity and stale-version rules below apply.

Raw import preview `file_id` values are positional references (`row-1`, `row-2`, …), not persisted Case IDs. New Cases receive random IDs on commit; repeated inputs reuse an existing Case. For either input format, the browser previews five columns in order: No, SourceLanguage, CurrentText, PriorText, ReplacementMap, preserving text and line breaks. Missing values display as blank cells; object/array values display as JSON. New/reuse totals remain above the table. Confirmation is required before writing; editing the text or changing the data format invalidates the old preview.

## Standard packages

JSON format: `{format:"promptbench-cases",version:1,cases:[{id,variables}],collections:[{id,name,case_ids:[]}]}`. Empty collections round-trip. JSONL starts with `{type:"package",format:"promptbench-cases",version:1}`, followed by `{type:"case",id,variables}` and `{type:"collection",id,name,case_ids:[]}` records. Nothing else is exported: no providers, keys, routes or runs.

`POST /api/cases/import/preview` and `/api/cases/import` accept `{state_version,input_format:"package",format:"json"|"jsonl",content:"<file text>",collection_ids?:[]}`. Omitting `input_format` or using an empty value selects package mode for existing API clients. Preview returns `{state_version,new_count,existing_count,cases:[{file_id,status:"new"|"existing",local_id?,variables}],collection_count,warnings:[]}`. Commit validates the entire package atomically and returns `{state:<StateView>,new_count,existing_count,case_id_map:{<file ID>:<local ID>},warnings:[]}`. Optional collection_ids adds all imported Cases to existing local collections. Same input reuses the first existing local Case; new inputs get random IDs regardless of file ID. No existing Case is edited. Fingerprinting canonicalizes object key ordering only, preserving numeric literals, types, text and array order. Duplicate file IDs with different input and dangling collection refs are errors, with no writes. Batch-internal equal inputs reuse the first local Case. New_count counts distinct new inputs; existing_count counts other unique file IDs reused. Reimport is membership-idempotent. Imported collections retain their file ID on creation; an existing collection ID is reused with its current name preserved and only missing members added. Distinct collection IDs are not merged by name. Package mode supports only current standard packages: legacy Case name/description/TargetLanguageNameMap, whole-state files and run logs are rejected with actionable errors, never silently dropped.

`POST /api/cases/export` accepts `{state_version,format:"json"|"jsonl",case_ids:[],collection_ids:[],include_memberships:false}` and downloads the explicit/selected-collection Case union. With false (default), collections are omitted. With true, include collections associated with exported Cases, with members filtered to exported IDs, plus explicitly selected empty collections. Sharing a collection never pulls in additional unselected Cases. Empty selection exports an empty package. `GET /api/cases/example?format=json|jsonl` downloads a valid illustrative package (not inserted into user state).
