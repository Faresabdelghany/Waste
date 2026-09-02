# Issue #34 E2E — scheme deletion preserves operational history

Browser pass on 2026-09-03 (browser-local date) against `pnpm dev` (Playwright),
fixture scheme `scheme-central-a` ("RS-Central · Week A", Effective, Mon–Fri,
rule-mode). The browser profile's localStorage was backed up before the pass and
restored afterwards, so the fixture scheme is live again.

Setup:

1. The scheme already held 4 Planned December routes from an earlier session.
   Generate routes over the default window (Fri 4 Sept → Thu 10 Sept) added 5
   more — 9 routes / 36 stops (`issue-34-01-before-routes-tab.png`).
2. RC-8713 (Fri 4 Sept) was moved to **Active** through the governed Start
   action (`issue-34-02-route-active-before.png`).
3. Plan Ahead was turned **on** via Actions, so a post-deletion reload could
   prove the auto-run guard.

Verified:

- **Delete dialog** (`issue-34-03-delete-dialog.png`): Actions → Delete scheme
  opens the standard soft-delete dialog (category + structured reason) with the
  scheme-specific consequence line — future planned routes are cancelled and
  kept, executed/active/completed routes and their stops are preserved.
- **Deletion result** (`issue-34-04-deleted-toast-list.png`): confirm returns
  to the Route Schemes list; RS-Central · Week A is gone (8 records remain).
  The stored scheme record carries `Registry visibility: Soft deleted`, the
  category-prefixed reason, `Deleted by: Olivia Larsen`, the `Deletion log
  audit-…` link, `Plan ahead: Off` / `planAhead: false`, and its **stored**
  status `Scheduled` untouched — the detail page's derived `Effective` was not
  frozen into the store.
- **Routes after deletion** (`issue-34-05-routes-list-after.png`, search
  "RS-Central"): the 8 Planned routes (5 September + 4 December) are
  **Cancelled** with "Cancelled by regeneration — Route scheme deleted — future
  planning stopped."; RC-8713 stays **Active**. Record-level check: every
  cancel carries `cancelledByGeneration: true`; the 32 pickups of the cancelled
  routes are **Skipped**; RC-8713's 4 pickups stay **Planned**.
- **Cancelled route detail** (`issue-34-06-cancelled-route-detail.png`):
  RC-7785 shows status Cancelled and Deviation "Route scheme deleted — future
  planning stopped".
- **Preserved route detail** (`issue-34-07-active-route-preserved.png`):
  RC-8713 is intact — In progress, 4 Planned stops with their scheduled times,
  Route scheme "RS-Central · Week A", Scheme version v14.
- **No further planning**: reloading Route Studio (which mounts the Plan Ahead
  runner) with the deleted scheme's flag having been on before deletion wrote
  nothing — still 9 routes (8 Cancelled, 1 Active), no Plan Ahead toast.

Observed, not in scope: a generation-cancelled route's header still offers a
"Start" action (pre-existing for every `cancelledByGeneration` route, e.g. the
issue #33 edit path) — the route detail derives its primary action from the
module lifecycle, not the record's emptied `allowedTransitions`.

Mechanism under test: `commitRecordAction`'s delete branch routes route schemes
through `planSchemeDeletion` (`lib/route-schemes/deletion.ts`), which composes
the shared soft-delete shape (`lib/data/record-visibility.ts`), `setPlanAhead`,
and the engine's shared generation-authored cancel writer
(`cancelSchemeFutureRoutes`, `lib/route-schemes/generation.ts`);
`schemeAutoGenerates` / `schemeCanGenerateRoutes` refuse soft-deleted schemes.
Headless coverage: `scripts/route-scheme-lifecycle-harness.ts` (deletion and
expiry sections), `scripts/route-scheme-generation-harness.ts` (expiry bound),
`scripts/route-scheme-plan-ahead-harness.ts` (soft-deleted eligibility).
