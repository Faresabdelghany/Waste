---
status: accepted
date: 2026-09-17
---

# PyVRP optimisation sidecar

Optimisation (ADR-0002) must understand that a vehicle regains capacity after an Unload at an Unloading Station, and that capacity is per waste fraction because trucks have compartments. The open question was whether a real Route ever empties one compartment at a fraction-specific facility and continues collecting with the others still loaded. If it does, the solver must model a per-fraction partial unload; if not, a full reload is enough.

Research on 2026-09-17 found that pattern absent in practice and in the literature. Danish sector guidance says a two-chamber truck should unload both chambers at one transfer site, for load balance and transport cost, and notes that on undivided tailgates the second chamber spills when the first is emptied. Operators describe unloading one chamber at a time at one co-located site; where two facilities are used, it happens in sequence at the end of a trip, never with collection resumed in between. Swedish operators call even end-of-trip multi-site unloading a logistics burden. No multi-compartment routing paper with intermediate facilities models fraction-specific unloading with continued collection. Confidence is moderate to high for Denmark and Sweden, low for the UK and the Netherlands, where no primary text was obtained.

On the solver side, PyVRP's reload empties every dimension by construction, refuses negative loads, and has no roadmap item for per-dimension reloads. OR-Tools and Timefold can express a per-fraction unload through their documented reload patterns, and Google's Route Optimization API can through shipments with alternative deliveries. HERE, PTV, and NextBillion reset all dimensions.

We decided that PyVRP runs as a Python sidecar behind the single optimisation HTTP contract from ADR-0002. The contract models an Unloading Station visit as emptying the vehicle. A trip that unloads at two facilities in sequence is modelled as one composite unloading visit whose duration and distance include the leg between them. If a customer's operation ever requires collection to continue between fraction-specific unloads, the contract stays and the implementation behind it changes to OR-Tools; the domain model is not bent to fit PyVRP.

## Characterization problem

The spike that verified PyVRP 0.14.0 becomes the optimiser package's characterization test. One truck, capacity General 100 and Organic 60, shift 480 to 960 minutes. Depot at (0,0). Unloading Station at (6,4), 15 minutes service. Stops with pickups: A (2,1) General 40; B (4,3) Organic 30; C (7,1) General 50; D (9,5) Organic 40; E (3,6) General 30; 10 minutes service each. Distances and durations are Euclidean times ten, rounded. Expected: with the station, one reload and zero excess in both dimensions. Without the station, infeasible with excess exactly General 20 and Organic 10. With capacity doubled, no reload and a lower cost than the reload solution.

## Considered options

- VROOM: no reload concept.
- OR-Tools: per-dimension unload nodes through the documented reload pattern. The fallback if partial unloading becomes a requirement.
- Timefold Solver: custom Java constraints can model anything, including per-fraction unloads. Heavier to own.
- Hosted APIs (PTV, HERE, NextBillion): full reloads, pay per use, no infrastructure. Google Route Optimization API: fraction-specific facilities via shipments, no reload concept.

## Consequences

- The only non-TypeScript component in the system, isolated behind the contract from ADR-0002 and replaceable without touching Planning.
- Unload stays a per-facility event in the glossary. The optimiser's "vehicle empties here" is a contract assumption, recorded here, not a domain rule.
