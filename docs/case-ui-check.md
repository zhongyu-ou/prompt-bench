# Case workflow frontend check

## Variable import UX — 2026-10-22

Required-field update: Eve / Vocat now requires nonblank string CurrentText and SourceLanguage, with no language autodetection. The visible example includes all four service fields. A subsequent isolated Chromium run rejected missing SourceLanguage and whitespace-only CurrentText in-place, then imported a valid two-field object and confirmed stored PriorText and ReplacementMap were both empty strings. Full `go test ./...` and the import module syntax check passed after the update; regression coverage includes JSON/JSONL required-field rejection, absent-versus-explicit empty defaults deduplication, and atomic rejection of mixed valid/invalid batches. Earlier single-field examples below describe the pre-update check, not the current contract.

Five-column preview update: real Chromium against a new isolated PostgreSQL database verified No / SourceLanguage / CurrentText / PriorText / ReplacementMap in order, row 1 with zh-CN, full CurrentText, multiline PriorText, and an empty ReplacementMap cell. Desktop screenshot confirmed the rendered table; at 390px the table scrolled within its 364px wrapper while body width stayed 390px. `node --check web/js/case-io.js` passed. No model requests or normal user data were involved. This replaces earlier preview-column descriptions below.

Write-column/alignment update: preview now ends with 写入, using the original status mapping (`existing` → 已存在, otherwise 新增). All headers are centered; body cells are centered except CurrentText and PriorText, which stay left-aligned. A controlled-data Chromium rendering smoke exercised the actual renderIO module and stylesheet with both statuses and multiline text; computed alignment matched all six columns. This rendering-only check did not repeat database import verification.

Header sizing fix: removed percentage widths from CurrentText/PriorText, reserved 160px for ReplacementMap and 80px for 写入, and set the table minimum width to 880px. Chromium rendering smoke at viewport widths 1568, 1440, 1024 and 390 measured every header text range inside its own cell, with body width equal to the viewport. A right-scrolled mobile screenshot showed ReplacementMap and 写入 separated without overlap.

Verified the rebuilt application with real Chromium against a new isolated PostgreSQL database, never the normal application database. No model requests were sent.

| Scenario | Observed result |
| --- | --- |
| Initial guidance | At 1440×1100, 数据格式 defaulted to Eve / Vocat 变量; the paste area was visible, with a raw CurrentText object placeholder and object/array/JSONL guidance. Preview used record numbers rather than user-supplied IDs. |
| Single variables object | Pasted a raw object without header/ID, previewed one new record, confirmed, and observed a new random 32-character hex Case ID. Stored variables_json retained `12345678901234567890` and `1.50` exactly. |
| JSONL / JSON array | Pasted two raw objects on separate lines, then a two-object array; each previewed and committed two new Cases. |
| Raw file upload | Uploaded a two-record raw `.jsonl` file under the default data format; preview and confirmation added both records. |
| Reuse and package mode | Post-import previews showed reused Cases. Switching to Promptbench 标准包 and importing an existing input with a file ID previewed reuse and committed zero new Cases. |
| Invalid batch / stale text | Typing after preview immediately disabled confirmation. An array containing one valid object and null produced a visible row-2 error and disabled confirmation; the valid partial record was not written. |
| Responsive / browser errors | At 390×844, body width was 390px with no page-level horizontal overflow; selector, paste, preview and confirmation remained usable. Browser error collection was empty. |

Backend verification: `PROMPTBENCH_TEST_DATABASE_URL=<isolated _test database> go test ./...` passed, including raw-import numeric fidelity, invalid inputs, API atomicity/deduplication/stale-version regression coverage and existing package tests. `node --check` passed for `web/js/case-io.js` and `web/js/state.js`.

This check covers importing inputs, not compatibility with a real Eve/Vocat service or model quality. The sections below are earlier workflow evidence.

## Scope

Real Chromium exercised the Case library/editor, collections, import/export, routing and range selection against an isolated built Go app and local HTTP fixture, at1536×1024 and390×844. No paid model call was made. Final user-service acceptance used only GET/render/preview: no save, import, delete, run/replay or restart. Core execution/Provider credential evidence is in [ui-check.md](ui-check.md); migration and regression evidence is in [case-backend-check.md](case-backend-check.md), with the contract in [api.md](api.md).

## Exercised coverage and results

The isolated dataset contained150 imported Cases, with source languages zh-CN/en/es. Collections included12 and20 members overlapping by3, plus other filtered and empty collections. Their29-Case union minus two temporary exclusions selected27 Cases; two groups×20 repeats yielded1080 potential requests. Enabled groups used only the anonymous local fixture, not Azure/OpenAI. Selection changes did not start batches.

| Area | Actual browser/HTTP evidence |
| --- | --- |
| Library/filtering | CurrentText search `预约` returned4 results; source `en` returned30 over4 pages. At150 Cases,8 rows/page gave19 pages. Cross-page selection, select-all150 and clear0 used the actual filtered set. |
| Collection lifecycle | Create/rename/join/remove/delete updated counts; deleting a collection kept its Cases. `用于调试` replaced explicit scope with the two selected Cases, cleared collection/exclusion refs, switched to workbench and left runs/currentRunId unchanged. |
| Lossless editor | Form→advanced JSON used the projection API. Editing CurrentText retained untouched CRLF PriorText, Score1.50, Big12345678901234567890 and custom name/description variables. JSON→form→JSON retained unsaved changes and unknown numeric lexemes. Membership-only save left variables_json byte-identical; copy-as-new created a random ID with identical input. Only execution-owned TargetLanguageNameMap was rejected, not ordinary name/description variables. |
| Editor save race | A delayed Case PUT saved the submitted CurrentText while a later PriorText edit stayed dirty in the editor; the toast explained the retained later edit and controls re-enabled. |
| Routing | Removing en showed `en → en · 默认`; adding es→en showed exact match. Saving with no targets failed in-place. Independent group routes survived save (zh-CN→en vs zh-CN→en,jp; en→jp). A separate selection preview resolved a missing en route through default `[en]`, used_default=true. Canonical routes retained1080 requests. |
| Staged range | Unchecking a collection staged10 Cases/400 calls without altering applied draft. Removing an exclusion raised this to11/440. Apply changed only draft scope, never collections or runs. Explicit chips/select-all/view-all used authoritative selection preview. |
| Scope pruning | Deleting a staged collection or excluded disposable Case pruned only missing references while retaining surviving collections/exclusions. Local mutation and external deletion followed by reload both recovered valid27/1080 preview/apply without a400 loop. |
| Concurrent mutations | Delayed membership/import mutations retained concurrent unsaved template edits as dirty with merge warnings. A fake pending manual credential survived Case/collection mutation, cleared only after successful save, and was then explicitly cleared. Stale request preview returned409 and displayed conflict without stale output. |
| Responsive layout | At390×844, workbench/library/history/Providers/settings/Case editor had body width no greater than viewport; tables scrolled internally. |

## Import/export evidence

| Scenario | Observed result |
| --- | --- |
| New/reused precision | Upload of12 Cases previewed8 new/4 existing, initially six rows with expansion to12. Confirm added exactly8, reused4 and established12 memberships in the selected empty collection. Reimport showed0 new/12 existing and changed neither count nor memberships. |
| Actual UI export | Normal UI handler produced `promptbench-cases.json` (three Cases, application/json) and `.jsonl` (header, three Cases, three collections; application/x-ndjson) blobs with correct filenames/types. Real endpoint bytes were saved and round-tripped. |
| Membership scope | include_memberships=true included only exported Case memberships plus an explicitly chosen empty collection; false returned collections:[]. Collection-range export retained the selected membership/empty collection. Package memberships were restored independently of the optional append target. |
| Round trip | JSON/JSONL re-upload previewed0 new/3 existing and added nothing. |
| Staleness | External version changes disabled stale commit with a re-preview message, preserving file/target. A commit409 left150 Cases unchanged and retained the selected file. |
| Recovery after409 | `重新载入并解析` used guarded reload, prompting for draft/pending credentials when needed; it restored the same file/content/target and re-previewed1 new/0 existing. Confirm imported exactly one Case (151 total, one marker), without partial/duplicate import. Recovery cleared only after successful preview, without forcing a page reload or losing the file. |

## Screenshots and visual evidence

| View | Evidence |
| --- | --- |
| Isolated workbench | [workbench.png](case-ui-check/workbench.png):27 Cases/1080 requests and bottom run controls visible above the fold |
| Library/editor | [Case library](case-ui-check/case-library.png), [Case editor](case-ui-check/case-editor.png):8-row table, short IDs with full-ID title/copy, full-page editor |
| Import/export | [case-import-export.png](case-ui-check/case-import-export.png): populated8-new/4-existing preview |
| Routing | [group-editor.png](case-ui-check/group-editor.png): compact route rows, match/default display |
| Real user data | [final-user-workbench.png](case-ui-check/final-user-workbench.png), [final-user-case-library.png](case-ui-check/final-user-case-library.png) |

The five isolated screenshots were manually compared with supplied Pencil PNGs for blue-gray layout, global navigation, library-only collection navigation, table/editor structure and scope panel. The active Case was in scope, not excluded; CurrentText/PriorText/ReplacementMap and bottom controls were visible. This was a visual comparison, not an automated pixel/font diff.

## Final read-only user acceptance

After the final embedded build/migration, browser inspection found schema3/state version5, four random-ID Cases, zero collections/runs, and current DTOs containing only id/variables/variables_json. No execution-owned TargetLanguageNameMap remained in input variables. Settings3/20/120, system plus user `hi`, both env credential metadata and group runs20 with zh-CN→en routes were preserved.

Workbench displayed the real4×20×2=160 potential calls, library showed four results/one page, group editor showed the migrated exact route, and settings matched. No batch started. Workbench/library/group editor/settings had no console/errors; before/after state bytes were identical and runs remained empty. Embedded assets and binary matched the accepted build as recorded in [backend acceptance](case-backend-check.md).

## Limits

- The relay OS download manager could not be captured directly. Actual export bytes, round-trip content and normal UI blob/download wiring were exercised; a file appearing in the user's OS downloads directory was not verified.
- Fixture/browser flows establish application behavior, not real Provider access or model quality. Delayed/intercepted responses establish race/error handling rather than naturally occurring upstream failures.
- Mutating150-Case flows were isolated; the user database retained its four original inputs and was read-only during browser acceptance. No required frontend flow remained unverified at recorded acceptance; no live service status is inferred from this record.
