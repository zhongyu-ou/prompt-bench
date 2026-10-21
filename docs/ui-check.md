# Promptbench frontend UI check

## Scope

Core workbench, execution/history, Provider protocols and credentials were exercised in real Chromium at1536×1024 and390×844, against isolated Go services and a local HTTP fixture with fake credentials. Fixture output is labeled `LOCAL HTTP FIXTURE — not a model response`. No paid Provider/model call was made. Case-library/import/routing acceptance is separate in [case-ui-check.md](case-ui-check.md); backend test evidence is in [backend-check.md](backend-check.md), and the contract is [api.md](api.md).

## Sidebar and result preview update (2026-10-21)

- Real Chrome verification used an isolated data directory and the anonymous local HTTP fixture; no paid calls or user database changes.
- The header toggle reduces the desktop sidebar to a 64px icon rail. Navigation remains usable, the accessible expanded state changes, and the preference survives reload. At 390px, the same toggle hides/restores the navigation strip.
- Run output and history results now use selectable rows with a right-side preview instead of inline expansion. Parsed output/error appears first, followed by request metadata and raw request/response. The list and preview scroll independently.
- A three-request successful batch exercised row switching, explicit refresh retaining selection, status filtering clearing a hidden selection, Enter activation, Escape dismissal, and history-to-workbench navigation.
- A 24-request HTTP 422 batch with concurrency 1 reached 24/24. The selected result remained selected across polling, and the preview showed `upstream HTTP 422`.
- Visual checks at desktop width and 390px confirmed side-by-side list/preview placement and no document horizontal overflow at 390px. The range card shows one request total; repeated multiplication formulas and the redundant successful-validation line are removed. Validation errors and warnings remain.
- Chrome reported `Could not establish connection. Receiving end does not exist.` without an application stack; this session does not claim an empty browser error log.

## Tabbed result preview and JSON rendering (2026-10-21)

- The workbench and history now share four preview tabs: 输出, 请求, 响应, 详情. Only the active pane is rendered; details contain request metadata and non-authentication headers. Output errors remain visible in the output pane.
- Real Chrome checks used isolated storage, the local Go fixture and a temporary loopback JSON upstream. No user database or paid Provider was used. The request pane visually matches the Pencil reference: active underline, two-space JSON indentation, colored tokens, and internal horizontal scrolling for long strings.
- A 24-request JSON batch at concurrency 1 reached 24/24. During polling, the selected result, request tab and horizontal scroll position remained unchanged; GET confirmed the selected raw request was unchanged. Switching to the second row after selecting a tab opened that result and retained the tab.
- JSON output displayed `9007199254740993` and `1.2300` exactly, with separate colors for keys, strings, numbers, booleans and null. An upstream `<img src=x onerror=alert(1)>` stayed literal text: the preview contained no image or script elements. The formatter validates JSON but formats original tokens rather than reserializing parsed numbers.
- Plain fixture output remained plain text. `fixture-invalid-json` produced its decode error in 输出 and verbatim `not JSON (fixture)` in 响应, without JSON highlighting. Request and response tabs also displayed successful JSON; 详情 retained HTTP status, model, duration and prompt hash.
- Verified explicit refresh retaining selection/tab/scroll, row switching, filtering out the selected row closing the preview, arrow/Home/End tab navigation, Escape dismissal, and the same request highlighting in history. At 390×844, one content pane remains visible; the tab strip and JSON scroll internally without widening the document.
- Result buttons now retain their DOM identity while polling, rather than replacing the entire list and interrupting an in-progress click. The preview body is not replaced when its rendered content is unchanged.
- `node --test web/json-preview.test.mjs` passed all five regression checks: numeric/escape fidelity and duplicate keys; HTML injection safety; malformed/plain-text fallback; JSON scalars/empty containers; bounded large/deep input. The existing 400,000-character display ceiling remains: oversized input is shown as clipped plain text, and formatting expansion is bounded with a visible notice.
- Chrome also reported `Could not establish connection. Receiving end does not exist.` without an application stack. This verification does not claim an empty browser error log.

## Simplified workbench and wrapped previews (2026-10-21)

- Real Chrome checks at 1568×1070 and 390×844 used isolated storage and the local Go HTTP fixture. No real Provider or user database was used.
- Workbench now has left template/right configurations, a top-right run action, and a read-only data-scope summary. Removed standalone Case/request previews and runtime-setting inputs. Case-library selection and temporary exclusions remain functional: three existing exclusions survived reload; removing one in Case 库 produced two effective Cases, then applying returned to workbench. Selecting all four library Cases replaced the scope and cleared exclusions explicitly.
- Template rename, copy, create, message add/delete, system/developer/assistant role selection, binding mismatch navigation and save/reload were exercised. The blank role selector now uses protocol-catalog options. Saving an unbound editor template retains its template, message and role rather than switching back to the selected group's binding.
- Global settings saved concurrency 2 and default repeats 5; the existing group's three repeats stayed unchanged. A six-request batch used concurrency 2 and the saved system message role. A subsequent four-Case batch completed 12/12.
- A delayed state save followed by a new message edit retained the new message and dirty state and sent zero run POSTs. Removing that new message restored the saved state and disabled the unnecessary Save action.
- Request/response JSON wrapped without horizontal content overflow in workbench and history, including the narrow preview at 390px. A real copy-icon click followed by clipboard paste exactly matched the stored 1,928-character raw response. Clipboard-denial feedback is implemented but was not exercised here.
- Five existing JSON fidelity/security/limit regression checks passed, as did the new template-selection preservation/deletion-fallback regression. Changed frontend modules passed Node syntax checks. Backend contracts were not changed; no Go test suite was run for this UI-only change.
- Follow-up toolbar check: template Rename / New / Copy / Delete share the same row at 1568px. The preview copy icon is inside the content area's upper-right corner with a transparent background; a real click still reported successful copying. The header retains only the preview title and Close.
- Copy-icon spacing correction: removed the extra top reservation; the opening JSON brace and transparent icon now share the first content row. Browser screenshot verified 12px content top padding; right padding prevents text from overlapping the icon.




## Exercised coverage and results

| Area | Actual browser/HTTP evidence |
| --- | --- |
| Draft editing and templates | Arbitrary Case variables and HTML text survived save/GET. Go condition/range templates rendered successfully, without raw template syntax. Group selection focused its bound template; browsing another template showed the mismatch warning and did not change the group's preview binding. |
| Provider/group configuration | Added an anonymous fixture Provider and three groups (success, HTTP error, invalid JSON). Advanced custom parameters survived. Omitted/null/0.2/`none` and nonstandard advanced values remained distinguishable in preview; request counts showed5 and320 for the exercised configurations. |
| Run and results | Five requests reached5/5, `完成（有错误）`, with success, HTTP422 and JSON decode failure. Expanded rows exposed precise raw requests/responses and parsed output/error. Status/group/Case filters returned2/5,3/5 and5/5 respectively. |
| Stop and refresh | A320-request run stopped with300 cancelled,7 completed,13 failed and0 in-flight; issued calls finished and persisted. Refresh during execution recovered the same batch and continued progress without resetting editors/layout. |
| Polling and save races | Progress updates retained unsaved text, focus, caret and scroll. Delayed PUT saved only its submitted snapshot while preserving later edits as dirty. Editing during preview-save prevented preview; editing before a delayed preview response discarded the stale response and marked preview for refresh. |
| History/snapshots/replay | History showed frozen Cases/templates/Providers/groups/rendered requests and statistics. Replay created a new batch with `replay_of`; comparison aligned Case×configuration with parameters and outputs. |
| Export | The real export link returned200 with attachment filename and batch/snapshot/results JSON (about1.4MB), with no key-shaped strings found. This verifies HTTP export, not OS file landing. |
| Text safety and layout | Fixture-echoed `<img ... onerror=...>` remained text: no image element or executed marker. At390px, pages had no horizontal overflow; tables/navigation scrolled internally and dialog submit actions stayed reachable. Desktop output stayed within the viewport, with long content internally scrollable. Browser error collections were empty. |

## Protocol and credential coverage

These flows used real browser interaction and local auth-fixture HTTP responses, except explicitly simulated errors/delays below. The UI used `GET /api/protocols`; only `openai-chat-completions` was offered, and unknown protocols were disabled/blocked. Type, endpoint and auth hints came from the catalog. Write-only `credential_updates` were committed atomically with the draft; GET returned only nonsecret metadata.

| Scenario | Observed behavior |
| --- | --- |
| Env → manual → clear | Env-only metadata showed `source=env`, available; only the env-auth fixture succeeded. Saving a different manual key switched to `source=manual` and only manual-auth succeeded. Clear restored env success/manual401. Ordinary name edits did not clear the override. |
| Replace and failure policy | Replacing with a wrong manual key made both auth fixtures return401: neither the old key nor env fallback was used. |
| Anonymous/missing | Empty env/no manual key showed `anonymous`, available, requires-auth=false and ran successfully; unset named env showed `missing`, unavailable. |
| Write-only/no leak | Password fields cleared after submit/close and stayed empty on reopen/refresh. GET, history DOM, raw request and export contained no fake manual/wrong/env keys or Authorization/Bearer. No localStorage/sessionStorage writes occurred. |
| Failed/conflicting saves | Simulated PUT500 retained pending manual state without password echo; state-version409 retained pending credentials and warned before reload cleared them. |
| Async credential saves | A clear staged while a replacement save was in-flight remained pending after that response; the UI stayed dirty until a second save applied clear. Only unchanged successfully submitted mutations were cleared. |
| Clear/delete | Pending clear plus deletion committed atomically, removing Provider/groups/metadata. Deleting an uncleared persisted override warned that its encrypted reference remains for historical replay; deleting a new unsaved Provider discarded pending keys. |
| Frozen request display | Snapshot/preview showed protocol, POST endpoint, requires-auth, nonsecret headers and credential ref, without auth headers/secrets. Endpoint construction was server-driven, not a frontend `/chat/completions` constant. |

## Screenshot references

| Evidence | Screenshots |
| --- | --- |
| Workbench and results | [Clean workbench](ui-check/initial-clean-workbench.png), [fixture results](ui-check/run-results-fixture.png), [history comparison](ui-check/history-compare.png), [protocol preview](ui-check/final-workbench-provider-protocol.png) |
| Responsive layout | [Narrow workbench](ui-check/narrow-mobile.png), [group dialog](ui-check/narrow-dialog.png), [Provider dialog](ui-check/provider-narrow-dialog.png) |
| Provider lifecycle | [Management](ui-check/provider-management-final.png), [credential dialog](ui-check/provider-credential-dialog.png), [clean metadata](ui-check/provider-management-clean.png), [manual saved](ui-check/provider-manual-set-evidence.png), [clear to env](ui-check/provider-cleared-env-evidence.png) |
| Read-only user acceptance | [Provider page](ui-check/final-user-provider-page.png), [empty password dialog](ui-check/final-user-provider-dialog.png), [workbench](ui-check/final-user-workbench.png) |

## Integrated read-only acceptance

The credential/protocol build passed independent race tests and rebuild comparison; served assets matched repository assets. Read-only Chromium verified the Provider protocol/status columns, empty password dialog and catalog-derived preview. The migrated user state retained four Cases, one template, two Providers/two groups and no history; version3→4 preserved original values apart from additive protocol/ref/version. State bytes were identical before/after browser inspection, with no save, run or key entry. Console/errors were empty. Later Case-schema acceptance and the current user-data inventory are in [case-ui-check.md](case-ui-check.md).

## Limitations

- Local fixture behavior does not establish real model access or quality. Only the OpenAI Chat Completions adapter was implemented; no Anthropic/Gemini adapter is claimed.
- The relay browser did not expose actual OS download-manager/file events. The export endpoint, attachment headers and content were verified, not a file appearing in the user's download directory.
- Error/conflict/delay interceptions test UI handling; they are not evidence of naturally occurring upstream failures. Mutating flows ran only in isolated data directories; user-service acceptance was read-only.
