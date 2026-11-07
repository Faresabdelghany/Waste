// The wire primitives bundle into the browser and run on the server alike, so
// they pass the same gate as packages/domain (see @waste/tooling/purity): zod
// is one runtime dependency, tests may add Node built-ins and the tooling.
//
// The domain is the other, by direction: every value the wire states — a
// closed list, a shape, a bound, a sentence — is the domain's, and this
// package wraps it in zod, so any module of the domain may be read here. The
// domain is gated pure itself, and the direction is sound: the innermost ring
// depends on nothing, and holds typed rules alone — the fixture-mode
// prototype is the web's and the demo tenant @waste/fixtures', neither of
// which this package can name.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: ["@waste/domain/*", "zod"],
  allowedTestImports: ["@waste/tooling/program", "@waste/tooling/purity", "@waste/tooling/wire-values"],
})
