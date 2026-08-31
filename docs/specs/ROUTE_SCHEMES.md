# Route Schemes — Recurring Route Planning & Generation

Status: Draft v3 · Shaped 2026-08-28 · Owner: Product (fares)
Prototype verdicts folded in (v2): Guided stepper wizard (variant A) won; per-day service plans confirmed; Route map preview step added; recurrence = effective from/to + weekly / every 2 weeks / once a month + time-of-day start. Prototypes: `docs/specs/prototypes/` + `components/wastehero/prototypes/scheme-wizard-prototype.tsx`.
v3 (2026-08-30, issue #19 per the #15 decision): **the Route Scheme owns the rules that determine its stops.** Declarative stop matching (FR-16/FR-17) is the default stop selection — the scheme stores a matching rule (waste fractions + optional vehicle type, scoped to its planning area), and generation resolves the eligible containers each run. Explicitly picked container lists (FR-2 step 4, FR-14) remain as the manual, small-scale mode. Generated Routes and their Pickups are derived outputs of the scheme — never manually maintained children.

## Squad Routing

- **Primary**: Compass — owns Route Schemes, route generation, driver/vehicle assignment.
- **Supporting**: Nexus — owns the containers and properties a scheme collects from.

## Problem Statement

Planners can only create routes one at a time for a single date (Quick create or the existing Guided Setup wizard). Recurring service — "collect these containers every Sunday" — exists only as narrative text: scheme recurrence is a free-text field nothing consumes, route→scheme links are display strings, and there is no generation engine. Weekly planning would be repetitive manual work, and the Route Scheme entity cannot fulfil its own module rule ("routes are generated from schemes").

## Success Criteria

- [ ] A planner creates a Route Scheme in a Guided Setup wizard specifying recurrence structurally (e.g. every week on Sunday) — no free-text day entry.
- [ ] Generating a 7-day window creates exactly one Route per service day, each carrying one Pickup per scheme container, visible in Route Studio → Routes.
- [ ] Re-running generation for the same window creates zero duplicate routes (idempotent upsert).
- [ ] Editing a scheme updates only future routes still in Draft/Planned; Ready/Active/Completed/Cancelled routes are never modified.
- [ ] A generated date matching an approved Collection Deviation lands on the replacement date, visibly marked.
- [ ] A generated route's driver/vehicle can be overridden on that route alone, without changing the scheme or sibling routes.

## Solution Overview

Extend Route Scheme creation with the existing Guided Setup wizard pattern (chooser → 5-step stepper). The scheme carries structured recurrence, default vehicle/driver assignment, and an explicitly picked container list. A generation engine expands the scheme into dated Routes + Pickups — manually per window ("Generate routes") or automatically via a per-scheme Plan Ahead toggle (rolling 7 days). Mirrors the two-layer model used across the industry (AMCS Master Routes, CRO permanent routes, real-product WasteHero Plan Ahead/Optimize).

## Detailed Requirements

### Scheme creation — Guided Setup wizard

- **FR-1**: "New route scheme" opens the Quick create vs Guided Setup chooser (same pattern as route creation). Quick create keeps the schema dialog.
- **FR-2**: Guided Setup steps (validated as prototype variant A):
  1. **Scheme & scope** — name, project, planning area, collection calendar.
  2. **Recurrence** — effective **from** and **to** dates (both required, date pickers), frequency (**Every week / Every 2 weeks / Once a month**), service-day toggles Mon–Sun, week rotation (required for Every 2 weeks), planned start time (time input); live preview of the next 8 generated dates.
  3. **Assignment** — contractor (optional), default vehicle, default driver, departure depot, unloading station.
  4. **Containers** — per-day service plans (FR-14): a *Same containers every day / Different per day* toggle; per-day mode shows one tab per selected service day, each with its own picker (project / waste fraction / container-type filters, search, select-all-filtered, picked count).
  5. **Route map** — map preview of the generated routes: one colored route line per **distinct day route** with stop pins — days sharing an identical stop list (the same-all-days default) draw once, labeled with all their days (issue #17) — an All-days/per-day filter, and a legend row per distinct route (days, stop count, fraction mix).
  6. **Review & create** — per-section summary with Edit jump-backs, validation results, create.
- **FR-3**: Recurrence is structured data (day multiselect + frequency select), replacing the free-text `serviceDays` textarea. Frequency vocabulary: `weekly` / `every-2-weeks` / `monthly`, where **Once a month = the first occurrence of each selected weekday in the month**. The scheme form's `biweekly`/`four-week` values are retired; pickup-settings vocabulary aligns to the same set.
- **FR-4**: The date preview derives from frequency + service days + week rotation + effective from/to window, and reflects deviation remaps.
- **FR-14**: **Per-day service plans** — a scheme with several service days may carry a distinct container list per day (e.g. Wed = organic containers, Sun = glass). Generation creates one Route per service day using that day's list; with the toggle off, all days share one list. This answers weekly planning ("every day a different route for a different product") within a single scheme.
- **FR-15**: **Route map preview** — before Review, the wizard renders the scheme's routes on a map: one polyline per distinct day route in a stable day color (identical per-day stop lists fold into a single line, pin set, and legend row labeled with every day they serve — exact copies must never stack and hide each other, issue #17), stop pins (a stop shared between *distinct* routes renders one neutral pin listing its days), day filter, and a legend (days, stops, fractions). The same view is reusable on the scheme detail page.

### Declarative stop matching (issue #19, v3)

- **FR-16**: **Stop selection modes** — a scheme selects its stops either **by rule** (default) or **manually** (the FR-2 step-4 picker). The mode is an explicit flag (`stopSelection`); the scheme stores exactly one source of truth — the rule, or the picked lists — never a merge of both, so it is always decidable why a Pickup exists.
- **FR-17**: **Stop matching rule** — in rule mode the scheme stores, per FR-14 day plan (shared or per service day), a rule of **waste fractions + optional vehicle type**, scoped to the scheme's **planning area** and project. Resolution happens **at generation time** against the live container records (`lib/route-schemes/matching.ts`, the single resolver behind Generate routes, Plan Ahead, the wizard preview, the scheme detail, and validation): a container matches when its planning area equals the scheme's, its project scope overlaps, its status is in service (Available), a fraction intersects the rule, and — when the rule names a vehicle type — its container type is compatible (`CONTAINER_VEHICLE_COMPATIBILITY`). Containers without the needed classification are **excluded with a visible reason**, never silently included. Matched stops are ordered by container name so regeneration is stable; a container newly matching the rule joins the next generation without editing the scheme, and one that stops matching has its still-planned Pickups skipped by the existing FR-9 regeneration cleanup.
- **FR-18**: **Rule preview & zero-match behavior** — the wizard's Containers step previews the rule live (matched count and list, near-miss exclusions with reasons, loud zero-match empty state); the scheme detail shows the same as a "Matched stops" section. At save, a rule matching zero containers is a **blocking** issue (the rule-mode analog of FR-5c); at generation, a zero-match day still plans its route but the preview row carries an explicit warning. Non-blocking validation warnings: a rule vehicle type the default vehicle cannot serve, and an overlap with another rule-mode scheme (same area, intersecting fractions, shared service day, overlapping effective period).
- Containers carry their planning area as master data (`planningAreaId` + "Planning area" fact; the container form links `plan.areas`); out-of-service containers carry none.

### Validation — Draft → Validated

- **FR-5**: Blocking checks at the review step: (a) ≥ 1 service day selected; (b) effective from and to both set, with to ≥ from; (c) every service day has ≥ 1 container (per-day mode names the empty days, e.g. "Pick containers for Wed"); (d) default driver or vehicle is not already the default on another scheme sharing a service day within an overlapping effective period; (e) default driver or vehicle has no **Confirmed** Vehicle Planning allocation whose planned window touches the scheme — overlaps the effective period on a service day, with missing/unparseable windows conservatively treated as touching (issue #11). Any non-Confirmed, non-Released allocation status produces a non-blocking warning. Released allocations never conflict; because the Plan allocation form is append-event, confirm/release/change event records are folded back onto their target allocation (supersession) before checking. An allocation targeting the scheme being validated is exempt (takes effect once a revalidation path supplies the scheme's own id — create flows have none). All pass → scheme created as **Validated**; any fail → **Draft** with named issues on the record.
- **Lifecycle status (issue #25, `docs/new-changes/SPEC.md` area B)**: Draft/Validated/Scheduled are persisted and event-driven (Scheduled = first successful generation, stamped as `submittedValues.lastGeneratedAt`); Effective/Expired are derived at evaluation time by `effectiveSchemeStatus(record, today)` (`lib/route-schemes/lifecycle.ts`), which every display and eligibility surface reads — stale persisted Effective/Expired strings are never trusted. Current warnings render as the live-derived amber **Attention** badge (`schemeAttention`), never as a status value.

### Generation

- **FR-6**: "Generate routes" action on a scheme (table row menu + detail view): pick a window (default: next 7 days), preview the routes to be created (date, weekday, stop count, assignment, deviation notes), confirm.
- **FR-7**: Each generated Route: RC-numbered name, status **Planned**, operating date, typed scheme relation, inherited default driver/vehicle, populated facts (Project, Area, Vehicle, Driver, Depot, Unloading, Time window), and the scheme version pinned at generation time.
- **FR-8**: One **Pickup** per container in that day's service plan (FR-14) per generated route, status Planned, sequenced in picked order, deep-linked to its route, carrying container facts (address, container ID/type, fraction).
- **FR-9**: **Idempotency** — route identity is keyed on (scheme, operating date). Regeneration upserts: refreshes routes still Draft/Planned; skips Ready/Active/Completed/Cancelled untouched. (Explicitly not the existing `Date.now()` ID pattern, which duplicates.)
- **FR-10**: **Deviation remap** — a generated date equal to an approved Collection Deviation's original date (matching scope) generates on the replacement date instead, with a Deviation fact naming the original date and reason.
- **FR-11**: **Plan Ahead** — per-scheme toggle; when on, the next 7 days are generated/refreshed automatically when Route Studio loads, using the same engine and idempotency rules. Applies to schemes in Validated or later, within their effective window.

### Surfacing & override

- **FR-12**: Generated routes appear in the Route Studio → Routes table and open in the existing Route details page; reassigning driver/vehicle there changes that route only (planned vs actual assignment stay distinct).
- **FR-13**: The scheme detail lists its generated routes (upcoming and past) with the last generation timestamp.

## User Experience

Entry: Route Studio → Route Schemes → **New route scheme** → chooser → Guided Setup (left-rail stepper, same shell as the route wizard — prototype variant A won the comparison). The Recurrence step is the heart: effective from/to date pickers, frequency chips (Every week / Every 2 weeks / Once a month), day chips, a time input, and a live "Next dates: Sun 30 Aug · Sun 6 Sep · Sun 13 Sep…" preview (Google-Calendar-style recurrence editing). The Route map step shows each day's route as a colored line with stop pins before the user commits. Generation runs from the schemes table or detail with a confirm-preview dialog.

**Canonical example** — "Central weekly plan": every week on Wednesday and Sunday, effective 28 Aug 2026 → 31 Dec 2026, per-day plans (Wed = 11 organic containers, Sun = 11 glass containers), defaults WH-31 + Freja Holm, start 06:30. Generate next 7 days → two routes (Wed with 11 organic pickups, Sun with 11 glass pickups), status Planned. Re-generate → no duplicates. Reassign Sunday's driver to Mads → scheme, Wednesday, and next Sunday unchanged.

## Cross-Squad Dependencies

- **Nexus (containers/properties)**: the container picker and the stop-match resolver (FR-17) consume container records' project, planning area, waste fraction, container type, property, and in-service status. The container's "Route scheme" fact is an **output** stamped at generation time — never a matching input (the seeded strings dangle and reference non-existent schemes).

## Out of Scope

- VRP / stop-sequence optimization and map routing — stop order = picked order.
- Recurrence via Pickup Settings / Collection Calendars (this slice puts recurrence on the scheme; convergence with the real-product three-layer chain is a follow-up).
- Occurrence-vs-series edit scoping ("this route / this and following / all") beyond per-route override.
- Static dashboard performance rows for generated routes.
- Driver-app execution changes; billing/invoicing (Ledger).
- Full 5-class validation (holiday warnings, week-parity vs pickup settings, master-data integrity tiers). *Vehicle/container-type compatibility arrived with FR-17 (issue #19) as the stop-rule dimension plus a default-vehicle mismatch warning; a general fleet-compatibility validation layer stays out of scope. The week-parity-vs-pickup-settings class arrived with issue #21 (2026-08-31), re-founded on the typed Service frequency home (issue #20): `validateScheme` warns — non-blocking, like calendar warnings — when the scheme's recurrence under- or over-serves a linked container's promised service frequency, compared on a collections-per-week scale (`schemeFrequencyReconciliationWarnings`).*
- Scheme version history UI (version is pinned as a fact only).
- Per-day vehicle/driver assignment — defaults are scheme-level; a day needing a different vehicle type is, for now, a separate scheme (see Open Questions).
- Real geocoding on the Route map — pin positions are illustrative until container records carry coordinates.

## Open Questions

- [ ] Should Plan Ahead run for **Validated** schemes or only **Effective** ones (lifecycle: Draft → Validated → Scheduled → Effective → Expired)?
- [ ] When a scheme is deleted or expires, are its future Draft/Planned routes auto-cancelled?
- [ ] Contractor persona: can a contractor manager create/generate schemes for their scope, or stay read-only like their routes today?
- [ ] When a scheme edit removes a service day, should still-Planned routes on that day be auto-cancelled? (The logic prototype implements yes — walkthrough 2; confirm before it becomes an FR.)
- [ ] Per-day assignment: if one day's fraction needs a different vehicle type (organic sealed vs rear loader), do we extend per-day plans with assignment, or split into separate schemes?

## Research Basis (condensed)

- **Industry consensus (AMCS, Soft-Pak, CRO, CurbWaste, ServiceCore, Routeware)**: recurring definition → generated dated instances; defaults on the template with dispatch-time overrides; batch generation over a rolling window; executed instances immutable; occurrence-vs-series prompts and holiday offsets are table stakes.
- **Real WasteHero (help.wastehero.io / docs.wastehero.io)**: Pickup Setting (rules, no dates) → Collection Calendar (dates) → Route Scheme (vehicle/driver rules) → routes via Plan Ahead (auto) or Optimize (manual per date); stops matched by fraction + vehicle type.
- **Codebase**: all entities exist as modules; Guided Setup wizard + Stepper + StepMode are reusable as-is; `handleGuidedRouteCreate` shows the record-creation recipe; gaps are the missing engine, free-text recurrence, divergent frequency vocab, dangling string links, and non-deterministic IDs.
