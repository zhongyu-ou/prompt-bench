# Promptbench frontend UI check

## Scope

Core workbench, execution/history, Provider protocols and credentials were exercised in real Chromium at1536×1024 and390×844, against isolated Go services and a local HTTP fixture with fake credentials. Fixture output is labeled `LOCAL HTTP FIXTURE — not a model response`. No paid Provider/model call was made. Case-library/import/routing acceptance is separate in [case-ui-check.md](case-ui-check.md); backend test evidence is in [backend-check.md](backend-check.md), and the contract is [api.md](api.md).

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
