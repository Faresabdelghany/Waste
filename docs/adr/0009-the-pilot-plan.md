---
status: proposed
date: 2026-09-29
---

# The pilot Plan

ADR-0002 separates deterministic generation from optimisation and names the optimiser's input a Scenario and its output a Plan. The pilot has no Scenarios yet, but it needs stored routing results now: real geometry on the route map, a dispatcher's reorder that the next generation run does not undo, and measured distance and duration in place of the web's heuristics. This ADR records the Plan as the pilot stores it (#124, corrected by #132; #39 implements) and states where it expands beyond ADR-0002's "calculated from a Scenario", so no two definitions stand unexplained. ADR-0002 and ADR-0006 stand.

A Plan is one calculation over one dated Route: `plan` (solver, status, fingerprint, trip, totals, deferral, provider provenance), `plan_stop` (the sequence, positions 1..n over the Route's pickups) and `plan_leg` (one `geometry(LineString, 4326)` per consecutive pair, metres and seconds — the system's first stored line strings). The stops and legs are the immutable result, written exactly once — on creation for a known sequence, on `ready` for a solved one — and append-only, ledgers like the proof of service. `route.active_plan_id` names the Route's one active Plan; null means the generated baseline stands unmeasured and is drawn dashed. `pickup.position` stays the baseline and is never overwritten by a Plan; every reader orders by the active Plan when there is one.

Where this expands ADR-0002: a Plan is calculated from inputs recorded on the Plan itself, not from a Scenario, until Scenarios exist. Three solvers order one — `optimiser` (the provider's optimisation, 50 stops or fewer), `manual` (the dispatcher's reorder becomes a Plan, retiring the in-place rewrite of `pickup.position`) and `baseline` (the generated order measured) — where ADR-0002 spoke of the optimiser alone. A `manual` or `baseline` Plan is active from creation and a failed measurement leaves it active, unmeasured and dashed; an `optimiser` Plan activates atomically on `ready`. Staleness is a reading, never a status. The modelled trip is depot → stops → unloading station → depot, one unload and no reload (ADR-0006's contract assumption); a Route missing either end gets a `stops-only` measurement, stored as partial.

Every provider call runs in a pg-boss job through one adapter package, `@waste/routing` — ADR-0006's "optimiser package", server-only, fenced out of the web like the database — behind a provider switch whose CI answer is a deterministic fake (#131: no credential exists on the public repository). No database transaction is ever held open across a provider call. The fingerprint keys idempotency, deduplication and the cache, and carries request inputs only — provider, profile, solver and configuration, coordinates rounded to five decimals (about a metre), every constraint — because the provider reports engine version and graph date only in its response; those land on the Plan as provenance. A request whose fingerprint equals a `ready` Plan of the same Route re-activates it and consumes no call.

## Considered options

- Store the optimised order by rewriting `pickup.position`. Rejected: it is the clobber #124 found on `main` — generation's refresh compares positions and writes the baseline back, undoing the dispatcher.
- Wait for Scenarios before storing any Plan. Rejected: the pilot needs geometry and honest measurements now, and a Plan that records its own inputs loses nothing a later Scenario cannot supersede.
- Key the cache on engine and graph version too. Rejected by #132's correction: they are response-side facts, unknowable before the call they would have to key.

## Consequences

- A Route without a Plan is complete: nothing routing gates dispatch or execution. External routing capacity moves a Plan between measuring, waiting, ready and failed, and never prevents the Route beneath it from running (#132's rule; its budget, deferral and quota surface land with #171 and gain a section here at that review).
- Re-optimisation is a new Plan; comparing two is Scenario-era work.
- Stored geometry is CC-BY-SA 4.0 and every map showing it carries the provider attribution; the key is server-side only.
