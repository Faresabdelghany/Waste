---
status: accepted
date: 2026-09-17
---

# Deterministic generation, separate from optimisation

Generation answers "what work exists on this service date". Optimisation answers "how should that work be executed". The regeneration identity of a Route is its Route Scheme, Collection Group, and service date, and that identity only holds if identical inputs produce identical Routes and Pickups. A solver is non-deterministic, slow, can fail, and needs a distance-matrix service.

We decided that generation is pure TypeScript in the domain package, deterministic, and calls no external service. It writes Routes and Pickups with a stable default order (today: matched containers sorted by name). Optimisation is a separate job over an already generated Route. Its input, the Route's work plus the constraints it runs under (vehicles and their compartments, shift, Unloading Stations), is the Scenario; it calls the optimiser with a Valhalla matrix and produces a Plan, owned by Planning and referencing the Route: a stop sequence, planned Unload visits, Planned Assignments, and estimated metrics. The generated baseline order is never overwritten. A Route has at most one active execution sequence at a time, the baseline or one active Plan, and that sequence is frozen once a Session has started on the Route. Activating a Plan on a Route is not Promotion in the glossary sense.

## Considered options

- Optimise inside generation. Rejected: a Valhalla or solver outage would block planning, and every re-run would reshuffle stops a driver has already seen.

## Consequences

- Scenario and Plan from the glossary get their first concrete use, as the optimisation job's input and output. Two Plans over the same Route can be compared without changing what work was generated.
- Valhalla serves both the optimiser's matrices and the map's display legs.
- The optimiser sits behind one HTTP contract and is replaceable. Which solver fills it is ADR-0006.
