# Real-Product Convergence — Scheme-Owned Recurrence vs the Three-Layer Chain

Status: Decision-support draft · 2026-08-30 · Owner: Product (fares) · Issue: [#15](https://github.com/Faresabdelghany/Waste/issues/15) · Updated same day with public-source research (`docs/research/PICKUP_SETTING_CHAIN.md`) answering open questions 1–5

Scope: **documentation only, this repo only** (PLAN_SIMPLIFICATION.md Q1). This document supports a product decision; it prescribes no implementation work — any codebase change, prototype or real product, is a separate decision and ticket for which this document is input only — and nothing in it targets the real WasteHero repositories. It covers follow-ups 5 (carried over from `docs/specs/ROUTE_SCHEMES.md`) and 6 (from locked decision Q9) of `docs/specs/PLAN_SIMPLIFICATION.md`.

## Why this exists

The prototype puts recurrence, service days, and week rotation directly on the Route Scheme. The real WasteHero product uses a three-layer chain — Pickup Setting (rules) → Collection Calendar (dates) → Route Scheme (vehicle/driver rules). ROUTE_SCHEMES.md declared this divergence deliberately ("this slice puts recurrence on the scheme; convergence with the real-product three-layer chain is a follow-up", Out of Scope) and PLAN_SIMPLIFICATION.md follow-up 5 kept the decision pending. This document lays out the two models as recorded in this repo, the concrete deltas, a proposed mapping, and a recommendation — so the decision can be made rather than re-derived.

## The two models on record

### Real product (as recorded in this repo)

The repo's only full routing-chain description of the real product is ROUTE_SCHEMES.md §Research Basis, sourced from help.wastehero.io / docs.wastehero.io (PLAN_SIMPLIFICATION.md follow-up 5 repeats it in abbreviated form):

> Pickup Setting (rules, no dates) → Collection Calendar (dates) → Route Scheme (vehicle/driver rules) → routes via Plan Ahead (auto) or Optimize (manual per date); stops matched by fraction + vehicle type.

- **Pickup Setting** — the recurrence *rules*, carrying no dates.
- **Collection Calendar** — turns rules into *dates*.
- **Route Scheme** — *vehicle/driver rules* only.
- Dated routes materialize via **Plan Ahead** (automatic) or **Optimize** (manual per date); stops are matched **declaratively by waste fraction + vehicle type**, not picked by hand.

The dev-app research (`docs/research/PRODUCTS_AND_PRICES.md`, live exploration 2026-08-19) adds a second, independent role: in the real product **"Pickup Setting" is also Asset-management master data** — a system-required attribute on container product templates, a product-table column, an xlsx import column, and an optional best-match pricing condition on price rows. Billing frequency is a separate field.

### Real product (refined by 2026-08-30 public-source research)

`docs/research/PICKUP_SETTING_CHAIN.md` (help.wastehero.io + docs.wastehero.io API schemas, no app login) corrects and extends the recorded chain — **it is four layers, not three**:

1. **Pickup Setting** — reusable, project-scoped frequency rules, no dates: collections per week + "weeks between" (any N — every-3/4-weeks is native) or "days between". **There is no monthly frequency** in the public model. The API object also carries time windows, an `exclude_days` skip list, a minimum-gap constraint, and a `first_collection` anchor.
2. **Collection Calendar** — the weekday pattern + anchor (start **week-of-year** + start date) inside a pickup setting; Regular or Combined (seasonal, non-overlapping periods). **Fortnightly cadence is anchor-based** — no odd/even parity toggle is documented anywhere public.
3. **Collection Calendar Days** — the layer the repo's recorded chain omitted: **materialized, first-class, editable date records**, bulk-generated ("Generate Dates" to a period end) or manually added. Holiday handling is documented as *manually editing these dates*; no automatic skip/offset rule is public.
4. **Routes** — Plan Ahead (batch horizon: "7 days or two weeks ahead (or anything else you can imagine)") or Optimize (scheme three-dot menu → one date → one route) consume the Days; the scheme itself holds vehicle/driver rules + collection mode (collect vs replace); stops auto-fill by waste fraction + vehicle type with unrestricted post-generation editing.

The research also settled the two-roles question: **one record.** The same Pickup Setting is the parent of Collection Calendars (routing), is selected on containers at creation, and is a *required* field on container prices (`ContainerPrice.pickup_setting`). And the real product **has a "Collection Deviations" settings tab of its own** ("Add, edit, or delete exceptions to regular schedules") — publicly documented in only two lines, record shape unknown. The customer-promise side: the **agreement carries no frequency field** (API: id, container, quantity, start/end, property) — it *displays* the pickup scheme/calendar inherited via product → container; citizen collection notifications are per container.

### Prototype (authoritative model)

Per PLAN_SIMPLIFICATION.md §Product model (authoritative), shipped and harness-guarded:

- **Route Scheme** — where and how often service should happen: geography + calendar reference + recurrence (`weekly` / `every-2-weeks` with odd/even ISO-week rotation / `monthly` = first occurrence of each selected weekday) + service days + effective period + planned start time + operational defaults (vehicle, driver, depot, unloading station, contractor) + explicitly picked container lists, optionally distinct per service day. Lifecycle Draft → Validated → Scheduled → Effective → Expired, gated by FR-5 validation.
- **Collection Calendar** — redefined as a **validity filter**, not a date source: working days, holiday dates, validity period. Holiday/non-working candidate dates are skipped (never auto-moved); uncovered dates warn and proceed.
- **Collection Deviation** — the only date-remap mechanism; an applicable Approved/Notified deviation outranks calendar filtering.
- Runtime flow: Area/Zone + Calendar → Route Scheme → candidate service dates → applicable Approved Deviations → calendar validity filtering of undeviated dates → generated Routes (deterministic identity `(schemeId, serviceDate)`, idempotent upsert, Plan Ahead rolling 7 days).
- **Pickup Settings, Collection Weeks, and Collection Calendar Days were deleted** (2026-08-29); "Pickup Setting" and "Collection Week" are glossary-retired to Avoid lists (Q15), legacy localStorage records orphaned with no migration (Q4), and the remaining UI strings were renamed to **"Service frequency"** (issues #13, #16). The generation engine never read the retired modules (verified in audit); `scripts/plan-structure-harness.ts` asserts their removal from the registry, schemas, and relations.

Rationale on record: the industry-consensus **two-layer** model (recurring definition → generated dated instances — AMCS Master Routes, CRO permanent routes; the real product's own Plan Ahead/Optimize shows the shared materialization half, not where recurrence lives), plus the observed failure of the previous shape in this prototype, where scheme recurrence was free text nothing consumed and the scheme could not fulfil its own rule that routes are generated from schemes.

## What actually differs

| # | Dimension | Real product (four-layer) | Prototype (scheme-owned) |
|---|---|---|---|
| 1 | Where recurrence rules live | Pickup Setting records (no dates) | Structured fields on the Route Scheme |
| 2 | How dates exist | **Dates as data**: Collection Calendar Days are materialized, editable records (holiday handling = editing them by hand) | **Dates as function**: candidate dates derived from scheme recurrence at generation time; the calendar only *vetoes* (validity filter); nothing date-shaped is stored except generated Routes |
| 3 | Stop selection | Declarative: matched by waste fraction + vehicle type | Imperative: explicitly picked container lists, optionally per service day |
| 4 | Cadence granularity | Per pickup setting, referenced per container (containers select a pickup setting at creation) | Per scheme — frequency and week rotation are scheme-level fields |
| 5 | Cadence vocabulary | Collections/week + integer weeks-between or days-between; **no monthly in the public model**; fortnights **anchor-based** (start week + date) | `weekly` / `every-2-weeks` (ISO odd/even parity — a prototype invention, with the 53-week-year edge) / `monthly` (first weekday occurrence — no public real counterpart); no every-3/4-weeks |
| 6 | Cadence as catalogue/pricing dimension | The same Pickup Setting record is **required** on container prices and linked from products | Deliberately absent: container "Service frequency" is a display-only fact; the price engine dropped pickup setting as a condition (conscious cut, extendable) |
| 7 | Route materialization | Plan Ahead (auto, chosen horizon) or Optimize (manual, one date) | Same auto/manual split: per-scheme Plan Ahead toggle (rolling 7 days, name shared) + per-window "Generate routes" (manual, without Optimize's stop-sequence optimization — VRP is out of scope) |
| 8 | Date exceptions | A **"Collection Deviations"** settings tab exists by that very name (shape undocumented), plus direct editing of Calendar Days and an API-level `exclude_days` list; nothing automatic | Collection Deviation: approved replacement of one planned date, preserving the promise; deviations outrank calendar filtering; the only remap mechanism |
| 9 | Terminology | "Pickup Setting" is a live term (with a "Pickup scheme" wobble on agreement views) | Retired to Avoid lists; cadence-as-attribute surfaces as "Service frequency" |

Three deltas carry most of the weight:

- **Delta 2 is the deepest model disagreement.** The real product materializes dates as editable records — operators fix holidays by editing the list; the prototype derives dates and forbids editing them except through governed deviations. The prototype's split is cleaner and auditable ("calendar decides validity; deviation decides relocation"; regeneration is idempotent), but it removes a workflow real operators demonstrably have: hand-adjusting the date list.
- **Delta 3 is a scale question.** Explicit container lists were right for a prototype with 9 seeded scheme-linked containers; a municipality-scale scheme cannot hand-pick thousands of stops. Declarative matching (fraction + vehicle type) is the real product's answer, and any convergence has to keep it — which is also exactly the hook where per-container cadence (delta 4) re-enters.
- **Delta 5 means neither vocabulary embeds in the other.** The real model expresses every-3-weeks and 3×-per-week-with-min-gap; the prototype expresses monthly-by-weekday. A convergence has to pick a superset (the real product's interval model generalizes further) and define the anchor-vs-parity translation for fortnights.

## Concept mapping (where each real-product layer lands in the prototype's model)

| Real-product concept | Prototype home | Lossy? |
|---|---|---|
| Pickup Setting — frequency rules (collections/week + weeks/days-between; days and anchor live on the child calendar, row 3) | Scheme fields `frequency`, `serviceDays`, `weekRotation` | Yes, twice: (a) per-container cadence collapses to per-scheme — frequency/rotation are scheme-level; per-day plans (FR-14) vary *containers* per weekday, never cadence, so weekly restwaste + fortnightly glass always needs two schemes; (b) vocabulary — every-3/4-weeks and days-between-N don't exist in the prototype; `monthly` doesn't exist in the public real model; fortnights are anchor-based there, parity-based here |
| Pickup Setting — catalogue/pricing attribute | Container fact "Service frequency" (display-only); price-condition slot consciously cut but the condition-row pattern extends to it | Yes, deliberately: no typed source. The real product's answer to "where does the typed home live" is a reusable frequency record referenced by product and container — **not** the agreement (its API object has no frequency field). Follow-up 3's Agreement/Subscription target should be re-examined against that (answered question 2 — see the open-questions status section and issue #20) |
| Collection Calendar — weekday pattern + anchor | Scheme recurrence math (`nextServiceDates`, candidate-date walk) | Conditional on row 1's collapse; the anchor (start week + date) has no prototype counterpart — parity approximates it except across 53-week years |
| Collection Calendar Days — materialized editable dates | No counterpart: dates are derived, surfaced only as preview + generated Routes | Yes: the real product's hand-edit-the-dates workflow (its documented holiday handling) is deliberately impossible in the prototype — governed Collection Deviations are the only remap. This is delta 2, the deepest disagreement |
| Collection Deviations (real settings tab, shape unknown) | Collection Deviation (scope, original/replacement date, promise preserved, precedence over calendar) | Unknown until the real record's shape is seen — the prototype's may be a superset (open question, dev-app session) |
| Route Scheme — vehicle/driver rules + collection mode | Scheme assignment defaults (vehicle, driver, depot, unloading station, contractor) + dispatch-time overrides preserved on refresh | Collection mode (collect vs replace containers) has no prototype counterpart; otherwise no |
| Plan Ahead / Optimize | Plan Ahead toggle (rolling 7 days) / "Generate routes" per window | Partly: trigger split mirrored and the Plan Ahead name shared; real Plan Ahead takes an arbitrary horizon (prototype: fixed 7 days); Optimize's stop-sequence optimization has no prototype counterpart |
| Stop matching by fraction + vehicle type | Not present — explicit `containerIds` / `containersByDay` | Gap (absent), not a lossy mapping — the prototype has no declarative matching. Also absent: the real product's Active-agreement gate — only containers in Active status can be planned into routes |

Reading the table: the prototype did not delete the Pickup Setting layer's *content* — it split it. The routing rules moved onto the scheme; the attribute/pricing role was renamed "Service frequency" and awaits a typed home (open question 2). The Collection Calendar split differently than the repo previously recorded: its pattern+anchor half moved into scheme recurrence, its *materialized Days* half has no prototype counterpart at all (replaced by derivation + deviations), and the prototype's validity-filter calendar is largely a **new** concept (working days/holiday lists exist nowhere public in the real model). What the prototype lacks outright: declarative stop matching, editable date records, every-N-weeks vocabulary, collection mode.

## The options

### A — Real product adopts scheme-owned recurrence (two-layer)

The real product migrates pickup-setting rules onto schemes and demotes calendars to validity filters, as prototyped.

- **For:** matches industry consensus; one record answers "when does this run"; the prototype validated the full slice end-to-end (structured recurrence, calendar-aware idempotent generation, deviation precedence, Plan Ahead — all harness-covered); eliminates the week-parity-drift class of bugs between pickup settings and schemes by construction.
- **Against:** a real-data migration of live customers' pickup settings *and* their materialized Collection Calendar Days (including every hand-edited holiday date, which the prototype model can only express as deviations); per-container cadence (delta 4) must be re-expressed as more schemes; the cadence vocabulary must be reconciled (delta 5 — every-N-weeks has no scheme counterpart, anchor-based fortnights must translate to or replace ISO parity); Pickup Setting's catalogue/pricing role is untouched by this change and must survive independently (the attribute doesn't disappear just because the routing layer does — it is a required field on container prices today); stop selection must stay declarative — adopting the prototype's explicit container lists at real scale is not viable.

### B — Prototype conforms to the three-layer chain

A future prototype iteration reintroduces Pickup Settings and calendar-produced dates.

- **For:** zero real-product change; per-container cadence and the pricing dimension stay native.
- **Against:** re-creates the exact problems this prototype was built to fix — recurrence data far from the scheme that consumes it, cadence edits spanning three records, and the pickup-setting-vs-scheme consistency validation the original spec had to scope out (ROUTE_SCHEMES.md, Out of Scope: "week-parity vs pickup settings"). The prototype's cleanest wins — the validity-filter calendar, the deviation precedence doctrine, deterministic `(schemeId, serviceDate)` identity — all assume the scheme owns candidate dates; under B all of them, plus the issue #10 customer-notice pipeline built on deviations, would need re-founding on calendar-produced dates. Nothing learned since 2026-08-28 argues for this direction.

### C — Converge via a defined mapping (recommended)

C is not a third direction: it is **A's core plus explicit handling of what A leaves implicit**, so choosing C subsumes choosing A. The real decision is "A-core: yes or no" — and if yes, C names the rest:

1. **Operational cadence lives on the Route Scheme** (A's core), with the Collection Calendar as validity filter and Collection Deviations as the date-remap mechanism.
2. **Customer-promise cadence is an attribute, not a routing layer**: a typed "Service frequency" referenced from the service relationship. The research answered where the real product homes it — a reusable frequency record referenced by **product and container**, with the agreement carrying no frequency of its own — so the natural C shape is the same: a small typed frequency record (or enum) referenced by container/product and *displayed* on agreements, usable as a catalogue/pricing dimension exactly as the real ContainerPrice requires it. Follow-up 3's Agreement/Subscription target should be adjusted accordingly (issue #20). It constrains and reconciles against scheme recurrence; it generates nothing.
3. **Stop selection converges toward the real product, not away from it**: declarative matching (fraction + vehicle type + geography) is the scalable model; the prototype's explicit per-day container lists are the small-scale stand-in. This is the one mechanism to borrow *from* the real product rather than replace.
4. **The reconciliation validation** (scheme recurrence vs promised service frequency — the deferred "week-parity vs pickup settings" class) becomes a first-class check *once step 2 gives the promise a typed home*: a scheme whose recurrence under-serves a linked container's promised frequency warns at validation. With the real vocabulary in view, "under-serves" generalizes to interval comparison (collections/week and weeks-between-N order naturally); the treatment of over-service is part of the decision, not assumed here.

Stated plainly: under C, per-container cadence is re-expressed as **one scheme per cadence** (× fraction, per area) — scheme proliferation the three-layer chain does not have, viable at municipality scale only because of step 3's declarative matching. Step 4 is the safety net that detects drift; it is not the remedy for the granularity collapse.

- **For:** keeps the capabilities the three-layer chain actually provides (per-container promises, pricing dimension, declarative matching) while keeping the problems it caused fixed (split-brain recurrence, dead free-text data, three-record edits).
- **Against / costs (C inherits A's bill, plus its own):** the real-data migration of live customers' pickup settings and their materialized Collection Calendar Days (hand-edited holiday dates become deviations — or the dates-as-data workflow is conceded, which is a real workflow loss); reshaping real Collection Calendar records from pattern+anchor producers into validity filters (a concept the real model doesn't have); scheme-per-cadence proliferation; a cadence-vocabulary superset decision (adopt every-N-weeks/days-between, decide monthly's fate, translate anchors to parity or adopt anchors); and reconciling the prototype's Collection Deviation semantics with the real product's **existing** Collection Deviations tab — the concept already exists there by name, so this cost shrank from "introduce a concept" to "verify the semantics match" (still open: the real record's shape).

## Recommendation

**Option C, accepting its stated costs.** The prototype's contribution is not "delete Pickup Setting" — it is the discovery that Pickup Setting was two things fused: a routing-rules layer (which belongs on the scheme) and a service-promise attribute (which belongs in the catalogue and on the service relationship). The research **confirmed the fusion literally**: one record serves both roles today, which is exactly why option A alone is incomplete (it unhooks the routing role and leaves a required pricing field pointing at a de-fanged record) and option B changes nothing. Since C = A's core + the attribute doctrine + declarative stop selection + the reconciliation check, recommending C is recommending A with its consequences named. Two research findings sharpen C's content: the real product already has Collection Deviations by name (so C's exception model is a semantics-alignment, not a new concept), and its cadence vocabulary is strictly interval-based (so C should adopt every-N-weeks/days-between as the superset and treat the prototype's `monthly` and ISO parity as translation questions, not fixtures). The genuinely contested doctrinal ground that remains is delta 2 — dates as editable data vs dates as governed derivation — and there the prototype's model is the deliberate improvement this document argues to keep: auditable, idempotent, promise-preserving. (Smaller unassigned gaps — collection mode, Plan Ahead's arbitrary horizon vs the prototype's fixed 7 days — are feature work under any option, not doctrine.)

The decision itself — and any sequencing for the real product — is a product call outside this repo (Q1). This document is its input, not its execution.

## Follow-up 6: timezone enforcement

Orthogonal to the convergence choice and unchanged by it. Timezone is display-only by locked decision Q9 — generation is day-granular ISO dates; the calendar's `timezone` field and the scheme's `plannedStartTime` carry no date math. It becomes a real concern only if hour-level planning arrives, under any of options A/B/C equally. Nothing to decide now; recorded here so issue #15 closes over both follow-ups.

## What is already true regardless of the decision

- Route materialization is already converged in trigger shape (delta 7): the auto path shares the Plan Ahead name and rolling-window behavior; the manual per-window path exists as "Generate routes" — without Optimize's stop-sequence optimization, which remains out of scope.
- The glossary, domain registry, and all UI strings in this repo are internally consistent with scheme-owned recurrence (issues #12–#14, #16); no further prototype work is pending on the naming front.
- The retired layer's removal is harness-asserted and the engine's independence from it was verified by audit (PLAN_SIMPLIFICATION.md, test 4), so if the decision ever went toward option B, it would be a model change, not a re-wiring.

## Open questions — status after the 2026-08-30 research

Answered (evidence in `docs/research/PICKUP_SETTING_CHAIN.md`):

1. ~~One record or two roles?~~ **One record.** The same project-scoped Pickup Setting parents the routing calendars, is selected on containers, and is required on container prices.
2. ~~Where does the promise live?~~ **A reusable frequency record referenced by product and container — not the agreement** (its API object has no frequency field; it displays inherited values). Issue #20's Agreement/Subscription framing should be adjusted to match.
3. ~~Anchor or parity?~~ **Anchor-based** (calendar start week + date). ISO parity is a prototype invention; converging means translating anchors to parity (lossy across 53-week years) or adopting anchors.
4. ~~Monthly semantics?~~ **No monthly exists** in the public real model; the real vocabulary is collections/week + weeks-between-N / days-between-N. The prototype's `monthly` and the real every-3/4-weeks are mutually foreign.
5. ~~Date-exception mechanism?~~ **"Collection Deviations" exists in the real product by that name** (settings tab), alongside manual editing of Collection Calendar Days and an `exclude_days` list. No automatic holiday handling is documented.

Still open (public sources exhausted — these need a logged-in dev-app session, like the 2026-08-19 Products & Prices exploration):

1. The real Collection Deviation record's fields and semantics (original/replacement date? scope? promise preservation?) — determines whether the prototype's deviation model is a superset or a mismatch.
2. The real Route Scheme's full field list (help: "highly customizable"; public API exposes only id + name) — does it carry geography, fraction, or container-type parameters?
3. Plan Ahead's exact mechanics (trigger model, one route per scheme per collection day?).
4. Which record the citizen portal/notifications read frequency and next dates from.
5. Whether the live app has a monthly mode the help center doesn't document, whether "Collection Weeks" records carry more than a start-week number, and the undocumented API semantics (`pickup_method`/`pickup_interval` enums, `recurring_interval` units, whether `available_days` folds deviations in).

## Sources

All in this repo: `docs/research/PICKUP_SETTING_CHAIN.md` (2026-08-30 public-source research: help.wastehero.io + docs.wastehero.io API schemas — the four-layer chain, one-record confirmation, anchor-based fortnights, no monthly, real Collection Deviations tab), `docs/specs/ROUTE_SCHEMES.md` (originally recorded chain §Research Basis; divergence decision §Out of Scope), `docs/specs/PLAN_SIMPLIFICATION.md` (authoritative model, Q1–Q19, follow-ups 5–6), `docs/research/PRODUCTS_AND_PRICES.md` (dev-app Pickup Setting as catalogue/pricing dimension, explored 2026-08-19), `CONTEXT.md` (glossary), `docs/BUSINESS_MODULE_MAP.md` + `lib/data/business-domain.ts` (M09 ownership, retirements), `docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md` (the conscious cut of pickup setting as a price condition), `lib/route-schemes/*` (shipped engine: recurrence, calendar, generation, plan-ahead, validation).
