# Documentation map

## Read by responsibility

| Question | Authoritative home |
| --- | --- |
| How do I run, configure, use and back up the workbench? | [Root README](../README.md) |
| What do Case, Collection, Group, Result and Evaluation mean? | [GLOSSARY](../GLOSSARY.md) |
| Where does a behavior belong in the code, and why are the boundaries shaped this way? | [Architecture](architecture.md) |
| What are the current state, credential, input-contract, generation, metric and evaluation HTTP contracts? | [API](api.md) |
| How do Case edits, selections, language routes and import/export work? | [Case API](case-api.md) |
| How do I verify a change safely? | [Verification](verification.md) |
| What was observed during earlier user-data migrations? | [Migration evidence](evidence/migrations.md) |
| What do earlier isolated checks establish, and which artifacts remain available? | [Validation evidence](evidence/validation.md) |
| What repository constraints must a change preserve? | [AGENTS](../AGENTS.md) |

The documents describe repository behavior, not current process health, deployment status or database inventory. Historical evidence is not proof that a later revision passes. Source and tests establish what the implementation does; accepted contracts establish what it is intended to do. Resolve a disagreement explicitly rather than silently promoting a bug or an unimplemented proposal into the contract.

## Maintenance rules

- Give each durable fact one owning document. Other documents link to it instead of copying fields, module inventories or verification logs. User-facing instructions may explain the relevant consequence without duplicating the full API specification.
- Update current knowledge in place with the implementation: terms in the glossary, client semantics in the APIs, responsibilities and consequential rationale in architecture, commands and safe procedures in verification or the root README. Do not append a dated change narrative to those documents.
- Keep approved but unimplemented behavior in active work, not current contracts. Record a proposal's status and confirming source; do not label acceptance examples as executed evidence.
- There is no required ADR directory or document template. Record a decision separately only when it is costly to reverse, surprising without context and involves real alternatives; otherwise keep concise rationale with its owning architecture section. Do not reconstruct historical reasons from speculation.

## Active work

Use `docs/tasks/<bounded-change>.md` only when unfinished work needs a handoff. A self-contained change does not need a task document. A task holds current scope, acceptance criteria, confirmed choices and sources, unresolved questions, verification gaps and the next action; link current contracts rather than copying them. Replace stale state instead of appending rounds of discussion.

At completion, update the owning long-term documents and their links, retain necessary evidence, then remove the completed task. Committed execution history stays in version control. Preserve any unique uncommitted decision or required evidence before removing its only copy. A new requirement starts a new bounded task rather than extending a completed one.

A historical check's limitation or an unperformed deployment does not by itself create a product requirement or authorize operational work. Do not create an empty backlog merely to fill the task directory.

## Evidence retention

Routine test/command results belong in the change or conversation report. Create persistent evidence only for a real handoff, comparison, migration or audit need. Record the claim, revision or known scope, environment, observed result, limitations and retrievable artifacts; do not store a transcript of every command or layout iteration.

Keep non-reconstructible migration observations and meaningful historical validation under `docs/evidence/`, separate from current semantics. Never edit an old result to imply it ran against new code. Historical reports without a pinned revision remain explicitly unpinned; a date is not a substitute for a source revision.

Historical UI images use `docs/ui/` when retained locally and are Git-ignored. Preserve available images. Record missing screenshots and external/temporary paths as unavailable or unverified provenance, not clickable current navigation or proof of recovery. Do not access private keys, backups or live databases merely to tidy documentation.

Before completing a documentation change, check local links and heading anchors, and exercise safe documented commands when their behavior matters. Do not add the documentation cleanup's own execution diary to these records.
