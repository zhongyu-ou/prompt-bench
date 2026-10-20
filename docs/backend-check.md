# Backend verification — 2026-10-20

Scope: standalone backend in this project only. No paid model services were called. Local HTTP fixtures verify transport, rendering, scheduling and persistence, **not** Azure/model access or model quality. Frontend browser verification/final UI rebuild is owned separately and is not claimed here.

## Initial-release executed commands (historical)

Working directory: `/Users/tmk/Documents/work/timekettle/workspace/promptbench`.

| Command | Observed result |
| --- | --- |
| `go version` | `go1.27.1 darwin/arm64` |
| `go get modernc.org/sqlite@v1.39.1` | Initial proxy TLS timeout; retry succeeded, pinned pure-Go SQLite and transitive modules installed. |
| `gofmt -w main.go model.go store.go render.go engine.go server.go seed.go backend_test.go cmd/fixture/main.go` | Exit 0. Final test/fixture additions formatted separately with exit 0. |
| `go test ./...` | Exit 0: `ok promptbench 0.932s`; fixture command package has no test files. |
| `go mod tidy` | Exit 0; SQLite remains the only direct module requirement. |
| `go test -race ./...` (final backend source) | Exit 0, race detector supported; exact output below. |
| `go build -o /tmp/promptbench-app .` | Exit 0; executable includes then-current source and actual `web/` assets. Later memory/Unicode-escape refinements are covered by the final race check, not this earlier smoke binary. Final user-facing launch must rebuild all final backend/UI sources. |
| `go run ./cmd/fixture --listen 127.0.0.1:9798 --delay 150ms` | Local fixture served successfully. Listening PID43569; supervisor PID43530, service `promptbench-fixture-9798`. |
| `/tmp/promptbench-app --listen 127.0.0.1:8789 --data-dir /tmp/promptbench-backend-smoke-20261020` | Actual app served successfully. PID45061, service `promptbench-app-8789`. |
| `lsof -nP -iTCP:8789 -iTCP:9798 -sTCP:LISTEN` | Confirmed the two owned listeners above. |

Earlier attempted ports9797/8788 were already occupied; those own failed launch attempts exited. No unknown listener was killed. The frontend owns its separate8788/9797 verification environment.

Initial-release backend race-check output (before the later credential/protocol extension):

```text
ok  	promptbench	1.806s
?   	promptbench/cmd/fixture	[no test files]
```

Command exit status: **0**, no race reports. Earlier passes at that stage were `2.024s` and `2.159s`. The newer credential/protocol source verification is recorded below.

## Automated behavior evidence

`backend_test.go` exercises user-visible API and actual `httptest` HTTP requests, not source-string assertions:

- Go conditions, ranges, whitespace trimming, dynamic language targets, empty/nonempty replacement input and ordered system/user messages.
- Preview JSON and hash equal outgoing bytes and persisted raw request, including roles, parameters and endpoint. Omitted parameters remain omitted; explicit null, zero and `"none"` remain present. JSON integers above JavaScript's exact range remain precise in backend storage/rendering.
- Frozen replay after deleting all mutable cases/templates/providers; original endpoint, message roles/content and parameter bytes remain unchanged. Current credential env is resolved again; rotated credentials are used/redacted, missing credentials reject before calls.
- HTTP422, invalid JSON and non-UTF-8 raw responses retained; no retries; requested/returned model identities separate. Key echoes in successful and failed bodies are redacted before database/export exposure, including canonical JSON escaping and arbitrary Unicode escapes in string values, model fields and object keys.
- Global20 active-call cap, one-active-batch409 policy, iteration/case/group interleaving, pending/running results, cancellation of60 unissued attempts while20 issued calls finish, and observation independent of the start response connection.
- Real SQLite file header and private modes, interrupted/unknown restart recovery without resending, and exclusive data-directory locking that rejects a second open without mutating live work.
- Atomic state version conflict, stale preview/run409, invalid cases/duplicates/runs/concurrency/reserved/auth-like parameters, unsafe URL credentials, unknown template functions, hostile Host/Origin, unsupported mutation content type, rejected public binds, and no credential-forwarding redirects.
- Render output bounds and env-file parsing/environment precedence.

## Actual executable + local fixture smoke

An HTTP client against the separately running executable saved fixture-only configuration in the isolated data directory above, previewed, ran, inspected, exported, replayed, and requested the embedded HTML root. Observed:

- Original batch `c2f4050ad3ba4d55f791430cbaae664a`: total8, completed4, failed4, cancelled0, interrupted0, in_flight0, status `completed_with_errors`, concurrency2.
- Replay `66fdded8dcd87552ce117c4898ab7a01`: NEW id, original `replay_of`, same immutable snapshot and the same4-success/4-HTTP422 behavior.
- Preview request equals first executed/persisted request; endpoint and prompt hash match snapshot; `/export` JSON equals full detail JSON.
- Embedded `/` returned200 with Promptbench HTML. Main agent independently read live `/api/health` and both run summaries and confirmed counts and replay linkage.

All fixture responses are conspicuously labeled as local fixtures or deliberate fixture failures. During the isolated smoke above, the default data directory was untouched. The following final launch is separate from fixture state.

## Initial-release integrated build and user-facing launch (historical)

After Main confirmed stable UI assets, executed `go test -race ./... && go build -o promptbench .` with exit0:

```text
ok  	promptbench	2.212s
?   	promptbench/cmd/fixture	[no test files]
```

Built project-root `./promptbench`, embedding final HTML/JS/CSS. SHA256: `b3a4e5f16e79c099fe68d52bb5d834e1ca26493ba1dbec8f52b6d3aab3ae443c`.

Before launch, `$HOME/.promptbench` did not exist and port8787 was free. No existing database was reset. Started `./promptbench --listen 127.0.0.1:8787` from the project directory, PID82888, supervised service `promptbench-user-8787`, database `/Users/tmk/.promptbench/promptbench.sqlite`.

Live checks: `/`200 (32296 bytes); `/api/health`200 with `{"status":"ok"}`; `/api/state`200, version1, 4cases/1template/2providers/2draft groups; `/api/runs`200 with0 histories. No model calls were made by these checks. The user-facing server remains running.

Stopped only owned temporary services `promptbench-app-8789` (PID45061) and `promptbench-fixture-9798` (listenerPID43569); both supervisors reported exited. Unknown/frontend listeners were not touched. Browser evidence and limitations are in [ui-check.md](ui-check.md).

## Manual credentials and protocol boundary extension

The user subsequently authorized persistent write-only manual key overrides and a real protocol boundary. Old env-only/OpenAI-only architectural assumptions are superseded; the current contract is [api.md](api.md), and the task record retains decision history.

Executed `gofmt` on backend changes and `go test -race ./...`. The first run failed `TestRestartAndExclusiveDirectoryLock` because eager startup env inspection invoked credential resolution. That inspection was removed: constructing/recovering an engine now resolves/sends nothing. The suite then passed2.983s, followed by final source check:

```text
ok  	promptbench	2.624s
?   	promptbench/cmd/fixture	[no test files]
```

Final command: `gofmt -w protocol.go && go test -race ./...`, exit0, no race reports. `go build -o /tmp/promptbench-credentials-app .` also succeeded for the isolated HTTP smoke; a subsequent descriptor-allocation cleanup is covered by the final2.624s suite. At backend handoff the root binary had not yet been replaced; the final integrated rollout below supersedes that historical state.

New behavior tests (`credentials_test.go`, `revoke_test.go`, plus migrated existing tests) exercise actual HTTP auth precedence, initial blank/env mode, independent profiles sharing an env name, untouched retention, replace/clear, actual availability metadata, no retries/anonymous downgrade, in-flight key freezing while overrides change, redaction of old/new/env and escaped echoes, no plaintext in SQLite/GET/export, encrypted restart recovery, missing/wrong keyfile fail-safe, credential-ref ownership/reuse rejection, atomic clear+delete and frozen env fallback, stale pre-rendered state/key coherence, unsupported protocol preflight, anonymous fixtures, invalid env rejection, newer-schema rejection, and legacy on-disk edits/history/whitespace/hash/results preservation. A test-only non-Bearer PUT protocol with frozen version header and distinct response parser proves the boundary using real HTTP; it is NOT a production vendor adapter or catalog option.

Owned isolated processes (not user data): app `http://127.0.0.1:8789`, PID11623, service `promptbench-credential-app-8789`, command `env FAKE_PROVIDER_ENV=fixture-env-only /tmp/promptbench-credentials-app --listen 127.0.0.1:8789 --data-dir /tmp/promptbench-credential-backend-20261020`; fixture9798 listenerPID11325/supervisor11297, service `promptbench-credential-fixture-9798`, started with fake fixture auth env values. `lsof -nP -iTCP:8789 -iTCP:9798 -sTCP:LISTEN` confirmed ownership. No unknown listener was killed.

Actual server smoke: manual override higher than a different env value produced `AUTH MATCH: manual`, batch `9ac687fab29bae767f1ad0306bb4e102`; an untouched save retained override; Clear then produced `AUTH MATCH: env`, batch `86417d1949ab8ebbd9f4f4d6680dee4f`. Both completed1/1. GET/export and SQLite contained no plaintext fake manual key; snapshots froze protocol, nonsecret Content-Type, ref and requires-auth. The fixture reports match only, never actual key values. No paid calls.

During backend implementation the existing8787 service/default SQLite were deliberately untouched. Final integrated rollout evidence is below; user data and history were preserved.

## Final integrated rollout — credentials/protocol build (2026-10-20)

**Initial coordinated upgrade:** actual user state was version3 (not the original seed version1), with4cases/1template/2providers/2groups and0histories/results. Backend rechecked active batches immediately before sending only ownedPID82888 SIGTERM; it exited0. The first upgraded supervised service `promptbench-credentials-user-8787`, PID32241, started15:58:10 on the same data directory. Frontend independently inspected this intermediate build without changing user data. The later final stale-tab guard build/rollout is recorded below.

**Intermediate independent build/tests:** frontend ran `go test -race -count=1 ./...` exit0 (`ok promptbench 2.277s`, no races) and `go build -o promptbench .`. That intermediate SHA256 was `49e11b072a8637de2f120d28a7c7a0236683ce415ab29e15ad97135faae48fbd`, 19,519,026 bytes; a separate rebuild matched. Its served assets equaled repository web assets. This preceded the final stale-tab409 guard.

**Migration/backup evidence:**

- Auto pre-migration backup: `~/.promptbench/backups/pre-credentials-20261020T075803292429Z/promptbench.sqlite`, 40,960 bytes, owner-only `0600`; directory `0700`. This snapshot predates the protocol/credential migration.
- Additional post-migration backup: `~/.promptbench/backups/post-credentials-20261020T075952Z/{promptbench.sqlite,credentials.key}`, both `0600`, directory `0700`. Database copied with SQLite's backup API while running.
- Pre backup state version3; live migrated state version4. After removing only the additive `protocol`, `credential_ref`, and version fields, canonical state hashes are identical (`763f517af246b641dd54c81717bb1db335731c2d9016938098eb5d1805e6703f`). Cases+templates content hash identical (`1defa2eed979884da7182f95fc2fd9e4299e7d07b0b12f88185bf8e202efffa7`): 4 cases, 1 template (2 messages), 2 providers, 2 draft groups, 4 selected case IDs.
- Pre and post batch/result counts both 0; batch IDs set and result-ID hash unchanged (empty). No user history existed. Providers gained `protocol="openai-chat-completions"` and stable legacy refs (`legacy:luna`, `legacy:4o`); no manual key was created by this rollout.

**Live API (read-only):** `/` HTTP200, 34,814 bytes equal to `web/index.html`; `/api/health` `{"status":"ok"}`; `/api/protocols` only `openai-chat-completions`; `/api/state` version4, 4 cases/1 template/2 providers/2 groups; `/api/runs` `[]`; nonsecret credential metadata source `env`, available, `requires_auth=true` for both providers. Browser checks captured before/after state SHA256 identical (`805269349f836b0a4aa3f4d2eba859cf502320be73534f736dddec42da019b99`); no save, preview mutation, or run was performed.

**Read-only browser:** 1536×1024 Provider page shows the protocol/type column and credential statuses; edit dialog password field is `type=password`, `autocomplete=new-password`, empty with no persisted key value; workbench preview shows protocol and `POST <catalog-generated endpoint>` with request details. Screenshots: [final-user-provider-page.png](ui-check/final-user-provider-page.png), [final-user-provider-dialog.png](ui-check/final-user-provider-dialog.png), [final-user-workbench.png](ui-check/final-user-workbench.png). Console/errors empty.

**Cleanup:** frontend verified owner/command/cwd/PIDs and stopped only backend temporary services `promptbench-credential-app-8789` (PID11623) and `promptbench-credential-fixture-9798` (listener11325/supervisor11297). Its8788/9797 test services were also stopped. No unknown listener was killed, and no paid calls were made. Final user PID follows below.

## Final stale-tab-safe executable and preserved user service

The last small correctness fix moves state validation behind the locked optimistic-version guard: a pre-migration tab now receives409 rather than missing-protocol400. Added behavior regression `TestStaleLegacyTabGetsConflictBeforeProtocolValidation`. Final executed command/output:

```text
$ gofmt -w store.go server.go revoke_test.go && go test -race ./... && go build -o promptbench .
ok  	promptbench	2.340s
?   	promptbench/cmd/fixture	[no test files]
```

Exit0, no race reports. Before replacing only owned interimPID32241, backend again checked active batches (none), then SIGTERM exited0. A matching stopped backup of both0600 `promptbench.sqlite` and `credentials.key` is in0700 `/Users/tmk/.promptbench/backups/pre-final-binary-20261020T080043905131Z`. Original stopped pre-migration backup `/Users/tmk/.promptbench/backups/pre-credentials-20261020T075803292429Z` contains the original SQLite; no keyfile existed before migration.

Final project-root `./promptbench` SHA256: `28c02061101f59f282e24230e490f7604764b98c679831896d83e1b083a51189`. Started `./promptbench --listen 127.0.0.1:8787` from this project, PID**42232**, service `promptbench-final-user-8787`. Default `/Users/tmk/.promptbench/promptbench.sqlite` retained, service remains running.

Programmatic comparison with stopped backups confirmed initial userstate3→4 changed **only** version plus added provider protocol/ref; all original case/variable/template/provider config/draft/settings values and IDs survived. On final binary restart the entire persisted version4 state, history-ID set, batch summaries and result bytes were exactly unchanged. Actual user history/results counts were0; nonempty legacy history preservation is proven by tests, not invented user runs. No user credential was set/replaced/cleared; the migration only generated the private master keyfile/schema metadata.

Final read-only GET evidence: root200/34814bytes; health200 `{"status":"ok"}`; state200/version4/4cases/1template/2providers/2groups; runs200/0histories; protocol catalog only `openai-chat-completions`. Both existing profiles expose only `manual_set=false,env_available=true,source=env,available=true,requires_auth=true`. No actual credential values were displayed, logged or exported. No model requests or paid calls were initiated during upgrade.

Frontend independently verified this exact finalPID42232 binary with `go test -race -count=1 ./...` (exit0,2.320s) and `/tmp/promptbench-final-verify` build (identical SHA25628c020…1189). Final read-only Chromium Provider page/blank password dialog/workbench preview reported no console/errors; state byte hash `805269349f836b0a4aa3f4d2eba859cf502320be73534f736dddec42da019b99` stayed unchanged. Current screenshots and limitations are in [ui-check.md](ui-check.md). No further source/restart operations followed.
