# Issue #26 E2E — Route detail Overview layout + deviation info on every presentation path

Date: 2026-08-31 · Branch: main · Verified in browser against `pnpm dev` (localhost:3000).

## What changed

- `lib/route-schemes/generation.ts` — new exported pure seam `routeDeviationInfo(route, deviations)`:
  a stamped `Deviation` fact other than `"None"` shows verbatim; a route whose identity says it
  was moved (`actualDate` ≠ `serviceDate`) without such a stamp derives the note from approved
  deviation records using generation's own precedence (most-specific scope, then name order —
  extracted as the shared `deviationPrecedence`); a move no approved deviation explains (a manual
  date edit stores exactly this shape, issue #23) gets **no** row rather than fabricated deviation
  provenance. Route identity `(schemeId, serviceDate)` is never touched — the function only reads.
  Scope matching shares one tail (`deviationMatchesScope`) with `deviationMatchesScheme`; the
  route side cannot apply the calendar gate (routes record no calendar id) — display-only caveat.
- `components/wastehero/route-details-page.tsx` — `RouteInformation` computes the deviation note
  from the record + `plan/collection-deviations` records and renders it on **both** schedule
  branches (generated and fixture/demo), closing the issue #18 gap. Layout aligned to artboard 5
  (D14): Route information is the default-open right panel with the Map collapsed; the panel is
  Assignment + Schedule only (Progress section and the demo "Actual duration" row removed); the
  old `facts.Deviation` conditional that rendered "Deviation · None" is gone.
- `scripts/route-scheme-route-list-harness.ts` — 11 new checks for `routeDeviationInfo`
  (stamped note, "None" filtering, derived note, scope precedence, name ordering, scheme-scope
  mismatch → null, customer scope → null, manual move → null, fixture facts, no-data null).

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| Overview shows stops table `# / Stop / Arrival / Service / Status`, collapsible map, Route information with Assignment + Schedule | **Pass** — fixture route RC-1042 (`01-fixture-route-overview-no-deviation.png`): collapsed Map header, Route information open with ASSIGNMENT + SCHEDULE, stops table columns exact |
| Moved route shows deviation info regardless of creation path | **Pass (generated)** — RS-Central · Week A generated 21–27 Dec 2026 against the approved "Christmas Eve 2026" deviation (24 → 27 Dec): RC-8568 keyed `route-gen-scheme-central-a-2026-12-24`, operating 27 Dec, Schedule shows "Deviation · Moved from Thu 24 Dec · Public holiday" (`02-…`, `03-deviation-row-panel.png`). **Pass (fixture path)** — see `04-fixture-path-deviation-row.png`: a fixture-shaped route (no generated pickups, demo stops path) with a `Deviation` fact renders the row |
| Route with no deviation shows no deviation row | **Pass** — fixture RC-1042 shows no row (`01`); unmoved generated route (facts `Deviation: "None"`) shows no row (harness: "a generated route with no deviation gets no deviation info", plus browser check `05-unmoved-route-no-deviation.png`) |
| Statuses + deviation precedence unchanged; harnesses + tsc pass | **Pass** — route-list 31/31 and customer-deviation 11/11 green (full suite green), `npx tsc --noEmit` clean; lifecycle untouched; precedence reused verbatim (deviations outrank calendar filtering — 25 Dec holiday skipped while 24 Dec moved, visible in the generation preview) |
| Browser E2E with screenshots | This report + `docs/e2e/issue-26/*.png` |

## Notes

- Generation preview (Dec window) also confirmed carried rules: Fri 25 Dec skipped as
  "Holiday on Copenhagen Central 2026" (holidays never auto-move), the moved route flagged
  "Replacement date is not a working day" as a non-blocking warning, identity URL keyed to the
  original service date.
- The fixture-path check (04) seeds a fixture-shaped route record (no `submittedValues`, so it
  renders via the demo stops path — "Nordhavn Depot" fallback confirmed) carrying a stamped
  `Deviation` fact, through the store's own localStorage persistence; the row renders in the
  Schedule section. Map panel verified collapsed by default and expanding on header click.
- Two-axis code review (Standards/Spec) ran before commit; applied: shared `deviationPrecedence`
  comparator + `deviationMovedNote` template + `deviationMatchesScope` tail (deduplication), the
  deviation row hoisted out of the schedule ternary, and the manual-move false-attribution fix
  above. The demo branch's fabricated "Actual duration · 2h 18m" row was removed deliberately —
  artboard 5's SCHEDULE has exactly Estimated time / Actual time / Estimated duration (D14).
- Screenshots: 01 fixture layout/no-deviation · 02 moved generated route overview ·
  03 Route information panel with deviation row · 04 fixture-path deviation row ·
  05 unmoved generated route (no deviation row).
