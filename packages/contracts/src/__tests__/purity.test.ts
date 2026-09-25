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
// Contracting's (Issue #112), the sixth vocabulary line. The direction is
// sound — the innermost ring depends on nothing — and listing the subpath,
// not the package, keeps every further reach into the domain a deliberate
// line here.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: [
    "@waste/domain/access/modules",
    "@waste/domain/execution/proof-shapes",
    "@waste/domain/execution/vocabulary",
    "@waste/domain/finance/vocabulary",
    "@waste/domain/planning/vocabulary",
    "@waste/domain/registry/vocabulary",
    "@waste/domain/resolution/event-shapes",
    "@waste/domain/resolution/vocabulary",
    "@waste/domain/resources/vocabulary",
    "zod",
  ],
  allowedTestImports: ["@waste/tooling/purity"],
})
