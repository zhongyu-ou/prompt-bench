# ADR 0002: Edit shared input contracts in place and freeze history

Status: superseded by [ADR 0004](0004-template-led-inputs.md). The historical snapshot-preservation requirement remains in force.

## Context

Compatible templates need a common definition of already prepared inputs. Copying definitions into every template allows drift; per-template contract-version upgrades add a separate lifecycle. Cases and collections already own inputs and organization, not input processing or schema versions.

## Decision

Templates may share one editable input contract or remain unbound. Shared edits affect future uses of all referencing templates; impact review identifies affected templates and Case incompatibilities before saving. Contracts validate structure and meaning without coercion, default injection, retrieval or history truncation. They do not replace collections or own execution-injected target languages.

When incompatible input formats must coexist, copy the contract rather than adding a contract-version/upgrade mechanism. Generation snapshots freeze the definition actually used; evaluation retains the original source context, never a later edited Case or contract.

## Consequences

A deliberate shared edit updates future uses together, so stale impact responses cannot confirm a newer draft. Existing history remains intelligible without keeping mutable historical contract versions in current editable state. Coexisting incompatible formats require separate contracts rather than silent migration of their inputs.

Current ownership is in [architecture](../architecture/overview.md#module-responsibilities); current template-input and historical read behavior are in the [client contract](../architecture/client-contract.md#template-inputs).
