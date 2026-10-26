# ADR 0003: One PostgreSQL session owns the schema lock

Status: adopted by the current implementation. This record consolidates the existing design; it does not assign a retrospective approval date.

## Context

One local process owns dispatch and recovery for a database/schema. Another process must not initialize or interrupt its live work, even when launched with a different credential-key directory. PostgreSQL session advisory locks disappear with their physical connection; silently replacing that connection would lose ownership while allowing the original process to keep dispatching.

## Decision

Use one physical SQL session to hold the database/schema-scoped advisory lock and serialize transactions. Acquire it before initialization, credential writes or recovery. Reject a second owner before mutation. Connect directly or through session pooling, never transaction pooling.

If the session is lost, refuse reconnection and further persistence/dispatch. Restart is required to reacquire the lock and recover unfinished executions as interrupted; recovery does not automatically resend work that may already have reached or been billed by a Provider.

## Consequences

Transaction throughput is intentionally serialized for this single-user application. Session loss requires an explicit process restart rather than transparent database recovery; HTTP liveness alone cannot establish storage readiness. The simpler ownership boundary prevents two surviving dispatchers from relying on a lock only one of them holds.

Current storage constraints are in [architecture](../architecture/overview.md#storage-and-migration), and operational guidance is in [README](../../README.md#persistence-backups-and-limits).
