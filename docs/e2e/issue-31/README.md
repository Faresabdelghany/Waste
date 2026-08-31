# Issue #31 E2E — Quick Create parity

Browser pass on 2026-08-31 against `pnpm dev` (Playwright): one valid and one
invalid Quick Create through Route Studio → Route Schemes → Create route
scheme → Quick create.

Verified:

- **Valid Quick Create** (`issue-31-quick-create-valid.png`): "Quick E2E
  Residual" — Indre By Operations, Copenhagen Central 2026, weekly on Monday,
  effective from 2026-08-31 with **Effective to left empty** (the field no
  longer carries the required asterisk), Residual stop rule. Submit produced
  the wizard's post-create result: toast "Scheduled — 2 routes with 8 pickups
  generated for Mon 31 Aug → Mon 7 Sept. Plan Ahead is on." The scheme detail
  shows derived status **Effective**, Routes 2 / Stops 8, Plan Ahead **On**,
  "Effective period Mon 31 Aug → ongoing" (D23 open-ended), canonical facts
  ("Matched by rule", "Residual — 4 containers currently matched"), and the
  same non-blocking rule-overlap / over-service warnings the wizard raises as
  the live Attention badge.
- **Invalid Quick Create** (`issue-31-quick-create-draft.png`): "Quick E2E
  Zero Match" — same scope but a Wastewater stop rule, which matches zero
  containers in the area. Submit blocked scheduling exactly as the wizard
  would: toast "Route scheme created as Draft — … Saved as Draft — routes
  will not be generated until the blocking issues are resolved. 1 open issue:
  No containers currently match the stop rule." Detail shows status
  **Draft**, the blocking issue listed in the validation callout, Routes 0,
  and Plan Ahead **Off**.

- **Quick-only extras ride along** (post-review rerun, "Quick E2E Extras"):
  a valid quick create with "Container or asset" (BIN-82014), "Route end
  behavior", and "Scheme source" selected persisted them as submittedValues,
  display facts, AND relationRefs — the stored record carries
  `containerId:BIN-82014` in both `relationRefs` and `related`, alongside the
  canonical draft links; status Scheduled with an open-ended effective
  period.

Mechanism under test: `handleFormSubmit`'s scheme branch maps the quick form
values onto the wizard draft (`quickSchemeDraftFromValues`,
`lib/route-schemes/quick-create.ts`) and calls the shared
`createSchemeFromDraft`, so both paths run the same `validateScheme` and
`planSchemeCreation`. Every schema field the draft does not consume is
carried as a quick-only extra (value, fact, relation ref). Headless coverage:
`scripts/route-scheme-validation-harness.ts` (Quick Create parity section).
