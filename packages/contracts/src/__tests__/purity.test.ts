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
// and the rule a set names a kind and a priority once by.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: [
    "@waste/domain/access/modules",
    "@waste/domain/access/public-slug",
    "@waste/domain/audit/vocabulary",
    "@waste/domain/execution/proof-shapes",
    "@waste/domain/execution/vocabulary",
    "@waste/domain/execution/work-orders",
    "@waste/domain/finance/vocabulary",
    "@waste/domain/imports/vocabulary",
    "@waste/domain/insight/vocabulary",
    "@waste/domain/planning/vocabulary",
    "@waste/domain/registry/vocabulary",
    "@waste/domain/registry/waste-code",
    "@waste/domain/resolution/event-shapes",
    "@waste/domain/resolution/sla",
    "@waste/domain/resolution/vocabulary",
    "@waste/domain/resources/drop-off-points",
    "@waste/domain/resources/vocabulary",
    "@waste/domain/routing/vocabulary",
    "@waste/domain/sorting-guide/search",
    "@waste/domain/sorting-guide/vocabulary",
    "zod",
  ],
  allowedTestImports: ["@waste/tooling/purity"],
})
