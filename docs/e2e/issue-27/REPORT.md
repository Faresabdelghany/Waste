# Issue #27 E2E — Collection Calendars list: redesigned columns + derived KPI tiles

Date: 2026-08-31 · Route: `/plan?module=calendars` · Spec: docs/new-changes/SPEC.md area J (D12, D13, D22, D28iii)

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| KPI tiles render above the list, derived from real records; changing data changes the tiles | PASS | `calendars-list.png` (Copenhagen scope: Active 1 · "All calendars active"), `calendars-list-all-projects.png` (all projects: Active 1 · "1 Draft", Working-day rules 2), `calendars-after-create.png` (after creating a calendar with 2 holidays and validTo 15 Nov: Upcoming holidays 2 · "Within 60 days", Expiring within 90d 1 · "Earliest: 15 Nov 2026", warning tone) |
| Redesigned columns; Holidays / Next holiday derived from holiday dates + today; no invented customer context | PASS | Headers render `Calendar · Project · Status · Working days · Holidays · Validity · Next holiday (· Updated)`. Central row: Mon–Fri · 11 · 1 Jan – 31 Dec 2026 · 25–26 Dec. Harbor row shows project scope "Harbor Commercial" (D22), Tue/Fri · 0 · 1 Sep 2026 – 31 Aug 2027 · —. Created record's "Create calendar" placeholder value replaced by derived Next holiday ("7 Sep") |
| Plan workspace tab set unchanged | PASS | Tab strip reads Collection deviations · Collection Calendars · Areas & Zones; Vehicle Planning stays in Fleet |
| Glossary Collection Calendar entry corrected | PASS | CONTEXT.md: project-scoped shared calendar; customer/service scoping flagged as future (D22) |
| `npx tsc --noEmit` passes; screenshots | PASS | tsc clean; 571 harness checks across 14 harnesses, incl. 40 in `scripts/collection-calendar-list-harness.ts` |

## Notes

- Tiles compute from the scoped record set the list shows (project scope + soft-delete), not the search-filtered rows — searching narrows the table, not the tiles.
- Month labels are hand-rolled ("Sep", not ICU's en-GB "Sept") so derived copy matches fixture copy deterministically across runtimes.
- The create-flow verification ran in an isolated headless browser profile; its localStorage record does not affect the app's fixtures.
