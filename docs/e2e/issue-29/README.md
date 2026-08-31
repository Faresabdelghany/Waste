# Issue #29 E2E — scheme detail full page

Browser pass on 2026-08-31 against `pnpm dev` (Playwright), scheme
`scheme-central-a` (Effective, rule-mode) plus a seeded Draft scheme whose
stop rule matched zero containers (removed after the pass).

Verified:

- `?module=schemes&record=` opens the full page with Details / Routes /
  Stops / Collection Calendar tabs; derived status + live Attention badge in
  the header; Actions → Edit scheme opens the prefilled edit dialog.
- Details tab renders the five cards from canonical scheme/related data
  (`issue-29-details-tab.png`).
- Routes tab lists generated routes `Service date | Route ID | Status |
  Stops | Vehicle | Driver`; the 24 Dec holiday route shows its actual date
  Sun 27 Dec with "Moved from Thu 24 Dec · Public holiday"
  (`issue-29-routes-tab.png`).
- Stops tab lists the generated Stops with route/date filters; filtering to
  Sun 27 Dec shows exactly that route's 4 stops (`issue-29-stops-tab.png`).
- Collection Calendar tab is read-only and "Open in Plan" lands on
  `/plan?module=calendars&record=calendar-central`
  (`issue-29-calendar-tab.png`).
- Draft scheme: Details leads with the blocking-issues callout ("No
  containers currently match the stop rule") and Resolve via Edit; Generate
  routes is disabled with the blocked explanation; Routes and Stops tabs show
  the blocked empty states (`issue-29-draft-blocked-details.png`,
  `issue-29-draft-blocked-routes.png`, `issue-29-draft-blocked-stops.png`).
