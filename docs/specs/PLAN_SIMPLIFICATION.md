# Plan Simplification — Route Scheme–Centric Planning

Status: Approved (grilling session 2026-08-29, decisions Q1–Q19 locked) · Owner: Product (fares)
Builds on: `docs/specs/ROUTE_SCHEMES.md` (Draft v2) — this spec supersedes its Plan-navigation and calendar-behavior gaps.

## Product model (authoritative)

- **Areas & Zones** — reusable planning geography. Referenced, never embedded.
- **Collection Calendar** — the working days, holidays, and validity period that determine whether a normal planned date is operationally valid.
- **Route Scheme** — where and how often service should happen (geography + calendar reference + recurrence + service days + period + operational defaults + stop selection); generates dated Routes. Stop selection is a declarative matching rule by default (fractions + optional vehicle type resolved inside the scheme's planning area at generation — issue #19), with explicitly picked container lists as the manual mode.
- **Collection Deviation** — an approved replacement of one planned service date with another, preserving the original service promise.

Runtime flow: Area/Zone + Calendar → Route Scheme → candidate service dates → calendar validity filtering → applicable Approved Deviations → generated Routes.

**Derived precedence rule** (from Q2 + deviation semantics; encoded in the engine): an applicable Approved Deviation on a candidate date takes precedence over calendar filtering — the deviation exists precisely to relocate a holiday's service (e.g. 24 Dec → 27 Dec). Without a deviation, a holiday/non-working candidate date is skipped, never auto-moved. A replacement date is honored even on a non-working day (explicit planner choice) but flagged in the preview.

**Further derived engine rules** (adversarial review 2026-08-29):
- *Generation-authored cancels are resurrectable bookkeeping.* A route generation cancels (calendar skip, unserved-date cleanup) carries `submittedValues.cancelledByGeneration`; when the scheme serves that date again — a deviation now relocates it, the holiday left the calendar, the service day returned — the route is re-created. Operationally cancelled routes (no marker) are never resurrected.
- *Deviation tie-break is deterministic.* When several approved deviations match one date, the most specific scope wins (scheme over project/legacy), then name order — never store-enumeration order.
- *The date walk caps at 367 days*, and unserved-date cleanup is bounded by the walked range, so an over-long generation window can never cancel still-served routes past the truncation point.

## Locked decisions

| # | Decision |
|---|---|
| Q1 | Scope = this repo only (fixtures, form schemas, localStorage stores, generation, navigation). `~/Desktop/WH` untouched; real-product deltas documented as follow-up. |
| Q2 | Holiday/non-working candidate date → **skip** (no route, no auto-move, no auto-deviation); skipped dates surfaced in generation preview. Calendar decides validity; Deviation decides relocation. |
| Q3 | Odd/even = **ISO 8601 week parity**, never start-date-derived. `every-2-weeks` + `weekRotation` is the existing model and stays. |
| Q4 | Legacy Pickup Settings / Collection Weeks / Calendar Days localStorage records stay orphaned: not read, not shown, not deleted. No migration layer. |
| Q5 | Collection Calendar model extended with structured `workingDays`, `holidayDates`, `validFrom`, `validTo`; fixtures seeded with real Danish 2026 holidays; display facts kept in sync. *Superseded in part by docs/new-changes/SPEC.md area J (issue #27, 2026-08-31): the list's Holidays / Next holiday columns and KPI tiles now derive from the structured values at render time; display facts are legacy detail-only copies with no sync contract.* |
| Q6 | Non-Active calendar / uncovered dates → **warn + proceed**: constraints apply only where the calendar covers the date; preview flags uncovered dates; save-time warning for non-Active calendars. Never block, never treat uncovered as non-working. |
| Q7 | Service day outside calendar working days → validation **warning at save** + **skip at generation**. Scheme defines intent; calendar defines validity. |
| Q8 | Deviation scope authoritative: `scheme` → exact `schemeId` only (missing/invalid `schemeId` = no effect, never project fallback); `project` → project overlap; `customer` → excluded from route-date remapping (portal/notification behavior = follow-up). |
| Q9 | Timezone stays display-only; generation is day-granular ISO dates. Documented, not pretended. |
| Q10 | `monthly` (first occurrence of each selected weekday) stays. Recurrence vocabulary: `weekly`, `every-2-weeks` (+ odd/even ISO rotation), `monthly`. |
| Q11 | `/plan` = Collection Deviations, Collection Calendars, Areas & Zones. Route Schemes stays in Route Studio; Vehicle Planning stays in Fleet (existing filtering preserved). |
| Q12 | Collection Calendars' add-deviation action form deleted; replaced by a real create-calendar form. Deviations creatable **only** via the Collection Deviations module. |
| Q13 | Deviation `calendarId` authoritative: a deviation affects only schemes referencing the same calendar; legacy deviations without `calendarId` fall back to project-overlap. |
| Q14 | Fixture schemes backfilled with structured recurrence (`scheme-central-a`: weekly Mon–Fri; `scheme-osterbro-b`: Tue/Thu every-2-weeks even) so fixtures generate out of the box. |
| Q15 | Glossary updated: Collection Calendar redefined (deviations removed from it), Collection Deviation + Planning Area added, Pickup Setting / Collection Week retired to Avoid lists. |
| Q16 | `commercial.settlements.serviceAreaId` and `improve.performance.serviceAreaId` repointed `plan.areas` → `service-providers.service-areas`. `service-providers.service-areas.zoneIds` → `plan.areas` stays as a deliberate cross-domain reference (service areas legitimately reference planning geography). |
| Q17 | Containers' `"Pickup setting"` / `"Collection calendar"` display facts and filter facets untouched (Resources surface, display-only). *Superseded by follow-up 3 execution (issue #13, 2026-08-29): the cadence fact is now `"Service frequency"`.* |
| Q18 | SettingsDialog "Calendars and pickup settings" pane untouched (Settings owns *defaults*; Plan owns *effective records*). *Superseded by follow-up 7 execution (issue #14, 2026-08-29): naming reconciled — the boundary itself is unchanged.* |
| Q19 | Tests via existing tsx/`check()` harness convention: extend generation + validation harnesses; add `route-scheme-calendar-harness.ts` and `plan-structure-harness.ts`. Not wired into package.json. |

## Implementation

### 1. Calendar model (`lib/route-schemes/calendar.ts`, new)
`CollectionCalendar` parsed from a `plan.calendars` record's `submittedValues`: `workingDays` (comma list of weekdays), `holidayDates` (comma/newline ISO list), `validFrom`/`validTo` (ISO, blank = open), plus record status/name. `calendarDayStatus(calendar, iso)` → `working | holiday | non-working | uncovered`. No structured data / no calendar = no constraint (uncovered).

### 2. Generation (`lib/route-schemes/generation.ts`)
- `planSchemeGeneration` takes optional `calendar`. Per candidate date: deviation first (precedence rule above); else holiday/non-working → new `omit` action row (preview-visible, writes nothing) — unless a still-Planned generated route exists on that date, which is cancelled with the calendar reason (same rule as unserved-date cleanup). Uncovered dates generate normally with a preview warning.
- `ApprovedDeviation` gains `calendarId`, `scopeType`, `schemeId` (from `submittedValues`); `deviationMatchesScheme` enforces Q8 + Q13.
- Summary gains `calendarSkipped`.

### 3. Plan Ahead (`lib/route-schemes/plan-ahead.ts`)
`runPlanAhead` accepts `calendarRecords`, resolves each scheme's calendar by `calendarId`, passes it through. Toast mentions holiday-skipped count.

### 4. Validation (`lib/route-schemes/validation.ts`)
`validateScheme` returns non-blocking `warnings` alongside blocking `issues`: service day outside calendar working days; calendar not Active; scheme effective window outside calendar validity. Shown in wizard review; stored as a `Validation warnings` fact. *Superseded in part (issue #25, 2026-08-31): the stored fact remains for history/debugging only — the authoritative current warnings are derived live per render via `schemeAttention` (`lib/route-schemes/lifecycle.ts`) and shown as the amber Attention badge; see `docs/new-changes/SPEC.md` area B.*

### 5. Registry removal
- `business-modules.ts`: delete `pickup-settings`, `calendar-days`, `collection-weeks` modules; update Plan copy; retarget calendars module (`primaryAction: "New calendar"`, rules); scrub dangling `related[]` strings; backfill scheme/calendar/deviation fixtures with `submittedValues`. *Amended by docs/new-changes/SPEC.md area J (issue #27, 2026-08-31): the calendars module's static `metrics` were removed — the rendered KPI tiles derive from real records (lib/route-schemes/calendar-list.ts) — and `contextLabel` is "Project" per D22.*
- `business-domain.ts`: Plan `moduleIds` → 3; delete the three module domain entries; refresh purpose/boundary notes.
- `business-form-schemas-operations.ts`: delete 3 schemas; replace `plan.calendars` action schema with a create-calendar form (name, project, week start, working days, holiday dates, valid from/to, timezone display-only).
- `business-form-schemas.ts`: drop `plan.calendars` action execution, conditionals, customerId rewrite, injected rule.
- `business-links.ts`: drop the three retired fallback term rows.
- `business-workspace.tsx`: Plan primary tabs → 3.

### 6. Service-area selectors
Two relation edits in `business-form-schemas-commercial-improve.ts` (Q16).

### 7. Docs & glossary
`CONTEXT.md` per Q15; `docs/BUSINESS_MODULE_MAP.md` M09/Plan rows updated.

## Tests (harness coverage map)

1. Weekly scheme generates expected dates — existing generation harness (kept green).
2. Multi-day scheme generates all service days — existing.
3. Biweekly odd/even from scheme fields, no Collection Weeks — existing recurrence harness (kept green).
4. Generation independent of Pickup Settings — structural: modules deleted; engine never read them (verified in audit); plan-structure harness asserts removal.
5. Generation independent of Calendar Days — same.
6. Selected calendar affects generation — new checks: holiday skip, non-working skip, uncovered warning, Plan Ahead skip.
7. Approved deviation changes service date — existing + new calendarId/scope checks.
8. Draft deviation has no effect — existing (status filter).
9. Idempotency preserved — existing + re-run with calendar.
10. Existing schemes usable — fixture backfill + `schemeCanGenerateRoutes` assertions.
11. Removed tabs gone from navigation — plan-structure harness.
12. Areas/Calendars consumers unbroken — schema-registry import-time integrity gates + plan-structure harness relation assertions.

## Follow-ups (for ticketing — not in this change)

1. **Customer-scoped deviations**: excluded from route-date remapping; intended portal/notification behavior (customer-facing calendar exceptions, notices) needs product definition. *Implemented (issue #10)*: a customer-scoped deviation is a promise-level notice for one customer — `lib/route-schemes/customer-deviations.ts` derives Approved/Notified notices per `customerId`, the citizen portal shows them as a "Collection date changes" banner (`portal-deviation-notices.tsx`), and generation keeps ignoring customer scope (guarded in `scripts/customer-deviation-harness.ts`).
2. **`service-providers.service-areas.zoneIds` → `plan.areas`**: deliberate cross-domain reference today; revisit if the service provider domain gets its own zone concept. *Reviewed 2026-08-29 (issue #12): kept — no service-provider-owned zone concept.* A Service Area is a commercial award over operator-owned planning geography (the canonical spine `Service provider → Service Area → Route Scheme responsibility → Route` only joins because both sides share one geography), and the contract's own `boundary` text remains the legal boundary. Fallout applied: field label glossary-aligned `Zones` → `Planning areas`; both service-area fixtures now carry typed `zoneIds` relationRefs to real `plan.areas` records, with `submittedValues.zoneIds` asserted to agree (guarded in `scripts/plan-structure-harness.ts`); the Plan fixture that read as a contract award (`area-osterbro-contract`) was retitled as operational geography. Revisit trigger unchanged.
3. **Container fact labels** `"Pickup setting"` / `"Collection calendar"` on Resources → rename/re-source once container service cadence has a canonical home (Agreement/Subscription). *Rename implemented (issue #13, 2026-08-29)*: the container fact/facet is now **"Service frequency"** ("pickup setting" stays glossary-retired); "Collection calendar" keeps its label (still canonical) with drifted fixture values aligned to the real record name ("Copenhagen 2026" → "Copenhagen Central 2026"). Read sides keep a legacy fallback to the `"Pickup setting"` fact key, the drifted `"Copenhagen 2026"` fact *value* (`canonicalCalendarName`), and the retained `pickupSetting` form-field id so pre-rename localStorage records keep displaying and filtering; saving an edit migrates the record off both legacy shapes (`normalizeContainerRecord`). Fixture shape guarded in `scripts/plan-structure-harness.ts`. *Re-sourcing implemented (issue #20, 2026-08-31)*: the canonical home is **not** Agreement/Subscription — the #15 research corrected it to the real product's shape, a small reusable, project-scoped frequency record referenced by container and product (`lib/data/service-frequencies.ts`: real interval vocabulary — collections/week + weeks-between/days-between — plus a `schemeFrequency` label mapping onto scheme cadences — issue #21's reconciliation landed 2026-08-31 as non-blocking `validateScheme` warnings comparing scheme recurrence against the interval fields on a collections-per-week scale, with `schemeFrequency` serving only as the monthly definition's rate fallback). Containers reference it via typed `submittedValues.serviceFrequencyId` with the "Service frequency" fact *derived* from it (pure cadence names — the fused `"Organic · 14-day service"` fixture strings are gone); agreement fixtures gained typed `containerId` relations (the form's containerId relation select already existed — it lost the free-text `serviceFrequency` field and now notes the inheritance) and agreements display the frequency inherited from the assigned container, re-derived on agreement and container saves. The #13 fallbacks stay and were extended: read sides resolve typed reference → legacy `pickupSetting` value/option ids → legacy fact strings (fused values fold onto catalog names, `canonicalServiceFrequencyName`), and `normalizeContainerRecord` migrates saves onto the typed key. Guarded in `scripts/plan-structure-harness.ts` and `scripts/service-frequency-harness.ts`.
4. **Vehicle/driver conflict checking** — *Implemented (issue #11)*: scheme-save validation now also consults `fleet.vehicle-planning` allocations (typed `submittedValues`: `vehicleId`/`driverId`/`plannedStart`/`plannedEnd`/`schemeId`). A **Confirmed** allocation of the default vehicle/driver whose planned window touches the scheme (overlaps the effective period on a service day; missing/unparseable windows conservatively count as touching) is a blocking issue; any other non-Released status warns; Released and scheme-own allocations never conflict. Since the Plan allocation form is append-event, confirm/release/change event records are folded back onto their target via `existingAllocationId` (supersession in `allocationConflictSources`) before checking. FR-5d scheme-vs-scheme conflicts additionally skip provably disjoint effective periods (only parseable ISO dates prove disjointness). **Generation stays decoupled by design**: planned allocation is planning-only and never overwrites actual execution assignment (`business-domain.ts` M08 boundary note), so generated routes keep inheriting scheme defaults without reading Vehicle Planning. Guarded in `scripts/route-scheme-validation-harness.ts`.
5. **Real-product convergence**: the real WasteHero chain (Pickup Setting → Collection Calendar → Route Scheme) differs from this prototype's scheme-owned recurrence; convergence decision pending (carried over from ROUTE_SCHEMES.md).
6. **Timezone enforcement**: display-only by design (Q9); becomes real only if hour-level planning arrives.
7. **Settings defaults vs effective records**: SettingsDialog "Calendars and pickup settings" pane untouched (Q18); reconcile naming with retired Plan concepts later. *Naming reconciled (issue #14, 2026-08-29)*: the pane definition is now "Calendars and working days" (its title/description are dead copy — only its groups render, inside the visible "Operations setup" pane, whose description drops "pickup rules" for "working-day defaults"); the "Collection-week system" control is now "Week numbering system" ("Custom collection weeks" → "Custom week numbering"); the `calendar-days` control id — a pure name collision with the retired `plan.calendar-days` module, no runtime overlap — is now `calendar-working-days`, with a legacy-id read mapping (`legacySettingIds`) so values saved under `wastehero.settings.v1` survive the rename. The defaults-vs-effective-records boundary is unchanged: the pane's controls persist only to `wastehero.settings.v1` (the status row never persists) and nothing outside SettingsDialog reads them; Plan's effective records live in `wastehero-business-records-v1`. Guarded in `scripts/plan-structure-harness.ts`. Still open nearby (out of scope here): Route Studio's pickups module carries fixture facts labeled `"Pickup Setting"` on Pickup records (`business-modules.ts`), predating issue #13. *Resolved (issue #16, 2026-08-30)*: the 12 pickup fixture facts renamed `"Pickup Setting"` → **"Service frequency"** (values unchanged; the 4 depot/unloading stops carry no cadence fact). Unlike #13, no read-side fallback or edit-save migration exists or is needed: the capital-S key was fixture-only — the pickups form schema is `mode: "disabled"` (no user create/edit), route generation never wrote the fact, and no code read the key (pickups use the default filter variant; the fact surfaces only through generic label-keyed renderers). The existing lowercase `"Pickup setting"` container fallbacks were deliberately not extended to the capital-S casing. Guarded in `scripts/plan-structure-harness.ts`.
