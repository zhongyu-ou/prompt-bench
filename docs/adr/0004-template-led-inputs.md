# ADR 0004: Derive input guidance from templates and preserve original Case data

Status: adopted. Supersedes [ADR 0002](0002-shared-input-contracts.md) for active input definitions; frozen historical metadata remains preserved.

## Context

The workbench needs fast template creation and prepared-data import for different services. A shared input contract adds a second field definition and a binding/review lifecycle beside the template itself. The approved workflow uses the template as the import locator, permits arbitrary JSON values and keeps resource import separate from selecting run data.

## Decision

Use native Go template ASTs to discover root input keys for guidance, without inferring requiredness or types. Keep advanced native expressions; mark incomplete discovery instead of demanding a manual schema. Missing discoverable keys become empty strings only in the rendering copy. Callers supply actual arrays/objects when their templates require them. Import preserves original values and fingerprints; real rendering remains the pre-dispatch boundary.

Remove active contract resources and bindings rather than retain two competing input-definition paths. Preserve old definitions/bindings only as frozen historical metadata, including request replay. No physical database migration or history rewrite is needed.

Import owns Cases and optional collection membership, not run selection. Export remains an independent standard-package operation; Case ownership is not tied to the template selected during import.

## Alternatives and consequences

- **Keep shared schemas or infer a full schema:** retains a second maintenance lifecycle or falsely promises types/requiredness that arbitrary Go expressions cannot establish. Root-key guidance is enough for the chosen workflow.
- **Restrict templates/data to string substitution:** simplifies discovery but removes existing native conditional, loop and structured-input capabilities. Preserve those capabilities with explicit complex data instead.
- **Fill missing fields on import:** makes rendering convenient but changes original data and deduplication identity. Render-only defaults preserve omission versus an explicit empty value.
- **Automatically select imported data for a run:** couples reusable resources to execution intent. Users instead select run data in Case 库; adding members to an already selected collection retains ordinary collection semantics.

Exact HTTP/default rules belong to the [client contract](../architecture/client-contract.md#template-inputs); module responsibilities belong to [architecture](../architecture/overview.md#module-responsibilities).
