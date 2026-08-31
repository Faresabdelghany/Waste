# Issue #30 E2E — schemes list derived columns

Browser pass on 2026-08-31 against `pnpm dev` (Playwright), on the two
fixture schemes plus three user-created schemes left over from earlier E2E
passes (a useful spread: rule-mode, manual-mode, Draft-blocked, and one with
no linked calendar).

Verified:

- The schemes table renders the artboard-1 columns (D15): `Route scheme
  (name + description sub-line) | Project · service days | Status |
  Recurrence | Collection calendar` (`issue-30-route-studio-schemes.png`).
- Row context derives from stored data at render time: `scheme-central-a`
  shows "Indre By Operations · Mon–Fri" (its planning area's real name, not
  the fixture's "Copenhagen Central · Mon–Fri" display copy);
  `scheme-osterbro-b` (manual mode, no planning area) falls back to its
  project scope, "Copenhagen Central · Tue/Thu". The artifact's truncated
  "Copenhagen Central · By Operations" copy bug is not reproduced.
- Recurrence derives from configuration, never a stored display string:
  editing "Central weekly plan" from Every week to Every 2 weeks (odd ISO
  weeks) changed the cell on save with no display field involved
  (`issue-30-recurrence-derived-after-edit.png`).
- Status column shows the canonical derived status (`effectiveSchemeStatus`:
  Draft / Validated / Effective across the five rows) with the amber
  Attention overlay badge on schemes with live warnings — Attention is never
  a status value.
- Collection calendar resolves the linked calendar record's live name;
  a scheme without `calendarId` renders "—".

Workspace note: the columns are applied to the shared `schemes` module
definition (owned by the `plan` workspace definition, required into Route
Studio), so every workspace that renders the module gets the identical
table. The registered Plan workspace deliberately does not list schemes —
its tabs stay Collection Deviations · Collection Calendars · Areas & Zones
per SPEC area J / PLAN_SIMPLIFICATION (`issue-30-plan-workspace-tabs.png`),
so Route Studio is the one live schemes list surface.

Known pre-existing gap (not #30): the edit dialog does not prefill
`Waste fractions to match`, `Route end behavior`, or `Scheme source` for
wizard-created schemes, and legacy fixture schemes miss more required
fields than that — saving an edit requires re-selecting them.
