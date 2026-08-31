# Route Scheme Flow — Spec

**Source of decisions:** `docs/new-changes/DECISIONS.md` (P0–P2, D1–D32) from the 2026-08-31
grilling session over the "Route Scheme Flow" artifact (6 artboards).
**Relationship to existing specs (D3):** this spec owns UI/UX and flow.
`docs/specs/ROUTE_SCHEMES.md` (RS), `docs/specs/PLAN_SIMPLIFICATION.md` (PS), and
`docs/specs/REAL_PRODUCT_CONVERGENCE.md` (RPC) stay authoritative for recurrence,
validation, and generation *mechanics* — except the specific statements listed in
**Supersessions** (Further Notes), which this spec explicitly overrides per the
contradiction pass. RPC is a decision record, not a behavior spec, and is cited as input
only.

---

## Problem Statement

I am an operations planner. When I finish creating a Route Scheme, the job isn't done:

- After completing the Guided Setup wizard, the scheme exists but **no routes exist**. I
  have to discover a separate "Generate routes" action and separately turn on Plan Ahead,
  or nothing will ever be planned from the scheme I just configured.
- **Quick Create is worse**: it never validates, always lands the scheme in Draft — even
  a fully valid configuration — and forces me to enter an "effective to" date that many
  ongoing schemes simply don't have.
- The **scheme detail is a cramped side sheet**: a flat list of facts with no dedicated
  view of the routes and stops the scheme produced, no view of the calendar it follows,
  and lifecycle statuses I can't trust (one seed scheme carries the illegal status
  "Validation issue"; Effective/Expired can be stale because nothing re-derives them from
  today's date).
- **Warnings are stamped once at save-time** and drift from reality; the list gives no
  live signal that a scheme needs attention.
- When I **edit** a scheme, future routes don't follow the change until I manually
  regenerate or a page-load Plan Ahead run happens to fire; when I delete a scheme it's
  unclear what happens to its operational history.

## Solution

**Route Scheme creation becomes self-contained (P0).** Finishing either creation path —
Guided Setup or Quick Create — produces a scheme that immediately validates, generates
its initial dated Routes and their Stops/Pickups for the first window, and has Plan Ahead
on by default so future routes keep generating. No configuration workflow may be required
between scheme creation and normal route generation.

Around that core:

- Guided Setup grows to **7 steps** with a dedicated **Collection Calendar** step.
- Quick Create runs **the same validation and post-create semantics** (P1) as the wizard
  and stops requiring `effectiveTo`.
- The scheme detail becomes a **full page** with **Details · Routes · Stops · Collection
  Calendar** tabs.
- One canonical **`effectiveSchemeStatus(record, today)`** governs every status display
  and every eligibility check; **Attention** is a live-derived warning badge, never a
  status.
- **Edit-save reconciles the future planning window automatically**; deletion and expiry
  stop future planning while preserving all operational history (P2: the scheme is the
  source of truth for future planning; generated Routes become operational/history
  records once execution begins).

## User Stories

1. As an operations planner, I want completing the Guided Setup wizard to immediately create the scheme *and* its initial routes and stops, so that I never have to hunt for a second "make it real" action (P0, D18).
2. As an operations planner, I want Plan Ahead enabled by default on every generation-ready scheme I create, so that future routes keep appearing without me remembering a toggle (D18).
3. As an operations planner, I want a dedicated Collection Calendar step in the wizard showing the selected calendar's working days, holidays, and validity, so that I understand how the calendar will shape my service dates before I pick recurrence (D6).
4. As an operations planner, I want the recurrence step to show the fortnight anchor (odd/even) control only when I choose "Every 2 weeks", so that the form stays simple for weekly schemes (D7).
5. As an operations planner, I want to set a planned start time on the scheme and see it flow into generated routes' estimated start, so that dispatch sees realistic times (D7).
6. As an operations planner, I want to leave "effective to" empty on any creation path, so that open-ended schemes don't get a fake end date (D23).
7. As an operations planner, I want the Review & create step to tell me exactly what creation will do — scheme created, N routes generated for the coming window with their dates, approximate stop impact, Plan Ahead on — so that I can confirm consequences, not just inputs (D27).
8. As an operations planner, I want an invalid configuration to be saved as Draft with the blocking issues listed and the message that routes will not generate until they're resolved, so that my work isn't lost and I know what to fix (D26, D27).
9. As an operations planner, I want Quick Create to validate my input with the same rules as the wizard and produce a scheme with identical post-create behavior, so that the fast path never yields a second-class scheme (D19, P1).
10. As an operations planner, I want Quick Create as a fast single-rule path and Guided Setup for per-day rules and manual container selection, so that simple schemes stay quick and complex ones stay possible (D29).
11. As an operations planner, I want a scheme whose matching rule matches zero containers to be blocked at save, so that I don't create schemes that plan empty routes by accident (carried from RS FR-18, now applied on both paths).
12. As an operations planner, I want scheme statuses to move automatically — Draft when blocked, Validated when it passes, Scheduled after the first successful generation, Effective once its start date arrives, Expired after its end date — so that status always reflects reality without manual bookkeeping (D25).
13. As an operations planner, I want every list, detail, and eligibility check to show the same derived status, so that a scheme is never "Effective" in one view and stale in another (D30).
14. As an operations planner, I want an amber "Attention" badge computed live from current validation/reconciliation warnings, so that I can spot schemes needing review without the badge being a fake lifecycle state (D5, D20).
15. As an operations planner, I want a Draft scheme's detail page to lead with a callout listing the current blocking issues and a "Resolve via Edit" action, and its Routes/Stops tabs to explain that generation is blocked, so that the path to fixing it is obvious (D26).
16. As an operations planner, I want the scheme detail as a full page with Details, Routes, Stops, and Collection Calendar tabs, so that I can inspect everything the scheme produces in one place (D8).
17. As an operations planner, I want the Details tab organized as five cards — Scheme & scope, Collection calendar, Recurrence, Assignment, Containers & stop rule — reading live canonical data, so that the detail never shows stale display copies (D28i).
18. As an operations planner, I want the Routes tab to list the scheme's generated routes as Service date · Route ID · Status · Stops · Vehicle · Driver, with the *actual* date including approved Collection Deviation moves, so that I see what will really run (D17).
19. As an operations planner, I want the Stops tab to show the generated Stops of the scheme's dated routes, filterable by route and date, so that I can verify what each service day serves (D9, D28ii).
20. As an operations planner, I want the Stops tab to be empty before generation — rule matches are a preview, never presented as Stops — so that I never mistake a rule's current matches for planned work (D9).
21. As an operations planner, I want the Collection Calendar tab to show the shared calendar read-only with an "Open in Plan" link, so that scheme editing never forks or redefines a shared calendar (D10).
22. As an operations planner, I want the schemes list to show name + description, project · service days, status, recurrence, and collection calendar, with the recurrence summary derived at render time, so that the list is scannable and never shows stale stored display text (D15).
23. As an operations planner, I want editing a valid scheme to automatically reconcile the future planning window — update, create, and cancel future not-started routes as needed — so that my change takes effect without a manual regenerate (D31).
24. As an operations planner, I want an edit that invalidates the scheme to cancel (not delete) its future not-started routes and the detail page to explain that future planning stopped, so that traceability is preserved and recovery is understood (D31).
25. As an operations planner, I want a scheme that becomes valid again to re-materialize its correct future routes idempotently, so that a temporary misconfiguration doesn't permanently lose planned work (D31).
26. As a dispatcher, I want routes that are Ready, Active, Completed, or operationally Cancelled to never be rewritten by scheme edits or regeneration, so that execution records stay trustworthy (D31, P2; RS FR-9).
27. As a dispatcher, I want my per-route vehicle/driver overrides preserved across regeneration, so that reconciliation never undoes operational decisions (existing engine behavior, kept).
28. As an operations planner, I want deleting a scheme to stop Plan Ahead and future generation and cancel future not-started routes while preserving all executed history, so that deletion is safe and auditable (D32).
29. As an operations planner, I want an expired scheme to stop generating beyond its end date without retroactively cancelling valid routes inside its effective period, so that expiry is a boundary, not an eraser (D32).
30. As an operations planner, I want "Generate routes" to remain available as an explicit manual/backfill/regeneration action, so that I can extend or repair windows on demand — it's just never *required* for normal creation (D8, D18).
31. As a dispatcher, I want the route detail Overview to show the stops table (# / Stop / Arrival / Service / Status), a collapsible map, and a Route information panel with Assignment and Schedule sections, so that a route is readable at a glance (D14).
32. As a dispatcher, I want the Route information panel to show deviation info whenever the route's date was moved by an approved Collection Deviation, so that "why is this route on Thursday?" answers itself (D14).
33. As an operations manager, I want the Collection Calendars list KPI tiles computed from real calendar data (statuses, holiday dates, validity), so that dashboards never show invented numbers (D13, D22, D28iii).
34. As an operations manager, I want the Collection Calendars table to adopt the redesigned columns with holidays and next-holiday derived from each calendar's holiday dates and today, so that calendar health is visible in the list (D28iii).
35. As a contractor manager, I want scheme statuses and generated routes shown in my scoped views to use the same canonical derived status, so that my read-only picture matches operations' (D30).
36. As an operations planner, I want fixture/demo schemes to carry only legal lifecycle statuses (with warning conditions expressed as derivable Attention), so that the demo teaches the real model (D20).

## Implementation Decisions

Organized per area; each ends with **Changes from current**.

### A. Creation orchestration — the new lifecycle seam (P0, D18, D24, D25)

- A new **scheme lifecycle module** joins the route-schemes domain library as the single
  orchestration seam. It exposes pure functions; UI submit handlers only apply the
  returned record upserts to the business record store. Both creation paths, edit-save,
  deletion, and the manual Generate action call through it (this is what enforces P1 by
  construction).
- Interface (names indicative): `effectiveSchemeStatus(record, today)`,
  `schemeAttention(record, relatedRecords)`, `planSchemeCreation(input, related)`,
  `planSchemeEditReconciliation(before, after, related)`, `planSchemeDeletion(record,
  related)` — each planner returns the scheme record plus the route/pickup upserts and a
  human-readable summary for toasts/preview. It composes the existing `validateScheme`,
  `planSchemeGeneration`/`applySchemeGeneration`, and Plan Ahead helpers; it does not
  duplicate their logic.
- **Create flow (D18):** persist scheme → if Validated, immediately generate the initial
  window → create the Stops/Pickups of each generated route → set `planAhead` on by
  default → status becomes Scheduled (and displays as Effective when `effectiveFrom ≤
  today`). Draft schemes generate nothing.
- **Initial window (D24):** `start = max(today, effectiveFrom)`, `end = start + 7 days`.
  Never lengthen the window to populate the UI; Plan Ahead maintains future coverage.
- **Generation success vs failure (D25):** a technically successful generation that
  creates zero routes (e.g. all dates are holidays or a zero-match day) **still counts as
  successful scheduling** — the scheme transitions to Scheduled. Only a technical failure
  of the generation run leaves the scheme in Validated.
- Generation stays **decoupled from Vehicle Planning** (PS): auto-generate-on-create and
  reconciliation never read planned allocations; generated routes inherit scheme
  defaults, and dispatcher overrides stay preserved on refresh.
- The **page-load Plan Ahead runner remains as the technical trigger** in this prototype
  and is documented as debt: automatic future generation is conceptually a property of
  the scheme, not of visiting a page (D18 clarification).

**Changes from current:** today Guided Setup only persists the scheme (status from
validation) — no generation, no Plan Ahead flag; Quick Create persists a raw Draft. The
`planAhead` submitted value is currently written only by the Plan Ahead toggle action;
after this change creation writes it (true) for generation-ready schemes.

### B. Lifecycle status and Attention (D5, D20, D25, D30)

- **One canonical `effectiveSchemeStatus(record, today)`** used everywhere scheme status
  is displayed or evaluated: scheme lists, Scheme Detail, Plan, Route Studio, generation
  eligibility, Plan Ahead eligibility. Persisted, event-driven: **Draft** (blocking
  issues), **Validated** (passes validation, no successful generation yet), **Scheduled**
  (first successful generation occurred). Derived at evaluation time: **Effective**
  (reached Scheduled and `today ≥ effectiveFrom`), **Expired** (`effectiveTo` exists and
  `today > effectiveTo`). Stale persisted Effective/Expired values are never trusted.
- The existing generation-eligibility predicate (`schemeCanGenerateRoutes`) is subsumed
  by / re-expressed through `effectiveSchemeStatus`; the Plan Ahead status allowlist
  reads the derived status.
- **Attention (D5, D20)** is a derived amber badge shown when live validation /
  reconciliation warnings exist — computed from canonical stored configuration plus
  current related data at render time; validation also re-runs on edit-save. It is never
  a lifecycle status. Persisted "Validation warnings" facts may remain for
  history/debugging but are not the authoritative source.
- **Fixture correction:** the seeded scheme currently carrying status `"Validation
  issue"` gets a legitimate lifecycle status whose configuration produces the derived
  Attention presentation instead. Seed fixtures that should present as
  Scheduled/Effective must carry whatever persisted marker the status derivation needs
  (e.g. a recorded successful generation), so fixtures can express legal post-generation
  states.

**Changes from current:** no derived-status helper exists today; status is a raw stored
string written at create/transition. Warnings are stamped once at create as facts and
never recomputed.

### C. Guided Setup wizard (D6, D7, D27)

- **7 steps:** 1 Scheme & scope · 2 **Collection Calendar** (new dedicated step) ·
  3 Recurrence · 4 Assignment · 5 Containers · 6 Route map · 7 Review & create.
- Step 2 contains the calendar select (moved out of step 1) plus read-only context:
  working days, holiday dates, validity period, status. The selected calendar
  participates directly in the recurrence/next-dates preview. This is a wizard
  restructuring — the Scheme–Calendar relationship (`calendarId`) already exists.
- Step 3 keeps effective from (required) / effective to (**optional**, D23), frequency,
  service days, and shows the fortnight anchor (odd/even rotation) control **only when
  "Every 2 weeks" is selected** (D7). **Planned start time** is exposed here (already in
  the Quick Create schema; wizard already defaults it) and flows into generated routes'
  estimated start.
- Step 7 (D27) previews the **consequence of creation**: for a valid scheme — "creates
  the scheme, generates routes for ⟨dates⟩, resolves their stops (~N, labeled as an
  estimate where exact counts aren't guaranteed pre-generation), and turns on Plan
  Ahead". For an invalid one — "Saved as Draft — routes will not be generated until the
  blocking issues are resolved", with the issues listed. Validation continues to run live
  in the review step.

**Changes from current:** today 6 steps with the calendar select buried in step 1;
review shows validation outcome but not generation consequences; `effectiveTo` treated as
required by validation.

### D. Quick Create (D19, D23, D29, P1)

- On submit, Quick Create runs the **same `validateScheme`**, determines Validated vs
  Draft by the same rules, persists the same canonical scheme data (including normalized
  facts), and applies the creation orchestration (generation + Plan Ahead) when valid.
- `effectiveTo` becomes **optional** in the Quick Create schema (D23). An omitted
  `effectiveTo` means the scheme continues per its recurrence/calendar until explicitly
  ended or expired through later configuration.
- Quick Create stays a **single-rule path** (one matching rule across all service days);
  per-day rules and manual container selection remain Guided Setup capabilities (D29). No
  feature parity is required — only identical domain semantics for equivalent
  configuration (P1). Blocking rules (zero-match rule, missing required fields) apply on
  this path exactly as in the wizard.

**Changes from current:** today Quick Create never validates, always creates status
Draft, requires `effectiveTo`, and never generates or enables Plan Ahead.

### E. Scheme detail — full page with tabs (D8, D9, D10, D26, D28)

- The scheme record view becomes a **dedicated full page** (like the existing route
  detail page), keeping the `?module=schemes&record=` routing contract and reusing the
  existing prefilled edit flow. Four tabs:
  - **Details** — five cards: Scheme & scope, Collection calendar, Recurrence,
    Assignment, Containers & stop rule; every value read from canonical scheme/related
    data at render time (D28i). For Draft schemes, a prominent validation callout lists
    current blocking issues from live validation with "Resolve via Edit" (D26).
  - **Routes** — the scheme's generated routes: `Service date | Route ID | Status |
    Stops | Vehicle | Driver`; service date is the actual generated route date including
    approved Collection Deviation moves (D17). Scheme-constant columns (Project, Area)
    are omitted.
  - **Stops** — generated Stops of the generated dated routes, columns `Service date /
    Route | # | Stop | Service | Status`, filterable by route/date (D9, D28ii). Rule
    matches are never presented here pre-generation.
  - **Collection Calendar** — read-only view of the selected shared calendar with an
    "Open in Plan" link; the scheme never owns or redefines it (D10).
- Draft schemes: Routes/Stops tabs show explanatory empty states ("generation is blocked
  by scheme validation"); **"Generate routes" is disabled** while blocking issues exist
  (D26). For valid schemes it remains available as a manual/regeneration/backfill action
  (D8, D18).
- "Turn on/off Plan Ahead" remains available; new schemes arrive with it on (D18).

**Changes from current:** today the scheme detail is a generic side sheet — flat facts
list, stop-matching/map/generated-routes sections, lifecycle chip rail — with no tabs and
no blocked-state explanation.

### F. Schemes list (D15)

- Columns: `Route scheme (name + description sub-line) | Project · service days |
  Status | Recurrence | Collection calendar`, applied to the shared module definition so
  Route Studio and Plan render identically.
- The recurrence summary is **derived from scheme configuration at render time**, never
  stored as display data. Row context always renders the actual stored area/project name
  (the artifact's truncated "Copenhagen Central · By Operations" is a copy bug).
- Status column uses `effectiveSchemeStatus`; Attention renders as an overlay badge, not
  a status value.

**Changes from current:** list renders generic module columns from stored facts today;
no derived recurrence summary; status is the raw stored string.

### G. Edit-save reconciliation (D31)

- `Edit → Validate → Save → Reconcile future planning window`, through the lifecycle
  seam. A valid edit re-runs generation/reconciliation for the applicable future window:
  changes to recurrence, service days, calendar, matching rules, containers, planned
  start time, assignment inputs, or effective dates reflect in future Routes/Stops
  without manual Generate routes and without waiting for Plan Ahead.
- **Touchability rule:** reconciliation may modify only routes in the refreshable
  statuses (Draft, Planned) — this is the concrete meaning of D31's "not started and no
  operational execution state". Ready, Active, Completed, and operationally Cancelled
  routes are never rewritten (keeps the existing engine invariant).
- **Edit → Draft:** future refreshable routes are **cancelled, never deleted**, marked
  with the generation-authored cancel marker (`cancelledByGeneration`) so they remain
  resurrectable; the scheme detail explains that future planning stopped because the
  scheme became invalid. When the scheme validates again, normal idempotent
  reconciliation re-materializes correct future routes — which only works because the
  cancels carry the marker (operationally cancelled routes are never resurrected).
- **Revalidation must pass the scheme's own id** into validation so the self-allocation
  exemption applies — otherwise a scheme with its own Confirmed Vehicle Planning
  allocation would flip to Draft on every save and cancel its own future routes.
- Window bounds: reconciliation and unserved-date cleanup stay bounded by the existing
  walked-range/367-day cap semantics; an over-long window can never cancel still-served
  routes past the truncation point.

**Changes from current:** today an edit changes only the scheme record; future routes
drift until manual regeneration or the next Plan Ahead page-load run.

### H. Deletion and expiry (D32, P2)

- **Deletion:** stops Plan Ahead, prevents further generation, cancels future
  refreshable routes (marked as generation-authored cancels), and preserves
  past/executed/Active/Completed routes and their Stops/Pickups as historical operational
  records. Deletion never erases operational history.
- **Expiry** (derived: `today > effectiveTo`): stops generation beyond `effectiveTo`,
  stops Plan Ahead extension, does not retroactively cancel valid routes generated for
  service dates within the effective period. No generated route from a scheme may have a
  service date later than `effectiveTo`; with no `effectiveTo` the generation-window /
  walk-cap bounds apply.

**Changes from current:** deletion today just removes the scheme record; generated
routes are left dangling with no cancellation or explanation.

### I. Route lifecycle and route detail (D11, D14)

- Route lifecycle **unchanged**: `Draft, Planned, Ready, Active, Completed, Cancelled`
  (the artifact's Planned → Ready → Active → Completed is the happy path only).
- Route detail Overview adopts the artifact layout: stops table `# / Stop / Arrival /
  Service / Status`, collapsed/collapsible Map panel, Route information panel with
  ASSIGNMENT + SCHEDULE sections. The panel shows **Deviation info whenever the route's
  date was moved by an approved Collection Deviation** — including for any route
  presentation path that currently omits the deviation row.
- Deviation precedence rules are unchanged and carried: an approved deviation outranks
  calendar filtering; holidays are skipped, never auto-moved; deviation matching uses
  most-specific scope then name order.

**Changes from current:** route detail already exists as a full page with the
Assignment/Schedule panel; the change is layout alignment to the artifact and closing the
gap where non-generated/fixture route presentations render no deviation row.

### J. Collection Calendars surfaces and Plan workspace (D12, D13, D22, D28iii)

- Plan workspace tabs **unchanged**: Collection Deviations · Collection Calendars ·
  Areas & Zones. Vehicle Planning lives in Fleet (the artifact's omission is correct).
- Collection Calendars list adopts the artboard's table columns, with two constraints:
  "Customer · project" renders **only context that exists in the current model** (no
  fake customer splits, D22); Holidays / Next holiday are derived from each calendar's
  `holidayDates` and today's date.
- KPI tiles above the calendars list derive from real calendar records (statuses,
  holiday dates, validity windows) — never the artifact's illustrative numbers (D13).
  Labels/helper text adjust to what is actually derivable.

**Changes from current:** module KPI `metrics` are currently declared as static fixture
numbers and never rendered anywhere; this area introduces the first rendered, derived
KPI tiles for calendars. The calendars table currently renders generic module columns.

### K. Documentation and glossary updates

- `CONTEXT.md`: fix **Collection Calendar** to scope it to what the model supports (a
  project-scoped shared calendar; customer/service scoping is a flagged future
  capability, D22). Add a **Stop** entry: *a Stop is the route-line presentation of a
  Pickup — one position (#) within a dated Route; Pickup remains the persisted record*
  (this resolves the Stop-vs-Pickup ambiguity: "Stops/Pickups" are one entity, two
  vocabularies — table/UI says Stop, the record store says Pickup). Update **Route
  Scheme** to include assignment defaults and planned start time and to note
  `effectiveTo` is optional; note the P2 route/history duality under **Route**.
- RS open questions closed by decisions: Plan Ahead eligibility (Validated or later,
  FR-11 wording wins), edit-removes-service-day auto-cancel (yes, generalized by D31),
  delete/expiry route handling (D32).
- The superseded statements in RS/PS (see Further Notes) get inline edit-markers pointing
  at this spec, so no document silently disagrees.

## Testing Decisions

- **What makes a good test here:** feed records in, assert records/plans out. Harness
  checks exercise only exported pure functions — given scheme/route/pickup/calendar
  records and a `today`, assert the returned statuses, plans, upserts, and summaries.
  Never assert internal helpers, intermediate state, or UI structure.
- **Convention:** the existing `check(name, actual, expected)` harness pattern under
  `scripts/`, run via `npx tsx` (444 checks across 12 harnesses currently pass; the
  route-scheme family alone is 336). No test framework is introduced.
- **New seam, new harness:** one `route-scheme-lifecycle-harness` covering
  `effectiveSchemeStatus` (all five statuses, derived Effective/Expired against varying
  `today`, stale-persisted-status distrust), Attention derivation, creation orchestration
  (Validated → generate + Plan Ahead on; Draft → nothing; zero-route success →
  Scheduled; technical failure → stays Validated), edit reconciliation (touchability,
  Draft-transition cancellation with resurrection marker, self-id exemption,
  re-materialization on revalidate), and deletion/expiry semantics.
- **Extended existing harnesses:** validation harness for optional `effectiveTo` and the
  Quick Create parity rules; generation harness for window `max(today, effectiveFrom) +
  7d` and expiry bounds; plan-ahead harness for the derived-status allowlist.
- **Prior art:** the generation harness's reconciliation cases
  (create/refresh/skip/cancel/resurrect) and the plan-ahead harness's eligibility cases
  are the closest models for the new lifecycle checks.
- **UI verification:** wizard restructuring, full-page detail tabs, list columns, KPI
  tiles, and empty/blocked states are verified by browser E2E passes with screenshots
  (the established issue-18-style flow), not by harnesses. Type-checking via
  `npx tsc --noEmit` remains mandatory (the build ignores type errors).

## Out of Scope

- **Customer- or service-scoped Collection Calendars** (D22) — flagged future
  capability; the Collection Deviation `scopeType` pattern is a noted modeling direction
  only.
- **Route favorites/star column** from the artifact's routes list (D28iv).
- Occurrence-scoped edit prompts ("this route / this and following / all") — edits
  silently reconcile the whole future window; per-route overrides remain the only
  occurrence-level mechanism.
- VRP / stop-sequence optimization ("Optimize"); Plan Ahead remains the rolling-window
  generator.
- A real background scheduler for Plan Ahead — the page-load runner stays, documented as
  debt (D18 clarification).
- Calendar creation/editing from within the scheme flow (the calendar tab is read-only,
  D10).
- Backend/persistence beyond the existing localStorage record store; auth; driver-app
  changes ("Session" was resolved as glossary-only, D21).

## Further Notes

### Supersessions (from the contradiction pass)

This spec explicitly supersedes these statements; each gets an edit-marker in place:

1. **RS §Solution Overview / §UX / canonical example** — generation as a strictly
   manual-or-Plan-Ahead act. Superseded by D18: generation on create is the primary
   trigger; "Generate routes" is manual/backfill.
2. **RS FR-11** — "generated/refreshed automatically when Route Studio loads" as target
   behavior. The page-load trigger is documented debt; Plan Ahead default flips to ON at
   creation for generation-ready schemes.
3. **RS FR-2 step 2 + FR-5(b)** — `effectiveTo` required. Superseded by D23 (optional
   everywhere; validation only enforces `to ≥ from` when present).
4. **RS FR-5 "at the review step" / FR-1 "keeps the schema dialog"** — validation bound
   to the wizard. Superseded by D19/P1: both paths validate.
5. **RS Success Criteria "updates only future routes still in Draft/Planned … never
   modified"** — kept in substance; clarified that generation-authored *cancellation* of
   Draft/Planned routes (with resurrection marker) is part of reconciliation, and
   Cancelled-with-marker routes are resurrectable (already PS engine law).
6. **PS §4 "warnings … stored as a Validation warnings fact"** — the fact becomes
   history/debug only; live derivation is authoritative (D20).
7. **RPC delta-7 / concept-map rows** describing the two-trigger materialization model —
   historical description; RPC is input-only per its own scope statement.
8. **CONTEXT.md "Collection Calendar … for a project, customer, or service"** —
   corrected per D22.

### Binding invariants carried (must not regress)

- Route identity `(schemeId, serviceDate)`; deterministic ids/names; `serviceDate` is
  never rewritten — deviation moves live in `actualDate` only.
- Generation-authored cancels carry `cancelledByGeneration` and are the only
  resurrectable cancels.
- 367-day walk cap; unserved-date cleanup bounded by the walked range.
- Deviation precedence: approved deviations outrank calendar filtering; holidays skip,
  never auto-move; scheme-scope-first, then name-order tie-break; `scheme` scope means
  exact scheme id, no project fallback; `calendarId` gates deviation applicability.
- Generation/reconciliation never reads Vehicle Planning allocations; dispatcher
  vehicle/driver overrides survive refresh.
- Timezone is display-only; all generation math is day-granular ISO dates;
  `plannedStartTime` participates in no date math. Legacy schemes without
  `plannedStartTime` display "—" and their generated routes carry **no** estimated start
  (D16) — the current hard-coded 06:00 fallback in generation is removed.
- Manual mode persists container ids; rule mode persists only the rule (`stopSelection`
  is the single source of truth; never both).

### Sequencing note

The lifecycle seam (area A/B) is the foundation; creation-path changes (C/D), detail
page (E), and reconciliation (G/H) build on it. List/KPI/detail-layout work (F, I, J) is
independent and parallelizable. Documentation (K) lands with whichever area touches the
statement being corrected.
