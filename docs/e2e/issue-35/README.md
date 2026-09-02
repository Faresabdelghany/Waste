# Issue #35 E2E — scheme edit dialog prefill

Browser pass on 2026-09-03 against `npm run dev` (Playwright), on the two
fixture schemes plus the user-created schemes left over from earlier E2E
passes (wizard rule-mode, wizard per-day rules, quick-created, legacy manual).

## Root causes found

- **Orphan required fields.** `endBehavior` ("Route end behavior") and
  `proposalSource` ("Scheme source") came from the original template
  snapshot: required, no default, never written by Guided Setup or the
  fixtures, read by nothing (no lib, no detail page, no spec). Only Quick
  Create wrote them, because its form forced a pick. Every edit-save of a
  wizard-created or fixture scheme was therefore blocked until the planner
  invented values. A dangling `route-studio.schemes.approvalId` conditional
  override still referenced `proposalSource` for a field removed long ago.
- **Create default leaking over stored records.** The dialog seeds edit values
  as `{ ...schemaDefaults, ...storedValues }`. Legacy manual schemes store no
  `stopSelection` flag (absent means manual — `stopSelectionMode`), so the
  schema default `"rule"` won: the dialog showed "Match containers by rule"
  with an empty required "Waste fractions to match", and a save with fractions
  picked would have silently flipped the scheme's stop source. Same class as
  the issue #32 planned-start-time re-injection. This is the reproducible
  form of the report's "Waste fractions to match" symptom; wizard-created
  rule schemes with `matchFractions` stored did prefill correctly
  ("Issue 28 E2E Weekly" showed "Residual").
- **Quick schema stricter than the domain.** Depot and unloading station were
  required in the quick schema but the wizard never gates on them and neither
  generation nor validation reads them; planning area was required for every
  scheme although the domain needs it only for rule matching.

## Fix

- `seedSchemeEditValues` (`lib/route-schemes/quick-create.ts`) is the single
  scheme edit seed (stop selection via `stopSelectionMode`, retired
  recurrence shapes, planned start time), replacing the inline block in
  `business-workspace.tsx`.
- Schema: `endBehavior` and the "Approval" section removed; depot and
  unloading station optional; planning area `requiredWhen stopSelection =
  rule`. Dangling `approvalId` override removed.
- Edit-save drops the stale "Route end behavior" / "Scheme source" facts
  written before the fields were retired.
- Harness: `scripts/route-scheme-validation-harness.ts` (+14 checks: seed
  semantics and schema shape).

## Verified

- Before: Edit on wizard scheme "Issue 28 E2E Weekly" → Save blocked on
  Collection calendar, Departure depot, Unloading station, Route end
  behavior, Scheme source (`issue-35-01-wizard-scheme-edit-blocked-before.png`).
  Edit on legacy manual `scheme-osterbro-b` → blocked on Operational planning
  area, Departure depot, Unloading station, Waste fractions to match, Route
  end behavior, Scheme source, with Stop selection wrongly showing "Match
  containers by rule".
- After: Edit on `scheme-osterbro-b` opens as "Pick containers manually" with
  the fractions field hidden, no Approval section, planning area / depot /
  unloading station unstarred (`issue-35-02-legacy-manual-edit-after.png`).
  Save succeeds: the record now stores `stopSelection: "manual"`, keeps its
  four `containerIds`, and edit reconciliation ran (`lastGeneratedAt`
  refreshed, Plan Ahead on).
- After: Edit + Save on the per-day-rule wizard scheme "Central weekly plan"
  succeeds with no required errors; `sameAllDays: false` and
  `matchRulesByDay` survive the single-rule quick form untouched, and the
  stale "Route end behavior" / "Scheme source" facts are gone.

Left as-is: the optional `productId` / `containerId` ("Service demand and
stop pattern") fields are equally orphaned but do not block saves; and
edit-save still dumps every quick-form field as a label-keyed fact
("Route scheme name", "Effective from", …) beside the canonical facts —
pre-existing, out of scope here.
