# Backend verification

## Scope and evidence

This record covers core execution, protocol boundaries and credentials in the standalone backend. Checks used automated HTTP tests, a built executable with a local HTTP fixture, and read-only checks of the user service. No paid model services were called; fixture results establish transport and application behavior, not model access or quality. Case workflow and schema3 acceptance are recorded separately in [case-backend-check.md](case-backend-check.md).

The exercised contract is documented in [api.md](api.md). Source evidence: [backend_test.go](../backend_test.go), [credentials_test.go](../credentials_test.go), and [revoke_test.go](../revoke_test.go). These tests use API behavior and actual `httptest` HTTP requests, not source-string assertions.

## Automated coverage and results

| Area | Exercised behavior |
| --- | --- |
| Rendering and request fidelity | Go conditions/ranges/whitespace trimming, dynamic language targets, replacement inputs and ordered system/user messages. Preview JSON/hash match outgoing bytes and persisted raw requests. Omitted parameters stay omitted; explicit null, zero and `"none"` remain present; large JSON integers retain precision. Render bounds and env-file precedence are covered. |
| Frozen replay | Replay survives deletion of mutable cases/templates/providers and retains endpoint, roles, content and parameter bytes. Credentials are resolved again: rotation uses/redacts the current key; missing credentials reject before calls. |
| Responses and redaction | HTTP422, invalid JSON and non-UTF-8 raw responses are retained without retries; requested/returned model identities remain separate. Successful/error key echoes, canonical JSON escapes and arbitrary Unicode escapes in values/model fields/object keys are redacted before database/export exposure. |
| Scheduling | Global20 active-call cap, one-active-batch409, iteration/case/group interleaving, pending/running results and observation independent of the start connection. Cancellation leaves20 issued calls to finish and cancels60 unissued attempts. |
| Storage and recovery | Real SQLite header/private modes, interrupted/unknown restart recovery without resend, exclusive directory locking without live-state mutation, and startup recovery without credential resolution or calls. |
| Validation and boundaries | Atomic version conflicts; stale preview/run409; invalid cases, duplicates, repeats, concurrency and reserved/auth-like parameters; unsafe URL credentials, unknown template functions, hostile Host/Origin, unsupported mutation content type, public binds and credential-forwarding redirects are rejected. |
| Credential lifecycle | Manual overrides take precedence over env; blank/untouched saves retain the right mode; independent profiles may share an env name; replace/clear, availability metadata, anonymous fixtures and invalid env rejection are covered. Failed authentication does not retry or downgrade to anonymous/env. |
| Credential isolation | In-flight key freezing during override changes; old/new/env and escaped-echo redaction; no plaintext in SQLite/GET/export; encrypted restart recovery; missing/wrong keyfile fail-safe; credential-ref ownership/reuse rejection; atomic clear+delete and frozen env fallback; stale pre-rendered state/key coherence. |
| Compatibility | Unsupported protocol preflight, newer-schema rejection and legacy on-disk edits/history/whitespace/hash/results preservation. `TestStaleLegacyTabGetsConflictBeforeProtocolValidation` ensures a pre-migration tab gets409 rather than missing-protocol400. |

The final credential/protocol source passed `go test -race ./...` and the embedded executable build; an independent `go test -race -count=1 ./...` and rebuild also passed with no race reports and an identical executable. These are recorded exercised checks, not a claim that later source changes were tested by this record.

## Built executable and local HTTP fixture

| Scenario | Observed result |
| --- | --- |
| Preview → run → inspect → export | Eight requests at concurrency2: four completed, four HTTP422 failures, no cancellation/interruption/in-flight work; status `completed_with_errors`. Preview equals the executed/persisted request; endpoint/hash match the snapshot; export JSON equals full detail JSON. Embedded HTML and health endpoints returned200. |
| Replay | A new batch retained `replay_of` and the immutable snapshot, reproducing four successes/four HTTP422 failures. |
| Manual over env | A manual override differing from env produced `AUTH MATCH: manual`; an untouched save retained it. Explicit clear then produced `AUTH MATCH: env`. Both runs completed1/1. The fixture reports matches, never key values. |
| Secret exposure | GET/export and SQLite contained no plaintext fake manual key. Snapshots froze protocol, nonsecret Content-Type, credential ref and requires-auth, not Authorization. |

Fixture runs used isolated data directories and conspicuously labeled local responses; they did not alter default user data.

## Credential/protocol migration acceptance

The accepted upgrade preserved the four original Cases, one two-message template, two Providers, two groups and selected Case IDs. State version3→4 added only provider protocol/ref and the version change; canonical comparisons established that other values and IDs were unchanged. Both profiles gained `openai-chat-completions` and stable legacy refs, without creating a manual credential.

Consistent SQLite backups plus the matching key were retained before/after migration and before final replacement, using owner-only directories0700 and files0600. Restart comparisons preserved state, history IDs, summaries and result bytes. Actual user history/results were empty: nonempty legacy-history preservation is test evidence, not a claim about user runs. The private master key/schema metadata were generated without setting/replacing/clearing a user credential.

Read-only API/browser checks found healthy endpoints, only the implemented protocol in the catalog, and nonsecret env credential availability for both profiles. Password dialogs were empty, `type=password`, `autocomplete=new-password`; preview showed protocol and the catalog-generated POST endpoint. State bytes stayed unchanged; no save/run or credential entry occurred. See [UI evidence](ui-check.md) and [Provider page](ui-check/final-user-provider-page.png), [password dialog](ui-check/final-user-provider-dialog.png), [workbench](ui-check/final-user-workbench.png).

## Limits

- Only `openai-chat-completions` was implemented and exercised; no other native provider adapter or real Provider/model access is established.
- Browser interaction and OS-download limits belong to [ui-check.md](ui-check.md).
- The later Case migration supersedes this upgrade's user-state inventory; see [Case backend acceptance](case-backend-check.md). This record is evidence of exercised checks, not a live process-status report.
