# Route Scheme Flow — Decision Log

Decisions from the grilling session (2026-08-31) that shaped `SPEC.md`. Source design:
Artifact "Route Scheme Flow" (6 artboards). Existing behavior specs
(`docs/specs/ROUTE_SCHEMES.md`, `PLAN_SIMPLIFICATION.md`, `REAL_PRODUCT_CONVERGENCE.md`)
remain authoritative for recurrence, validation, and generation mechanics.

## Controlling principle (P0)

**Route Scheme creation must be self-contained.** The Route Scheme is the controlling
planning entity. After the user completes the Guided Setup wizard, the scheme
contains/references all information required for planning: scope, collection calendar,
recurrence, assignment defaults, stop selection, and start time. The system can then
automatically resolve the applicable stops and generate the dated Routes and their Stops
from the scheme configuration alone. **No additional configuration workflow may be
required between scheme creation and normal route generation.**

Every remaining screen/decision is evaluated against this principle. Anything in the
artifact or the existing implementation that contradicts it is flagged in SPEC.md, not
silently preserved.

## Scope & framing

- **D1 (Q1)** — The spec targets **implementation in this prototype** (project-dashboard),
  not a product-only PRD.
- **D2 (Q2)** — SPEC.md is a **self-contained full spec** of the whole flow, with a
  "Changes from current" section per area.
- **D3 (Q3)** — SPEC.md sits **alongside** the existing specs and owns UI/UX and flow.
  Existing domain/behavior specs stay authoritative for recurrence, validation, route
  generation, and prior decisions; nothing is silently overridden.
- **D4 (Q4)** — Deliverables of the session: `docs/new-changes/SPEC.md` and
  `docs/new-changes/DECISIONS.md`. No implementation in the grilling session.

## Screen-level decisions

- **D5 (Q5) — "Attention" is a derived badge, not a status.** The scheme lifecycle
  stays `Draft → Validated → Scheduled → Effective → Expired` (Draft/Validated/Scheduled
  persisted and event-driven; Effective/Expired derived at evaluation time — see D30).
  The amber
  "Attention" pill is a warning/condition overlay shown when the scheme has active
  validation/reconciliation warnings.
- **D6 (Q6) — Collection Calendar becomes a dedicated wizard step (7 steps total)**,
  between "Scheme & scope" and "Recurrence". The step contains the calendar select plus
  read-only info (working days, holidays, validity). The selected calendar participates
  directly in recurrence/next-dates calculation. Requirement: the user must never have to
  leave scheme creation to configure something elsewhere before routes can generate (P0).
  **Clarification:** the Scheme–Calendar relationship already exists (`calendarId` is
  persisted on the scheme; the select currently lives inside Step 1 "Scheme & scope").
  D6 is a wizard restructuring / UX improvement — promote the field to its own step with
  contextual preview — not a new domain capability or relationship.
- **D7 (Q7) — Keep the fortnight anchor control, conditionally.** For "Every 2 weeks"
  the explicit anchor/odd-even configuration stays (per issue #15 decision), shown only
  when that frequency is selected. **"Planned start time" flows into generated routes'
  estimated start**; the field already exists in the Quick Create schema (see Corrections)
  — the change is exposing it in Guided Setup and using it consistently, not introducing
  a new domain field.
- **D8 (Q8) — Scheme detail becomes a dedicated full page** with tabs
  Details · Routes · Stops · Collection Calendar, keeping the `?module=schemes&record=`
  routing contract and reusing the existing prefilled edit flow. **"Generate routes" is a
  manual/regeneration action, not a required completion step** — per P0, a completed
  scheme can generate automatically.
- **D9 (Q9) — Scheme Stops tab shows generated Stops** belonging to the dated Routes
  generated from the scheme, filterable by route/date. Resolved rule matches are never
  persisted or presented as Stops before generation (glossary: the Stop Matching Rule
  stores the rule, never the result). *Amended 2026-09-03*: the route/date filters are
  the Route and Service date categories of the shared Filter popover (see D28ii), not
  standalone selects.
- **D10 (Q10) — Collection Calendar tab is read-only** with an "Open in Plan" link. The
  scheme selects and uses the shared calendar; it never owns or redefines it.
- **D11 (Q11) — Route lifecycle unchanged.** `Draft, Planned, Ready, Active, Completed,
  Cancelled` stay; the artifact's "Planned → Ready → Active → Completed" is the happy
  path only.
- **D12 (Q12) — Plan workspace tabs unchanged**: Collection Deviations · Collection
  Calendars · Areas & Zones (per PLAN_SIMPLIFICATION Q11). *Superseded 2026-09-03:
  Collection Deviations removed; Plan = Collection Calendars · Areas & Zones.* Vehicle Planning already lives
  in Fleet, not Plan, so the artifact's omission of it from Plan matches the implemented
  structure. *(Corrected in the contradiction pass — the original decision text wrongly
  claimed Vehicle Planning stays in Plan.)*
- **D13 (Q13) — Collection Calendars KPI tiles derive from real data**, never the
  artifact's illustrative numbers.
- **D14 (Q14) — Artboard 5 is authoritative for the Route detail Overview layout**
  (stops table `# / Stop / Arrival / Service / Status`, collapsed Map panel, Route
  information panel with ASSIGNMENT + SCHEDULE). The Route information panel additionally
  shows Deviation info when the route's date was moved by an approved Collection
  Deviation.

- **D15 (Q15) — Artboard 1 is authoritative for the Route Schemes list layout**:
  columns `Route scheme (name + description sub-line) | Project · service days | Status |
  Recurrence | Collection calendar`, applied to the shared module so Route Studio and Plan
  stay consistent automatically. The **recurrence summary is derived from the scheme
  configuration at render time, never stored as display data**. The artifact row text
  "Copenhagen Central · By Operations" is a copy/truncation issue — always render the
  actual stored area/project name ("Indre By Operations").
- **D16 (Q16) — Legacy schemes without `plannedStartTime`**: read-time fallback displays
  "—"; never invent a default (no artificial 06:00). The field persists via the normal
  edit-save flow. Routes generated from a scheme with no planned start time carry **no
  estimated start time**.
- **D17 (Q17) — Scheme detail Routes tab** reuses the Routes presentation minus
  scheme-constant columns (Project, Area), structured as
  `Service date | Route ID | Status | Stops | Vehicle | Driver`. Service date is the
  **actual generated route date**, including any move caused by an approved Collection
  Deviation.
  *Amended 2026-09-03 (table/filter parity)*: the tab renders the workspace record
  toolbar (search · shared Filter popover · removable chips) and table styling, with
  filters **Waste fraction · Vehicle · Driver** and a `Waste fraction` column between
  Stops and Vehicle; rows open the route's details page like workspace rows. A route's
  fractions are derived live from the Stops still in its plan (render-time projection,
  never persisted; Stops a regeneration removed are excluded). The Collection Deviation
  clause above is superseded — deviations were removed 2026-09-03; holidays are skipped,
  never moved.

## Generation & creation-path decisions

- **D18 (Q18) — Generate immediately on create + Plan Ahead on by default.** For a
  successfully completed and **Validated** scheme, the normal flow is:
  1. Persist the Route Scheme.
  2. Immediately generate the applicable dated Routes for the initial planning window
     using the existing generation engine.
  3. Resolve and create the Stops/Pickups belonging to each generated Route.
  4. Enable Plan Ahead by default so future Routes continue generating automatically.
  5. Generation stays idempotent — repeating it can never duplicate Routes/Stops.

  `Complete Scheme → Validate → Save → Generate Routes + Stops → Plan Ahead continues.`
  The user finishes the wizard and immediately sees generated Routes/Stops on the scheme
  — no required intermediate action. **Draft schemes (blocking issues) generate nothing**
  until they validate. "Generate routes" remains as an explicit manual /
  regeneration / backfill action, no longer required for normal creation.
  **Clarification:** automatic future generation is conceptually part of the scheme's
  planning behavior, not tied to visiting a UI page. The current page-load Plan Ahead
  runner is documented as technical behavior/debt, not target product behavior.
- **D19 (Q19) — Quick Create is aligned with P0, not removed.** On submit it runs the
  same `validateScheme`, determines Validated vs Draft by the same rules, persists the
  same canonical scheme data, applies D18 generation when valid, and enables Plan Ahead
  by default when generation-ready. Guided Setup and Quick Create are two UX paths to the
  same domain entity and must not produce schemes with different behavioral semantics.
  If Quick Create cannot collect information required for generation, that gap must be
  addressed — never silently create an incomplete scheme.
- **D20 (Q20) — Attention is computed live.** Derived from the scheme's canonical stored
  configuration plus current related data at list/detail render time; validation also
  re-runs on edit-save. Never persisted as a lifecycle status. Fix `scheme-osterbro-b`
  to a legitimate lifecycle status whose warning condition produces the derived
  Attention presentation (its current `"Validation issue"` status string is illegal).
  Persisted warning facts may remain for history/debugging but are **not** the
  authoritative source of current Attention state.
- **D21 (Q21) — "Session" added to CONTEXT.md**: "A driver-app work session on an
  assigned route, tracking the driver's device state, connectivity, queued actions, and
  proof progress from assignment to completion." Lifecycle (documented where
  appropriate): Assigned → Downloaded → Active → On break → Awaiting sync → Completed.
  Never redefined as a Route, Assignment, or Pickup.
- **D22 (Q22) — Customer-scoped calendars are out of scope (non-goal).** No new calendar
  scoping model to reproduce illustrative artifact numbers. KPI tiles use only values
  derivable from the existing Collection Calendar model/store; labels/helper text change
  accordingly (no fake project/customer splits). Real customer-scoped calendars are
  flagged as a future capability (the Collection Deviation `scopeType` pattern once noted
  as a modeling direction was removed with that module on 2026-09-03).
- **D23 (Q23) — `effectiveTo` is optional everywhere** (Guided Setup behavior is
  canonical; Quick Create stops requiring it). An omitted `effectiveTo` means the scheme
  continues per its recurrence/calendar until explicitly ended, expired through later
  configuration, or deactivated by lifecycle rules.

## Cross-cutting rule (P1)

**UI capability may differ between Quick Create and Guided Setup, but domain semantics
may not.** A scheme created through either path must behave identically after creation
when given equivalent configuration (validation, lifecycle, generation, Plan Ahead,
calendar, P0 behavior).

## Generation window, lifecycle, and presentation decisions

- **D24 (Q24) — Initial generation window**: `start = max(today, effectiveFrom)`,
  `end = start + 7 days`. The existing generation engine remains responsible for
  recurrence, service days, Collection Calendar rules, deviations, and idempotency within
  the window. Do not lengthen the window to populate the UI — Plan Ahead maintains
  future coverage.
- **D25 (Q25) — Automatic, system-derived lifecycle transitions**:
  `Draft → Validated → Scheduled → Effective → Expired`.
  Draft = blocking issues exist. Validated = passes validation, generation-ready.
  Scheduled = first route generation completed successfully. Effective = reached
  `effectiveFrom` and operational. Expired = `effectiveTo` exists and has passed.
  Under P0, Validated may be transient (`Create → Validate → Generate → Scheduled`,
  then Effective if `effectiveFrom <= today`). Transitions are deterministic — never
  dependent on a user manually changing statuses. **Generation failure is not successful
  scheduling**: if validation passes but initial generation fails technically, the scheme
  must not transition to Scheduled.
- **D26 (Q26) — Explicit Draft/blocked presentation.** Details tab: prominent validation
  callout listing current blocking issues from live validation, with "Resolve via Edit".
  Routes/Stops tabs: explanatory empty states stating generation is blocked by scheme
  validation. "Generate routes" is disabled while blocking issues exist. Never hidden
  behind an Attention tooltip.
- **D27 (Q27) — Review & create previews the consequence of creation.** For a valid
  scheme: creation will create the scheme, automatically generate initial routes,
  resolve/create their stops, and enable Plan Ahead — showing expected dates/routes and
  approximate stop impact where reliably calculable (estimates labeled as such; no exact
  counts the system cannot guarantee pre-generation). For an invalid configuration:
  "Saved as Draft — Routes will not be generated until the blocking issues are resolved,"
  with the issues listed.
- **D28 (Q28) — Layout adoptions**: (i) Details tab = the artifact's five cards
  (Scheme & scope, Collection calendar, Recurrence, Assignment, Containers & stop rule),
  all values from canonical scheme/related data, never duplicated display-only values;
  (ii) Stops tab columns `Service date / Route | # | Stop | Service | Status` — generated
  stops of generated dated routes per D9 — *amended 2026-09-03 (table/filter parity)*
  to `Service date / Route | # | Container | Container ID | Container type | Status |
  Waste fraction | Driver`, filtered through the shared Filter popover on Container ·
  Container ID · Container type · Status · Waste fraction · Driver · Route · Service
  date (Route and Service date carry D9's route/date filters; the two standalone
  selects are retired). Container is the street line of the Stop's address, falling
  back to its Container ID; Service date is the route's operating date projected onto
  the Stop at render time; rows open the Stop's route details page; (iii) Collection Calendars table adopts
  artboard 6 columns, "Customer · project" renders only context that exists today (D22),
  Holidays / Next holiday derived from `holidayDates` and the current date;
  (iv) the Routes list star/favorite column is dropped (new capability, out of scope).
- **D29 (Q29) — Single-rule Quick Create is acceptable.** Quick Create = optimized path
  for simpler schemes with one matching rule across all service days; Guided Setup = full
  configuration path (per-day rules, manual container selection). No feature parity
  required; both paths obey P1. Do not rebuild Guided Setup inside Quick Create.

- **D30 (Q30) — One canonical `effectiveSchemeStatus(record, today)`**, used everywhere
  scheme status is displayed or evaluated (scheme lists, Scheme Detail, Plan, Route
  Studio, generation eligibility, Plan Ahead eligibility). Persisted, event-driven:
  Draft (blocking issues), Validated (passes validation, no successful generation yet),
  Scheduled (first successful generation occurred). Derived at evaluation/render time:
  Effective (today ≥ effectiveFrom and the scheme reached Scheduled), Expired
  (effectiveTo exists and today > effectiveTo). Never rely on stale persisted
  Effective/Expired values. Attention stays separate from lifecycle status (D20).
- **D31 (Q31) — Edit-save reconciles the future window automatically.**
  `Edit → Validate → Save → Reconcile future planning window`. A valid edit re-runs the
  generation/reconciliation engine for the applicable future window; changes to
  recurrence, service days, calendar, matching rules, containers, planned start time,
  assignment inputs, or effective dates reflect in future Routes/Stops without manual
  Generate routes or waiting for Plan Ahead. Past/Active/Completed/executed routes are
  operational history and are never rewritten. Future not-yet-started routes use
  existing reconciliation semantics: retain/update valid occurrences, create newly
  required ones, cancel no-longer-valid ones. **If an edit makes the scheme Draft**:
  do not silently delete generated future routes — cancel future routes that have not
  started and have no operational execution state, preserving them as records for
  traceability; never cancel Active/Completed/historical routes; Scheme Detail explains
  that future planning stopped because the scheme became invalid. When the scheme
  validates again, normal idempotent reconciliation re-materializes correct future
  routes.
- **D32 (Q32) — Deletion and expiry semantics.**
  *Deletion*: stops Plan Ahead, prevents further generation, cancels future
  not-yet-started routes, preserves past/executed/Active/Completed routes and their
  Stops/Pickups as historical operational records — deletion never erases operational
  history. *Expiry* (today > effectiveTo → derived Expired): stops generation beyond
  effectiveTo, stops Plan Ahead extension, does not retroactively cancel valid routes
  generated for service dates within the effective period, preserves all history. No
  generated route from a scheme may have a service date later than effectiveTo.

## Collection groups (2026-09-03)

Context: the Codex design conversation of 2026-09-03 agreed to replace the scheme-wide
assignment plus the same-all-days container toggle with collection groups; the
deep-research pass (AMCS Master Routing, Salesforce maintenance plans, Jobber, Onfleet,
Dynamics 365 RSO, the DWP "add another thing" pattern) confirmed the shape and softened
two invariants. These decisions record the result.

- **D33 (Q33) — Collection groups are the unit of planning inside a Route Scheme.** A
  scheme carries one or more groups; each has its applicable service days (subset of the
  scheme's, defined once), waste fractions, a vehicle, a default driver, an optional
  service provider, and its stop source (rule, or hand-picked containers). The scheme
  owns one planning area, the calendar, the recurrence, and the service days; groups
  inherit them. Generation writes one route per group per applicable day. Every service
  day has at least one group; the same vehicle, driver, or container is never on two
  groups the same day but may be reused across days. Service action is collection only
  in this phase. Rationale: the real product's Route Scheme is "which vehicle and driver
  combination will use the route" — a collection group maps onto it one to one, and the
  scheme becomes the bundle that carries geography, calendar, and cadence; AMCS's Master
  Route (single weekday, vehicle type, allowed materials, vehicle, default driver,
  transport supplier) is the same granularity.
- **D34 (Q34) — Vehicle required; driver is a default required for Validated, never a
  Next gate.** The vehicle's type drives stop matching, so a group without one cannot
  validate; the driver is the planned default refined per route at dispatch. Both are
  blocking issues (the scheme saves as Draft with them named), not wizard gates —
  saving as Draft is always allowed. Softened from "both mandatory at entry" because no
  surveyed product mandates a driver on the template (AMCS "Default driver", Jobber
  allows unassigned recurring jobs, Onfleet binds drivers at optimization).
- **D35 (Q35) — Tie-breaks between groups on one day.** A hand-picked container always
  beats a rule (an exception carves out of the defaults). Two rule groups matching the
  same containers: the first group in order wins, and validation *warns* naming both
  groups — not a hard error, following AMCS's plan-group first-match-with-reorder rather
  than a block. Hard errors are reserved for explicit collisions: the same vehicle or
  driver on two groups sharing a day, and one container hand-picked into two groups.
  Nothing is silent — the losing group lists the container as excluded with the reason.
- **D36 (Q36) — Storage, identity, and editing.** Explicit groups serialize as JSON under
  `submittedValues.collectionGroups`; a single group covering every service day stores
  as the legacy single-assignment shape, and every scheme without the key resolves to
  implicit groups (one for a shared plan, one per day for per-day plans, named by day
  so validation wording is unchanged). Route identity is `(schemeId, serviceDate)` for
  implicit groups — nothing already generated moves — and `(schemeId, groupId,
  serviceDate)` for explicit groups; splitting a scheme into groups therefore
  re-creates its future routes and cancels the old ones with the resurrection marker
  (edit-save reconciliation, D31). Groups are edited in the wizard step and on the
  scheme page ("Edit collection groups"); the schema edit dialog hides the group-owned
  fields for multi-group schemes instead of showing values the groups would ignore.

## Closing principle (P2)

**The Route Scheme is the source of truth for future planning, while generated Routes
become operational/history records once execution begins.** This single principle
governs creation, editing, expiry, and deletion.

## Corrections from fact-finding

- **Collection Calendar**: `calendarId` already exists on scheme records. The redesign
  moves calendar selection from Step 1 into a dedicated Step 2 with preview/context —
  a UX restructuring, not a new Scheme–Calendar capability (see D6).
- **Planned start time**: the field already exists in the Quick Create schema. The change
  is exposing it in Guided Setup and using it consistently across both creation paths —
  it is not a newly introduced domain field.

## Resolved open items

- **"Sessions"** — resolved by inspection (driver-app device session) and D21; glossary
  entry added to CONTEXT.md.
