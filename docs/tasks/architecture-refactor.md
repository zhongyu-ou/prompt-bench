# Architecture refactor

## Scope and contracts

The frontend now uses native browser ES modules and ordered, responsibility-based CSS files. No framework, bundler, package manager, runtime dependency, or new product setting was introduced. `web/index.html` remains the static shell; `web/embed.go` exports `web.Assets`, rooted at `index.html`, for `http.FileServer(http.FS(web.Assets))`.

Domain vocabulary and HTTP contracts remain those in [the glossary](../../GLOSSARY.md), [API](../api.md), and [Case API](../case-api.md). This unified task reorganized both backend and frontend without schema or state-version changes. [README Layout](../../README.md) describes the final repository organization.

## Backend ownership

Root `main.go` is a 13-line process entry point calling `workbench.Run()`. Application implementation, white-box tests, and the embedded seed moved together into `internal/workbench`; `run.go` owns the exported startup function. Existing private construction seams remain private functions rather than new interfaces or exported compatibility wrappers.

The server imports `promptbench/web` and serves `http.FileServer(http.FS(web.Assets))` directly, without `fs.Sub`. Approved local simplifications use standard-library `Contains`/`IndexFunc`, inline the single-use default data-directory value, merge adjacent migration loops, and remove a tautological nil assertion while retaining the real `[]` read assertion. These cleanups do not change persistence or API contracts.

## Module ownership

All JavaScript lives in `web/js/`:

- `state.js`: one browser-session `App`, including versioned editable state and UI-local drafts. Nothing is published on `window`.
- `constants.js`, `utils.js`, `model.js`: constants, escaping/value/formatting helpers, state normalization/lookups, selection resolution, and dirty/generation calculations.
- `api.js`, `feedback.js`: same-origin JSON transport and visible connection/banner/toast/render-error feedback.
- `shell-view.js`, `navigation.js`: shell/dirty indicators, view visibility, and unsaved-editor navigation guards.
- `workbench-view.js`, `templates.js`, `run-plan.js`: current Case/group summaries, template/message editing, and validation/request counts.
- `groups.js`, `selection.js`: group parameters/language routes and staged Case/collection run selection with authoritative count previews.
- `persistence.js`, `mutations.js`: generic draft/credential saves and dedicated Case/collection mutations. Existing version, edit-generation, and concurrent-edit adoption rules remain here.
- `preview-state.js`, `preview.js`: preview invalidation and server-rendered request display/copy, preserving stale-response tokens.
- `runs.js`, `output.js`, `snapshot.js`, `history-view.js`, `history.js`, `compare.js`: run lifecycle/polling/Stop, result/snapshot rendering, frozen history/replay, and comparison.
- `providers.js`, `settings.js`: Provider/protocol/credential editing and global settings.
- `case-library.js`, `case-editor.js`, `case-io.js`: library/collection workflows, lossless Case form/JSON edits, and standard-package import/export.
- `main.js`: startup, ordered cross-feature rendering, and global lifetime/dialog/navigation event composition. Feature event handlers live with their feature.

Imports are direct named dependencies, not a barrel, exported handler registry, event bus, or global-script convention. Three concrete reverse dependencies use composition hooks installed before startup: navigation's post-view rendering, persistence's state-adoption/credential/reload rendering, and mutation surface/editor rendering. The dependency graph is acyclic; the largest JavaScript module is `case-editor.js` at 594 lines.

CSS lives in `web/css/`, with links in exact former cascade order: base, layout, controls, cards, templates, tables, preview, output, history, providers/settings, overlays, original responsive rules, workflow-shell overrides, workbench, selection, Case library/editor/import-export, groups, collection dialogs, and final responsive overrides. `responsive-base.css` intentionally precedes later workflow overrides; merging all responsive rules at the end would change existing behavior.

Removed the obsolete `web/app.js`, `web/case.js`, and `web/style.css`. Deleted the approved 223 lines of unused CSS and unused `.config-table`/`.two-col` selector branches, preserving `.chip-remove` and active shared rules. Removed audited unused constants/helpers/local/write-only fields and the redundant synchronous second import-version check. Statically imported functions no longer have legacy optional-script guards. Dynamic banner callbacks remain guarded. Credential dirty markers, distinct title writes, JSON lexemes/patches, preview equality, and async generation guards were retained.

## Exercised verification

Integration-owner verification reported `go test -race ./...` passing (`ok promptbench/internal/workbench 3.137s`), `go vet ./...` exiting 0, and `gofmt -l` producing no output. A temporary binary built successfully and its `--help` retained the existing flags. An independent final asset-serving smoke confirmed all 29 JavaScript and 21 CSS assets returned HTTP 200 with correct MIME types, with no obsolete executable asset paths or inline global handlers. These backend/integration checks were not rerun for this documentation follow-up.

Browser smoke used a newly allocated `/tmp/promptbench-frontend-gTgpmm` data directory, application `127.0.0.1:8789`, and `cmd/fixture` at `127.0.0.1:9798` with 600 ms delay. Direct `go run .` did not read an env file or the real database. Only the local fixture group was enabled before any run.

- All 29 final JavaScript files passed `node --input-type=module --check` through stdin. A throwaway Acorn/scope-analysis traversal of actual files found 29 acyclic modules and no unresolved application identifiers. Analysis dependencies were installed outside the repository, not added to the application.
- A rebuilt/restarted server served all 29 JavaScript and 21 CSS assets with HTTP 200. No import/initialization error, missing asset, or application unhandled error was observed. `typeof App` and `typeof apiRaw` in the page global scope were both `undefined`.
- Provider creation, group creation, `zh-CN → jp` route, settings saves, draft save, and server request preview succeeded.
- A fixture run completed 8/8 requests. Preview, frozen request, and persisted result raw request bytes matched. Frozen-history replay followed by Stop completed its one in-flight request and cancelled seven unissued requests.
- History detail and two-batch comparison rendered. Output result/snapshot tab controls worked.
- Delaying a draft PUT while editing again preserved the newer local draft and saved only the submitted draft. Delaying a Case PUT likewise retained the editor and its newer `CurrentText` while adopting the submitted server value.
- Case creation, collection creation/rename/membership, form-to-JSON patch preview, save, library selection for debugging, and collection-based run selection succeeded. `9007199254740993`, `1.2300`, null, zero, and a numeric-looking string survived the lossless Case edit path.
- JSONL import created one Case, then repeated import reused it. JSON and JSONL UI export blobs preserved `9007199254740995` and `0.0001000`. Re-previewing the JSON export recognized both exported Cases as existing.
- External version advancement caused import commit HTTP 409; recovery retained the file content and regenerated a usable preview. A local settings save made an earlier import preview stale and disabled commit.
- A deliberately intercepted credential-save 409 retained the pending credential and the `●` title/dirty marker; the dummy credential was then discarded. A delayed request preview was rejected after a newer template edit, leaving the preview marked `需刷新`.
- At 1440×1100 and 390×844, computed styles for 1,797 DOM elements matched the original stylesheet exactly (zero differences), excluding transient toasts. Desktop/mobile workbench screenshots were captured; no horizontal document overflow was observed at those widths.

## Evidence and limitations

Structured evidence, including the actual final import graph, run IDs, exact exported blob contents, diagnostics, and screenshot locations:

`/tmp/promptbench-frontend-gTgpmm/frontend-evidence.json`

Desktop screenshot: `/var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/omp-sshots-15aeb022cbc1da13.webp`

Mobile screenshot: `/var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/omp-sshots-15aeb0226d01da12.webp`

Evidence is local and temporary. Browser download-manager reporting did not expose saved files; export verification captured the actual UI-created Blob bytes instead. One temporary browser-check expression produced an instrumentation-only page error while looking for a test property in the automation's isolated world; that probe was removed, and final rebuilt-page diagnostics contained no errors. Expected 409 responses were deliberately exercised, not startup failures. Fixture success verifies wiring/transport/lifecycle, not paid-provider access or translation quality. The integration owner independently reviewed the structured evidence and desktop/mobile screenshots. Historical QA documents remain historical records rather than being rewritten as new test claims.
