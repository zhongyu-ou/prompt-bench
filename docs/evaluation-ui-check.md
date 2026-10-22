# Evaluation UI browser verification

Date: 2026-10-21. Real Chromium (Chrome for Testing from the installed Playwright cache) driven through the Chrome DevTools Protocol from a disposable `/tmp/pb-eval-ui` workspace. No npm package was added to the project and no project `package.json` was created. The isolated app used `--data-dir /tmp/pb-eval-ui/data`; the local fixture served OpenAI Chat Completions and Typesafe System One shapes on loopback. No paid model/JEV call was made.

## Commands

```sh
# isolated app with embedded assets
go build -o /tmp/pb-eval-ui/promptbench .
/tmp/pb-eval-ui/promptbench --listen 127.0.0.1:8899 --data-dir /tmp/pb-eval-ui/data

# local fixture: /v1/chat/completions returns {"corrected_text":"中文原文","en":"Hello 世界"}
# /v1/systemone returns noul/score/choice fixture answers; bearer required
FIXTURE_DELAY=1.5 python3 /tmp/pb-eval-ui/fixture.py   # 127.0.0.1:9777; use a delay to observe stop

# Chrome CDP smoke scripts (throwaway; use global WebSocket, no project deps)
node /tmp/pb-eval-ui/setup.mjs
node /tmp/pb-eval-ui/e2e.mjs
node /tmp/pb-eval-ui/reload-debug.mjs
node /tmp/pb-eval-ui/cleanup-test.mjs
```

## Verified scenarios

- Fresh load: no runtime exceptions or console errors; existing workbench still renders template editor, run-data scope, comparison groups, original run action and the bottom output split. Metric selection is appended inside the existing groups card before the output area.
- Provider UI: created an OpenAI-compatible generation Provider and a Typesafe decision Provider with a manual write-only key. Table/capability tags show 文本生成 and 决策评估; the generation-group selector did not offer the decision Provider.
- Metric UI: created, read, updated and saved code boolean, model boolean, model number, model classification and temporary code number/classification metrics. Boolean threshold, 3 ordered levels and 4 labeled descriptions were persisted through the versioned state save.
- Code trial: JSON Pointer extraction error returned an inline evaluation error; `/en` text produced visible `false` and `true` for English-only and mixed text; code number showed `1.25`; code classification showed the fixed `mixed` label. Trial never used a real Case.
- AI prompt dialog: contained the function contract, arbitrary-JSON-type `input.target`, context fields, 200 ms / 16 MiB / 1 MiB / 64 KiB bounds, synthetic examples only; did not contain the manual key or real Case text.
- Full batch: 8 generations and 32 evaluation steps (4 metrics × 8 results), model-call upper bound 24 (8 × 3 model metrics) shown in the selection area. Result: 24 completed evaluations, 8 deliberate `/missing` pointer errors, batch `completed_with_errors`; generation rows remained successful. Evaluation status is shown separately from generation status.
- Progress/stop: generation and evaluation counts are shown separately (`生成 8/8 · 评估 32/32`). Stop opens the inline warning “停止后不再启动新调用；在途请求收尾，未执行的指标标记取消。” with 继续运行 / 确认停止; continuing kept the batch running. Browser polling was allowed to catch up before summary assertions.
- Evaluation summary: table shows valid/error/result for all selected metrics, true/false distribution, number mean/range, declared classification labels, and independent error/skip/cancel/interrupt counts. Case filter changed the denominator to 2 and count to `2 / 8`; hidden status filter does not affect summary. Group/Case filters remain the original toolbar controls. A second local generation group was added through the UI: the batch then had 12 generations / 48 evaluation steps; the summary showed `true 12 / 12` globally, `true 8 / 8` for the 2-run group, `true 4 / 4` for the 1-run group, and per-group comparison lines for both groups.
- Terminal-detail active-state consistency: after loading the completed batch or the stopped batch through 运行记录 → 在输出面板查看, the top run button read `运行 12 次` and was enabled, the header showed 完成（有错误） or 已停止, and neither the global banner nor validation showed 已有批次正在运行. With a different delayed batch actually running, opening that same completed detail correctly disabled the button as `批次运行中` and showed the active-batch validation warning. This verifies a terminal detail supersedes a stale same-ID run summary while a genuinely active run still blocks. The completed and stopped screenshots were recaptured after these assertions.
- Confirmed stop: with a delayed fixture and evaluations already in progress (12 completed, 12 running, 24 pending), clicking 停止 then 确认停止 settled the batch as `stopped` with completed 24 / cancelled 24, no pending/running steps. All 12 generation outputs were preserved together with completed metric outcomes. Generated output is not discarded, and stopped metrics are not called again.
- Result detail: rows carry a separate evaluation badge (`完成 3 · 错误 1`); the existing result preview gained a 评估 tab with target, value/reason, probabilities/legend, error, response metadata and a link to metric configuration. Output/request/response/details tabs were retained.
- Failure recovery: with CDP network offline, a new metric save failed, the staged metric was rolled back and the editor stayed in create mode; after restoring network the same save succeeded. A focused external-version conflict test showed save conflict, then “重新载入最新状态” reset the metric editor to the accepted server rule.
- Deletion safety: a metric selected by the current draft was deleted; the metric and its `draft.metrics` reference disappeared from server state. Confirmation states that frozen history is unchanged and no historical re-evaluation occurs.
- Extreme finite formatting: `1.7976931348623157e308`, its negative and `1e-9` render as finite strings, not `Infinity`.

## Screenshots

- [Original workbench with batch metric selection](ui/evaluation-implementation/workbench-metrics-config.png)
- [Separate generation/evaluation progress and stop confirmation](ui/evaluation-implementation/stop-confirmation.png)
- [Evaluation summary and independent errors](ui/evaluation-implementation/evaluation-summary.png)
- [Two-group summary with group-filter denominators](ui/evaluation-implementation/evaluation-summary-two-groups.png)
- [Completed-batch row badges and evaluation detail tab](ui/evaluation-implementation/evaluation-detail-completed.png)
- [Confirmed stop: outputs and completed outcomes preserved, remaining metrics cancelled](ui/evaluation-implementation/stopped-batch.png)
- [Code numeric/classification trial](ui/evaluation-implementation/metrics-code-trial.png)
- [Metrics management](ui/evaluation-implementation/metrics-management.png)

Design PNGs remain under [design PNGs](ui/evaluation/); these are implementation captures, not design fixtures.

## Boundaries

The model metrics were exercised against a loopback fixture, not a real Typesafe/JEV account. Real JEV credential availability, semantic quality and provider billing were not verified. No historical batch was re-evaluated; replay behavior remains the backend’s full new batch. Browser screenshots contain synthetic fixture values only. The final e2e harness’s premature summary assertion was a test timing issue (browser poll had not yet loaded the completed detail); it was fixed by refreshing and waiting for `评估 32/32` before assertions.

Final rebuilt-asset smoke (2026-10-21, after removing a stale import discovered by the browser): history → output loaded a completed batch, summary table rendered 4 metric rows, status filter was hidden while group/Case controls remained, evaluation detail rendered 4 blocks, and no runtime exceptions or console errors were observed. The summary screenshot was recaptured from this final build.

## Output table usability — 2026-10-22

- Replaced unlabeled compressed rows with a semantic table: time, iteration, Case, comparison group, model, generation status, evaluation progress, duration, one column per frozen metric, and output/error. Metric values are not colored as pass/fail; execution errors remain distinct. Generation errors take precedence in the output snippet, with full evidence in the existing preview.
- Headers stay visible on vertical scrolling. The result region scrolls horizontally; opening the preview retains every column and its width instead of hiding model/output. Clicking a metric cell opens the existing evaluation preview. Narrow screens stack the preview below the horizontally scrollable table.
- Built with `node --check web/js/output.js`, `node --check web/js/evaluation.js`, and `go build -o /tmp/promptbench-output-ui .`.
- Real managed Chromium, isolated server `127.0.0.1:8794`, existing synthetic data `/tmp/pb-eval-ui/data`: history → completed batch → output rendered 12 rows and 13 aligned columns (4 metrics); table width 1982px remained unchanged when preview opened and left viewport became 702px. Every cell remained displayed. Actual Case dropdown filtered 12 rows to 3 and back to 12.
- Exercised metric-cell click → evaluation tab, keyboard Enter → selected row preview, close → row focus, and rerender preserving measured horizontal/vertical scroll offsets. Header stayed at the scrollport top while rows scrolled.
- In-memory synthetic UI probes, without API mutation: `false`, numeric `0`, and classification `mixed` rendered exactly; a failed generation displayed its error ahead of partial output; a metric-free historical shape rendered 8 headers/8 cells. At 640px, all 13 columns remained accessible through horizontal scrolling, preview stacked underneath, and the document had no horizontal overflow.
- The first smoke caught missing ES-module exports for reused metric render helpers; exports were corrected before final build. Final clean-browser navigation, filtering and preview checks reported zero runtime errors. Earlier harness assertions incorrectly assumed an arbitrary numeric fixture score and unclamped scroll offsets; accepted assertions use actual fixture values and legal scroll bounds.
- Screenshots: [table headers](ui/evaluation-implementation/output-table-header.png), [metric columns with preview](ui/evaluation-implementation/output-table-metrics-preview.png). No real model calls, live configuration edits, or changes to stored history were made.

### Output alignment and value labels — 2026-10-22

- Per user review, the model column is removed; comparison configuration identifies each row. Headers are centered, all body cells except output are centered. Column labels are now “评估状态” and “输出”.
- Generation and evaluation use the same compact status-tag appearance and success/failure wording for completed work. Pending/running/cancelled/interrupted/skipped remain distinct truthful lifecycle states; evaluation counts move into the tag tooltip instead of expanding each row.
- Metric values use labels: amber true, blue false, teal number and purple classification. These colors distinguish values/types, not assumed pass/fail. Existing field-error cells retain an error label.
- Real managed Chromium on isolated `127.0.0.1:8794`: 12 persisted fixture rows, 12 columns for four metrics, no model cells; computed styles confirm every header is centered and only output cells are left-aligned. A generation-success/evaluation-error row shows “成功” / “失败” with identical tag styling.
- Page-global in-memory probes verified false/zero/classification values and distinct label backgrounds, completed evaluation → success, and pending/running/error/cancelled/interrupted/skipped text. Empty-table colspan is 12; original detail was restored without persistence writes. Browser recorded zero runtime errors; syntax checks and embedded build passed. No upstream calls were made.
- [Current centered table and labels](ui/evaluation-implementation/output-table-centered-labels.png). This layout supersedes the preceding model-column/progress-count presentation; the same horizontal-scroll and preview behavior remains.

### Output pagination — 2026-10-22

- Results now paginate after the existing group/Case/generation-status filters: default 20 rows, selectable 50/100, previous/next, bounded numeric page jump and a visible result range. Controls sit outside the horizontally/vertically scrolling table, so they remain accessible with the preview open.
- Changing batch/filter/page size returns to page 1; explicit page navigation closes the previous row preview and resets vertical scroll. Same-filter refresh retains the page, clamps when filtered result counts shrink, and does not overwrite a focused page-number edit. Summary denominators continue to cover all filtered results, not the current page.
- `node --check web/js/output.js`, `node --check web/js/state.js` and the embedded Go build passed. Managed Chromium on isolated `127.0.0.1:8794` loaded existing fixture history, then used page-global in-memory clones for 67 synthetic rows without writing API state/history or sending upstream calls.
- Verified page 1 = 20 rows / range 1–20; next = range 21–40 / first ID 20 and preview closed; jump 99 clamps to page 4 = 7 rows / range 61–67, next disabled. Size 50 resets to page 1 with 50 rows; size 100 renders 67 rows in one page.
- Verified same-filter refresh keeps page 2 and focused, uncommitted page-number text; summary valid count remains 67 despite 20 visible results. Case filtering resets to page 1 with 17 matches. Empty status filtering gives 0–0/0, page 1/1 and both navigation buttons disabled.
- Verified shrinking 67 rows on page 4 to 21 results clamps to page 2 with one row; switching back to the original batch resets to page 1 with its 12 rows; no batch hides the pager. At 640px, pager controls wrap without document horizontal overflow. Browser reported no runtime errors.
- [Pagination screenshot](ui/evaluation-implementation/output-pagination.png) uses explicitly named synthetic data. This is client-side pagination over the existing complete batch detail, reducing rendered rows but not API response size; server pagination and historical data contracts are unchanged.

### Output toolbar simplification — 2026-10-22

- Removed the toolbar's filtered/total count and batch metadata text, including their DOM writes and unused formatter import. The pager still presents its own range/count. Refresh stays at the toolbar's right edge.
- Syntax check and embedded build passed. Real Chromium on isolated fixture history verified both removed elements are absent, refresh is 12px from the toolbar's right edge (its existing padding), refresh retains 12 rows and pager range 1–12/12, and no runtime errors occur. No live data or model calls were involved.

### Dynamic metric enum filters — 2026-10-22

- The toolbar derives one dropdown from each boolean/classification metric in the viewed batch's frozen selection, not the currently edited draft. Boolean options are all/true/false; classification options are all plus declared labels. Numeric metrics have no enum dropdown. Same-name code/model metrics include their type in the label.
- Conditions combine with AND and the existing group/Case filters. A value matches only a completed outcome of the same JSON type; failed/missing/in-flight results never count as false. Values are internally JSON-encoded so boolean false and a classification label named "false" stay distinct.
- Results paginate after metric filtering, reset to page 1 on changes, and share metric predicates with the full filtered evaluation summary. Same-batch refresh preserves selections and select elements; changing batches clears metric conditions. An unselected metric cannot leave a hidden active filter.
- Syntax checks and embedded build passed. Real managed Chromium on isolated `127.0.0.1:8794` first loaded actual fixture history and verified two boolean and one classification dropdown, no numeric dropdown, and declared enum options.
- Page-global in-memory 80-row synthetic fixture: first boolean false selected 40 results (not the 8 errors deliberately carrying false), reset from page 2 to 1; adding second boolean true reduced to 12; adding classification string "false" reduced to 10. Summary valid counts were 10 for each metric. With only the first boolean false condition, independent valid counts were `[40,36,40,34]`, preserving other metrics' running/error exclusions.
- Verified classification label "error" filters completed label values rather than outcome errors; generation-status filtering intersects to an empty page correctly; refresh retains filter nodes/values; switching back to original history clears all conditions. Numeric-only and no-metric snapshots hide the dynamic controls. At 640px the toolbar wraps without document horizontal overflow, with refresh still right-aligned. No browser runtime errors occurred.
- [Dynamic filter screenshot](ui/evaluation-implementation/output-metric-filters.png) contains explicitly synthetic results. Original page state was restored; no API state/history writes, upstream requests or live-data changes were made.

### Default JavaScript trial output — 2026-10-22

- The trial output textarea starts with the user-supplied synthetic JSON (`corrected_text` and English `en`), on initial editor creation, opening an existing metric and starting a new metric. It remains local trial state, not saved metric/Case data.
- Syntax/build passed. Real Chromium on isolated fixture storage verified the exact JSON on initial and new-code editors. Replacing it with custom text and changing target mode preserved the edit; explicitly clearing it and rerendering kept it empty. No runtime errors, state writes or upstream calls occurred.
