# Docs

Documentation for the Waste prototype and the backend being designed around it. This folder stays small and current. Other than this index, if a file here is not one of the kinds listed below, it does not belong.

## What lives here

- `adr/` — Architecture Decision Records. One decision per numbered file, a few paragraphs at most, status in frontmatter. An accepted ADR is never rewritten; a later ADR supersedes it.
- `architecture/backend-architecture.md` — the single living description of the target architecture. Updated in place whenever an ADR changes it.

The domain glossary is `CONTEXT.md` at the repository root, not here. Every term in these documents follows it exactly.

## What does not live here

- Agent work logs, test-harness reports, research dumps, or per-feature specs. Those were removed on 2026-09-03 and stay out. Feature design lives on the issue; only a decision that outlives the feature becomes an ADR.
- Anything derivable from the code or git history.

## Rules

- An ADR needs all three: hard to reverse, surprising without context, and the result of a real trade-off. Otherwise do not write one.
- Statuses: `proposed`, `accepted`, `deferred`, `deprecated`, `superseded by ADR-NNNN`. A deferred ADR stands as the target but is not applied yet; the ADR that defers it says why and until when.
- Dates are absolute, `YYYY-MM-DD`.
- The index below stays in sync: one line per file.

## Index

- [Backend architecture](architecture/backend-architecture.md) — bounded contexts, invariants, deployment shape, stack, data model rules, build order, external deadlines, sources
- [ADR-0001 Single domain data path](adr/0001-single-domain-data-path.md) — accepted
- [ADR-0002 Deterministic generation, separate optimisation](adr/0002-deterministic-generation-separate-from-optimisation.md) — accepted
- [ADR-0003 Container lifecycle consistency](adr/0003-container-lifecycle-consistency.md) — accepted
- [ADR-0004 Offline execution](adr/0004-offline-execution.md) — accepted
- [ADR-0005 Effective dating and temporal integrity](adr/0005-effective-dating.md) — accepted
- [ADR-0006 PyVRP optimisation sidecar](adr/0006-pyvrp-optimisation-sidecar.md) — accepted
- [ADR-0007 Hosting the API, the worker and Valhalla](adr/0007-hosting-api-worker-valhalla.md) — deferred (ADR-0008)
- [ADR-0008 Zero-cost hosting for the Pilot](adr/0008-zero-cost-hosting-for-the-pilot.md) — proposed
- [ADR-0009 The pilot Plan](adr/0009-the-pilot-plan.md) — proposed
