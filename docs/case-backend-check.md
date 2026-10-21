# Case workflow backend verification

## Scope and evidence

Case APIs, collections, selection, lossless variables, frozen provenance and schema3 migration were exercised with regression tests, JSON HTTP requests against a built server/local fixture, and final user-service preservation checks. No paid model calls were made. Generated inputs stayed in isolated test databases. Generic execution, credentials and protocol coverage belongs to [backend-check.md](backend-check.md); contracts are in [api.md](api.md), browser evidence in [case-ui-check.md](case-ui-check.md).

Source evidence includes [case_workflow_test.go](../case_workflow_test.go). Final verification executed `go test -race ./...`, `node --check web/app.js`, `node --check web/case.js` and the embedded root build: all passed, with no race report; the fixture package had no tests.

## Built-server HTTP coverage and results

The following assertions passed through actual JSON HTTP requests to the executable, not direct Store calls or only `httptest`:

| Area | Observed result |
| --- | --- |
| Import and selection | Standard JSON imported150 generated Cases. Collections of12 and20 overlapped by3:29 unique Cases; two temporary exclusions selected27. Two groups×20 repeats produced1080 requests in selection preview. Runs remained empty: selecting did not start execution. |
| Execution and frozen replay | Narrow generic state PUT omitted Cases/collections and configured an anonymous local fixture plus exact zh→en/en→jp routes. One Case/group/repeat completed successfully; persisted raw request equaled preview. After changing CurrentText and the current route, replay retained the original snapshot and byte-identical request. |
| Lossless variables | Case creation retained decimal1.0, integer9007199254740993 and `[null,"1",1]`. An unrelated Provider save preserved canonical `variables_json` exactly; patching only CurrentText retained unknown numeric literals. |
| Export/import precision | JSON and JSONL exports of the typed Case plus an explicitly selected empty collection preserved1.0 and9007199254740993. Both reimports reported0 new/1 existing; the empty collection survived both round trips. |
| Collections | Create, add-member, rename and delete succeeded; collection deletion did not delete its Case. |

## Regression coverage

Race-tested behavior covers exact/default language routing, forbidden execution-owned Case override, membership filtering, type/fingerprint variations and installed schema2 migration preservation.

- `TestFrozenCollectionProvenanceSurvivesRenameMembershipAndDeletion` verifies history export retains frozen collection IDs/names/original membership after current rename/removal/deletion, including independent copied slices. Concrete selected Cases and selection/exclusion IDs remain separate from optional `snapshot.collections` provenance.
- `TestLegacyHistoryExportRetainsRecordedCaseIdentityAndBody` verifies historical export retains recorded old Case name/description/ID, request/result raw bodies and hashes while current Case APIs remain name-free.
- A focused legacy-empty-list regression covers root Case/Collection arrays and equivalent unchanged root nil/[] echoes. This normalization is limited to root resource lists, not nested variable null/[], array order or numeric literals.

## Migration and final acceptance

### Preservation method

Read-only preflight used SQLite's online backup API with a read-only source connection plus the matching key, not an unsafe live-file copy. Private directories were0700 and DB/key files0600. A copy was migrated with an empty environment and no Provider calls. Immediately before authorized rollout, actual state/history were read again, idle status confirmed, a fresh copy preflight repeated and all eight original Case×group previews compared. Source state/runs stayed unchanged during preflight.

The owned old service was stopped gracefully only after those gates. Consistent stopped DB/key backups were retained under `~/.promptbench/backups/`, with an additional consistent post-migration pair. Original key bytes were preserved. Required existing credential environment values were transferred in memory without printing them, embedding them in commands, writing a new plaintext env-file, or persisting them in state/snapshots.

### Observed user-data results

| Invariant | Accepted evidence |
| --- | --- |
| Schema and inventory | Schema2→3, state version4→5; four original Cases, zero collections and zero history/results. No150-Case fixture or fake history entered user data. |
| Case identity/input | Current Cases received new random32-hex IDs; draft references mapped to them. Variables matched originals after removing only execution-owned TargetLanguageNameMap, without text/type/whitespace changes. DTOs contain id/variables/derived variables_json, not current Case names/descriptions. |
| Configuration | Both groups retained all prior fields/parameters and runs20, adding explicit zh-CN→en/English routes. Settings stayed3/20/120. Template roles/content (including user `hi`), Providers/immutable credential refs and nonsecret availability metadata were unchanged. |
| Archive/storage | Private migration archive raw state_data equaled the stopped schema2 bytes. Credential/history/result rows and matching key bytes compared equal. Final restart left schema3 stored state bytes unchanged. Actual encrypted credential/history row counts were0; nonempty preservation is covered by tests, not invented live records. |
| Wire equality | All eight original Case×group previews on the final service equaled captured old-service raw_request, prompt_hash, endpoint, protocol, method and nonsecret headers. All routes resolved exact zh-CN→en/English without default. No Provider call was made. |
| Lossless projection | Final live render-only projection retained1.50,9007199254740993, untouched CRLF, nested2.00 and distinct null/[] arrays; state bytes did not change. |
| Integrated assets | Final embedded HTML/JS/CSS matched repository files. Independent read-only Chromium verified workbench/library/group editor/settings with no console/app errors and unchanged state bytes/runs. |

The final workbench showed the real four Cases×20 repeats×two groups=160 potential requests, without starting a batch. See [final workbench](case-ui-check/final-user-workbench.png), [final Case library](case-ui-check/final-user-case-library.png) and the [browser acceptance record](case-ui-check.md). Temporary owned test services were stopped; unrelated processes and user inputs were not reset or rolled back.

## Limits

- Fixture execution establishes HTTP/application behavior, not live Provider/model access or quality; no paid calls were made.
- The actual user database had no history or encrypted manual credential rows. Nonempty migration/history preservation claims derive from regression tests.
- Browser import/export and OS download-manager limitations are recorded separately in [case-ui-check.md](case-ui-check.md). No required backend acceptance item remained pending at the recorded final acceptance; this document is not a live process-status probe.
