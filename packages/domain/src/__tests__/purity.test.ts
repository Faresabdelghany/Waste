// ADR-0002 made mechanical: everything under packages/domain/src is pure,
// deterministic logic that bundles into the browser and runs on the server
// alike. The gate lives in @waste/tooling/purity; this package depends on
// nothing, so no package is allowed in shipping code, and its tests may add
// only Node built-ins and the tooling itself. Allowances stay empty on purpose.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedTestPackages: ["@waste/tooling"],
})
