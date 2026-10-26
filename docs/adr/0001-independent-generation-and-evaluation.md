# ADR 0001: Separate generation and evaluation

Status: adopted by the current implementation. This record consolidates the existing design; it does not assign a retrospective approval date.

## Context

Judging an existing output must not generate it again or change whether its original generation succeeded. The earlier inline design coupled generation, decision credentials and judgment lifecycle. Generation repeats also must not be mistaken for repeated judgment of one output.

## Decision

Generation and evaluation have distinct durable identities, frozen snapshots, status, progress and Stop behavior. An evaluation selects successful concrete Result IDs from one terminal generation and judges each selected Result/Metric pair once. Selecting metrics at generation launch queues that same single-pass evaluation server-side; it does not add an inline generation stage. No metrics means generation only, without decision-key lookup.

Re-evaluating with current saved rules creates a new evaluation and leaves earlier judgments intact. Generation replay is generation-only; evaluation replay uses its frozen sources/rules for one pass without generating text. Historical inline and multi-round outcomes remain readable under their original identity, not converted or extended.

## Consequences

Generation can succeed while evaluation fails or stops; valid-value denominators use completed judgments only. The browser presents one selected evaluation version in the existing output, preview and summary rather than a second workspace. Separate snapshots and server-owned chaining require explicit lifecycle coordination, but prevent browser lifetime, later edits or another version from changing the evidence.

The current structure and constraints are in [architecture](../architecture/overview.md#execution-and-history-constraints); client behavior is in the [client contract](../architecture/client-contract.md).
