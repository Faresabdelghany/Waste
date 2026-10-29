// The wire primitives bundle into the browser and run on the server alike, so
// they pass the same gate as packages/domain (see @waste/tooling/purity): zod
// is the one runtime dependency, tests may add Node built-ins and the tooling.
//
// The domain is the other allowed import, by exact subpath: permissions.ts
// turns @waste/domain/access/modules into the enums the API boundary checks
// (Issue #70), the Registry's modules turn @waste/domain/registry/vocabulary
// into theirs (Issue #78), planning.ts turns
// @waste/domain/planning/vocabulary into Planning's (Issue #97),
// resources.ts and stock.ts turn @waste/domain/resources/vocabulary into
// Resources' (Issue #101), and execution.ts turns
// @waste/domain/execution/vocabulary into Execution's (Issue #104) while
// proofs.ts runs @waste/domain/execution/proof-shapes as its refine — the one
// reach beyond a vocabulary, since the table of what each proof kind carries
// is a rule the client must hold too and a second spelling here would drift —
// and resolution.ts turns @waste/domain/resolution/vocabulary into
// Resolution's (Issue #109) while tickets.ts runs
// @waste/domain/resolution/event-shapes as its refine for the same reason,
// and finance.ts turns @waste/domain/finance/vocabulary into Finance &
// Contracting's (Issue #112), the sixth `vocabulary` subpath and the ninth
// domain line of the allowlist, and reports.ts turns
// @waste/domain/insight/vocabulary into the reports' interval (#292), and
// imports.ts @waste/domain/imports/vocabulary into the import's kinds and
// outcomes (#291 slice 12). The
// direction is sound — the innermost ring
// depends on nothing — and listing the subpath,
// not the package, keeps every further reach into the domain a deliberate
// line here. Issue #293 added three: organisation.ts reads the public slug's
// shape from @waste/domain/access/public-slug, sorting-guide.ts the Sorting
// Guide's statuses from @waste/domain/sorting-guide/vocabulary and the
// search's `normalise` from @waste/domain/sorting-guide/search, so a synonym
// is "each once" by the spelling the search compares, and drop-off-points.ts
// runs @waste/domain/resources/drop-off-points's opening rules as its refines
// (M3), so a form and the public map judge hours alike. O4 of #290
// added @waste/domain/resolution/sla: ticket-sla.ts reads the longest target
// and the rule a set names a kind and a priority once by. #291 C4 added one:
// finance.ts reads the invoice identity's shapes and the payment terms' range
// from @waste/domain/finance/payment, the patterns the database's checks read
// too. M10 of #293 added @waste/domain/resources/emissions: emissions.ts
// bounds a factor and a consumption by the domain's caps, which the
// database's checks read too. M7 of #293 added
// @waste/domain/registry/applications: applications.ts holds a Decision's
// period and appeal text to the domain's rules in the domain's sentences.
// #291 C6 added @waste/domain/finance/payments: payments.ts reads the
// invoice's payment statuses from it, the reading the API answers.
// M13 of #293 added @waste/domain/insight/sustainability: sustainability.ts
// reads a factor's bound from it, the bound the database's check reads. M14
// of #293 added @waste/domain/finance/hire: catalogue.ts bounds a product's
// free days by its cap and holds them to its unit, which the database reads.
// #291 C7 added @waste/domain/finance/accounting: accounting.ts reads the
// account number's and the VAT code's patterns the database's checks read,
// and the CSV's columns its file is documented by. O11 of #290 added
// @waste/domain/execution/bulky: bulky.ts bounds a booking's items and an
// availability window by the domain's caps. M4 of #293 added
// @waste/domain/visits/vocabulary and @waste/domain/visits/charges:
// site-visits.ts reads the visits' lists and normalises a plate or a card
// as the API stores and matches it. O14 of #290 added
// @waste/domain/execution/shift: shifts.ts holds a window and a shift to the
// domain's rules in the domain's sentences, with the break's bounds.
// O17 of #290 added
// @waste/domain/route-schemes/seasons: route-schemes.ts reads the month-day
// pattern the database's checks read, and the overlap rule of a scheme's
// seasons. O21 of #290 added @waste/domain/planning/lifecycle: route-schemes.ts
// reads the Plan Ahead window's bounds the database's check reads. O8 of
// #290 added @waste/domain/execution/positions: driver-commands.ts bounds a
// `record-positions` by the batch the Driver App closes, one spelling. C13
// of #291 added @waste/domain/registry/address: addresses.ts checks a
// postcode and a municipality code by the shape the domain spells. #474
// added @waste/domain/service-providers/vocabulary: service-provider-activities.ts
// reads an Activity's kinds and statuses. O30 of #290 added
// @waste/domain/resources/stock-balance: stock.ts bounds a warehouse's set of
// Stock Minimums by the domain's cap. C15 of #291 added
// @waste/domain/messaging/vocabulary and @waste/domain/messaging/template:
// messaging.ts reads the channels, purposes and statuses, and refuses a
// template naming a placeholder no message fills, or out of its channel's
// shape, in the domain's sentences. O13 of #290 added
// @waste/domain/resources/pre-trip: pre-trip.ts bounds a checklist and a
// check by the domain's cap. C19 of #291 added
// @waste/domain/privacy/retention and /vocabulary: organisation.ts bounds a
// project's privacy policy by the domain's days and reads its purposes. M22 of #293 added
// @waste/domain/access/branding: organisation.ts holds a project's branding to
// its shapes and its colour to WCAG 2.1 AA's contrast.
// O26 of #290 added @waste/domain/resources/sensors: sensors.ts bounds the
// ingest's batch by the domain's cap and defaults a pairing's threshold to the
// domain's.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: [
    "@waste/domain/access/modules",
    "@waste/domain/access/branding",
    "@waste/domain/access/public-slug",
    "@waste/domain/audit/vocabulary",
    "@waste/domain/execution/bulky",
    "@waste/domain/execution/positions",
    "@waste/domain/execution/proof-shapes",
    "@waste/domain/execution/shift",
    "@waste/domain/execution/unloads",
    "@waste/domain/execution/vocabulary",
    "@waste/domain/execution/work-orders",
    "@waste/domain/execution/workload",
    "@waste/domain/finance/accounting",
    "@waste/domain/finance/hire",
    "@waste/domain/finance/payment",
    "@waste/domain/finance/payments",
    "@waste/domain/finance/vocabulary",
    "@waste/domain/imports/vocabulary",
    "@waste/domain/insight/sustainability",
    "@waste/domain/insight/vocabulary",
    "@waste/domain/messaging/template",
    "@waste/domain/messaging/vocabulary",
    "@waste/domain/planning/lifecycle",
    "@waste/domain/planning/vocabulary",
    "@waste/domain/privacy/retention",
    "@waste/domain/privacy/vocabulary",
    "@waste/domain/registry/address",
    "@waste/domain/registry/applications",
    "@waste/domain/registry/vocabulary",
    "@waste/domain/registry/waste-code",
    "@waste/domain/resolution/event-shapes",
    "@waste/domain/resolution/sla",
    "@waste/domain/resolution/vocabulary",
    "@waste/domain/resources/drop-off-points",
    "@waste/domain/resources/emissions",
    "@waste/domain/resources/pre-trip",
    "@waste/domain/resources/sensors",
    "@waste/domain/resources/stock-balance",
    "@waste/domain/resources/vocabulary",
    "@waste/domain/route-schemes/seasons",
    "@waste/domain/routing/balance",
    "@waste/domain/routing/vocabulary",
    "@waste/domain/service-providers/vocabulary",
    "@waste/domain/sorting-guide/search",
    "@waste/domain/sorting-guide/vocabulary",
    "@waste/domain/visits/charges",
    "@waste/domain/visits/vocabulary",
    "zod",
  ],
  allowedTestImports: ["@waste/tooling/purity"],
})
