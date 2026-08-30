# Real-Product Convergence — Scheme-Owned Recurrence vs the Three-Layer Chain

Status: Decision-support draft · 2026-08-30 · Owner: Product (fares) · Issue: [#15](https://github.com/Faresabdelghany/Waste/issues/15)

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

The dev-app research (`docs/research/PRODUCTS_AND_PRICES.md`, live exploration 2026-08-19) adds a second, independent role: in the real product **"Pickup Setting" is also Asset-management master data** — a system-required attribute on container product templates, a product-table column, an xlsx import column, and an optional best-match pricing condition on price rows. Billing frequency is a separate field. The dev-app research records nothing about pickup settings driving routing — the routing role is documented only via the help-site chain above.

So in the real product the term does two jobs: (a) the rules layer of the routing chain, and (b) a catalogue/pricing dimension.

### Prototype (authoritative model)

Per PLAN_SIMPLIFICATION.md §Product model (authoritative), shipped and harness-guarded:

- **Route Scheme** — where and how often service should happen: geography + calendar reference + recurrence (`weekly` / `every-2-weeks` with odd/even ISO-week rotation / `monthly` = first occurrence of each selected weekday) + service days + effective period + planned start time + operational defaults (vehicle, driver, depot, unloading station, contractor) + explicitly picked container lists, optionally distinct per service day. Lifecycle Draft → Validated → Scheduled → Effective → Expired, gated by FR-5 validation.
- **Collection Calendar** — redefined as a **validity filter**, not a date source: working days, holiday dates, validity period. Holiday/non-working candidate dates are skipped (never auto-moved); uncovered dates warn and proceed.
- **Collection Deviation** — the only date-remap mechanism; an applicable Approved/Notified deviation outranks calendar filtering.
- Runtime flow: Area/Zone + Calendar → Route Scheme → candidate service dates → applicable Approved Deviations → calendar validity filtering of undeviated dates → generated Routes (deterministic identity `(schemeId, serviceDate)`, idempotent upsert, Plan Ahead rolling 7 days).
- **Pickup Settings, Collection Weeks, and Collection Calendar Days were deleted** (2026-08-29); "Pickup Setting" and "Collection Week" are glossary-retired to Avoid lists (Q15), legacy localStorage records orphaned with no migration (Q4), and the remaining UI strings were renamed to **"Service frequency"** (issues #13, #16). The generation engine never read the retired modules (verified in audit); `scripts/plan-structure-harness.ts` asserts their removal from the registry, schemas, and relations.

Rationale on record: the industry-consensus **two-layer** model (recurring definition → generated dated instances — AMCS Master Routes, CRO permanent routes; the real product's own Plan Ahead/Optimize shows the shared materialization half, not where recurrence lives), plus the observed failure of the previous shape in this prototype, where scheme recurrence was free text nothing consumed and the scheme could not fulfil its own rule that routes are generated from schemes.

## What actually differs

| # | Dimension | Real product (three-layer) | Prototype (scheme-owned) |
|---|---|---|---|
| 1 | Where recurrence rules live | Pickup Setting records (no dates) | Structured fields on the Route Scheme |
| 2 | Collection Calendar's role | Date source (rules → dates) | Validity filter (working days, holidays, validity window) |
| 3 | Stop selection | Declarative: matched by waste fraction + vehicle type | Imperative: explicitly picked container lists, optionally per service day |
| 4 | Cadence granularity | Per pickup setting — inferred from its per-product master-data role; per-area granularity unrecorded | Per scheme — frequency and week rotation are scheme-level fields |
| 5 | Cadence as catalogue/pricing dimension | Pickup Setting is Asset-management master data; system-required on container templates; optional price-row condition | Deliberately absent: container "Service frequency" is a display-only fact; the price engine dropped pickup setting as a condition (conscious cut, extendable) |
| 6 | Route materialization | Plan Ahead (auto) or Optimize (manual per date) | Same auto/manual split: per-scheme Plan Ahead toggle (rolling 7 days, name shared) + per-window "Generate routes" (manual, without Optimize's stop-sequence optimization — VRP is out of scope) |
| 7 | Date exceptions | Not recorded in this repo's real-product research | Collection Deviation: approved replacement of one planned date, preserving the promise; deviations outrank calendar filtering |
| 8 | Terminology | "Pickup Setting" is a live term | Retired to Avoid lists; cadence-as-attribute surfaces as "Service frequency" |

Two deltas carry most of the weight:

- **Delta 2 is a genuine model disagreement.** In the real chain the calendar *produces* dates from rules; in the prototype the scheme produces candidate dates and the calendar only *vetoes* them. The prototype's split is cleaner — it gave a crisp precedence doctrine ("calendar decides validity; deviation decides relocation") that the date-source model has no obvious place for.
- **Delta 3 is a scale question.** Explicit container lists were right for a prototype with 9 seeded scheme-linked containers; a municipality-scale scheme cannot hand-pick thousands of stops. Declarative matching (fraction + vehicle type + geography) is the real product's answer, and any convergence has to keep it — which is also exactly the hook where per-container cadence (delta 4) re-enters.

## Concept mapping (where each real-product layer lands in the prototype's model)

| Real-product concept | Prototype home | Lossy? |
|---|---|---|
| Pickup Setting — routing rules (frequency, days, rotation) | Scheme fields `frequency`, `serviceDays`, `weekRotation` | Yes: per-container cadence collapses to per-scheme. Frequency and week rotation are scheme-level; per-day plans (FR-14) vary *containers* per weekday, never cadence — so an area serving weekly restwaste + fortnightly glass always needs two schemes |
| Pickup Setting — catalogue/pricing attribute | Container fact "Service frequency" (display-only); price-condition slot consciously cut but the condition-row pattern extends to it | Yes, deliberately: no typed source. Follow-up 3 already names the canonical home — Agreement/Subscription — once agreement↔container relations exist |
| Collection Calendar — date production | Scheme recurrence math (`nextServiceDates`, candidate-date walk) | Conditional on row 1's collapse; whether the real calendar also relocates dates (holiday offsets) is unrecorded — see open question 5 |
| Collection Calendar — operational validity | Collection Calendar (working days, holidays, validity), referenced by the scheme | No — this half kept the name and gained structure |
| Route Scheme — vehicle/driver rules | Scheme assignment defaults (vehicle, driver, depot, unloading station, contractor) + dispatch-time overrides preserved on refresh | No |
| Plan Ahead / Optimize | Plan Ahead toggle (rolling 7 days) / "Generate routes" per window | Partly: trigger split mirrored and the Plan Ahead name shared; Optimize's stop-sequence optimization has no prototype counterpart |
| Stop matching by fraction + vehicle type | Not present — explicit `containerIds` / `containersByDay` | Gap (absent), not a lossy mapping — the prototype has no declarative matching |

Reading the table: the prototype did not delete the Pickup Setting layer's *content* — it split it. The routing rules moved onto the scheme; the attribute/pricing role was renamed "Service frequency" and awaits a typed home (follow-up 3 targets Agreement/Subscription; open question 2). The Collection Calendar likewise split: date production moved into scheme recurrence; validity stayed on the calendar. What has no prototype counterpart at all is declarative stop matching.

## The options

### A — Real product adopts scheme-owned recurrence (two-layer)

The real product migrates pickup-setting rules onto schemes and demotes calendars to validity filters, as prototyped.

- **For:** matches industry consensus; one record answers "when does this run"; the prototype validated the full slice end-to-end (structured recurrence, calendar-aware idempotent generation, deviation precedence, Plan Ahead — all harness-covered); eliminates the week-parity-drift class of bugs between pickup settings and schemes by construction.
- **Against:** a real-data migration of live customers' pickup settings; per-container cadence (delta 4) must be re-expressed — either more schemes or per-day plans; Pickup Setting's catalogue/pricing role is untouched by this change and must survive independently (the attribute doesn't disappear just because the routing layer does); stop selection must stay declarative — adopting the prototype's explicit container lists at real scale is not viable.

### B — Prototype conforms to the three-layer chain

A future prototype iteration reintroduces Pickup Settings and calendar-produced dates.

- **For:** zero real-product change; per-container cadence and the pricing dimension stay native.
- **Against:** re-creates the exact problems this prototype was built to fix — recurrence data far from the scheme that consumes it, cadence edits spanning three records, and the pickup-setting-vs-scheme consistency validation the original spec had to scope out (ROUTE_SCHEMES.md, Out of Scope: "week-parity vs pickup settings"). The prototype's cleanest wins — the validity-filter calendar, the deviation precedence doctrine, deterministic `(schemeId, serviceDate)` identity — all assume the scheme owns candidate dates; under B all of them, plus the issue #10 customer-notice pipeline built on deviations, would need re-founding on calendar-produced dates. Nothing learned since 2026-08-28 argues for this direction.

### C — Converge via a defined mapping (recommended)

C is not a third direction: it is **A's core plus explicit handling of what A leaves implicit**, so choosing C subsumes choosing A. The real decision is "A-core: yes or no" — and if yes, C names the rest:

1. **Operational cadence lives on the Route Scheme** (A's core), with the Collection Calendar as validity filter and Collection Deviations as the date-remap mechanism.
2. **Customer-promise cadence is an attribute, not a routing layer**: a typed "Service frequency" on the service relationship — wherever that attribute canonically lives (Agreement/Subscription per follow-up 3's re-sourcing target, or the container/product as the dev-app has it today; open question 2), surfaced on containers and usable as a catalogue/pricing dimension exactly as the dev-app uses Pickup Setting. It constrains and reconciles against scheme recurrence; it generates nothing.
3. **Stop selection converges toward the real product, not away from it**: declarative matching (fraction + vehicle type + geography) is the scalable model; the prototype's explicit per-day container lists are the small-scale stand-in. This is the one mechanism to borrow *from* the real product rather than replace.
4. **The reconciliation validation** (scheme recurrence vs promised service frequency — the deferred "week-parity vs pickup settings" class) becomes a first-class check *once step 2 gives the promise a typed home*: a scheme whose recurrence under-serves a linked container's promised frequency warns at validation. The frequency ordering (weekly > every-2-weeks > monthly) and the treatment of over-service are part of the decision, not assumed here.

Stated plainly: under C, per-container cadence is re-expressed as **one scheme per cadence** (× fraction, per area) — scheme proliferation the three-layer chain does not have, viable at municipality scale only because of step 3's declarative matching. Step 4 is the safety net that detects drift; it is not the remedy for the granularity collapse.

- **For:** keeps the capabilities the three-layer chain actually provides (per-container promises, pricing dimension, declarative matching) while keeping the problems it caused fixed (split-brain recurrence, dead free-text data, three-record edits).
- **Against / costs (C inherits A's bill, plus its own):** the real-data migration of live customers' pickup settings; reshaping real Collection Calendar records from date-producers into validity filters; scheme-per-cadence proliferation; and either introducing the Collection Deviation concept to the real product or mapping it onto whatever date-exception mechanism the real product already has (unrecorded in this repo — open question 5).

## Recommendation

**Option C, accepting its stated costs.** The prototype's contribution is not "delete Pickup Setting" — it is the discovery that Pickup Setting was two things fused: a routing-rules layer (which belongs on the scheme) and a service-promise attribute (which belongs in the catalogue and on the service relationship). Option A adopts the first discovery but leaves the attribute role homeless — unaddressed rather than lost; option B re-fuses the two. Since C = A's core + the attribute doctrine + declarative stop selection + the reconciliation check, recommending C is recommending A with its consequences named. The mapping in §Concept mapping is the convergence artifact: each real-product concept has a named home, the two lossy cells have named re-expressions (per-container cadence → one scheme per cadence, scalable via declarative matching, guarded by reconciliation; pricing dimension → a typed Service frequency at whichever home open question 2 picks), and the one gap (declarative stop matching) is explicitly a borrow *from* the real product.

The decision itself — and any sequencing for the real product — is a product call outside this repo (Q1). This document is its input, not its execution.

## Follow-up 6: timezone enforcement

Orthogonal to the convergence choice and unchanged by it. Timezone is display-only by locked decision Q9 — generation is day-granular ISO dates; the calendar's `timezone` field and the scheme's `plannedStartTime` carry no date math. It becomes a real concern only if hour-level planning arrives, under any of options A/B/C equally. Nothing to decide now; recorded here so issue #15 closes over both follow-ups.

## What is already true regardless of the decision

- Route materialization is already converged in trigger shape (delta 6): the auto path shares the Plan Ahead name and rolling-window behavior; the manual per-window path exists as "Generate routes" — without Optimize's stop-sequence optimization, which remains out of scope.
- The glossary, domain registry, and all UI strings in this repo are internally consistent with scheme-owned recurrence (issues #12–#14, #16); no further prototype work is pending on the naming front.
- The retired layer's removal is harness-asserted and the engine's independence from it was verified by audit (PLAN_SIMPLIFICATION.md, test 4), so if the decision ever went toward option B, it would be a model change, not a re-wiring.

## Open questions the decision should answer

1. Does the real product's Pickup Setting data model distinguish its routing role from its catalogue role today, or is it one record? (This repo's research cannot see this; it determines migration shape under A/C.)
2. Where does the real product want customer-promise cadence to live — Agreement/Subscription (as follow-up 3 assumes) or on the container/product as today?
3. Is ISO-week parity (odd/even) an acceptable fortnightly model for real customers, or does real data need anchor-date cadence? (The prototype's known 53-week-year edge: an odd-rotation scheme serves two consecutive weeks at the ISO year boundary.)
4. Monthly semantics: the prototype's `monthly` = first occurrence of each selected weekday; the real product's monthly pickup-setting semantics are unrecorded here.
5. What date-exception mechanism does the real product use today (industry-wide, holiday offsets are table stakes per ROUTE_SCHEMES.md §Research Basis), and does it map onto Collection Deviation's promise-preserving replacement-date semantics? Options A/C assume the deviation model; this repo's research does not record the real product's counterpart.

## Sources

All in this repo: `docs/specs/ROUTE_SCHEMES.md` (real-product chain §Research Basis; divergence decision §Out of Scope), `docs/specs/PLAN_SIMPLIFICATION.md` (authoritative model, Q1–Q19, follow-ups 5–6), `docs/research/PRODUCTS_AND_PRICES.md` (dev-app Pickup Setting as catalogue/pricing dimension, explored 2026-08-19), `CONTEXT.md` (glossary), `docs/BUSINESS_MODULE_MAP.md` + `lib/data/business-domain.ts` (M09 ownership, retirements), `docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md` (the conscious cut of pickup setting as a price condition), `lib/route-schemes/*` (shipped engine: recurrence, calendar, generation, plan-ahead, validation).
