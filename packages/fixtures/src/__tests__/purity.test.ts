// The demo tenant bundles into the browser and runs in the seed alike, so it
// passes the gate packages/domain does (see @waste/tooling/purity), with the
// domain as its one dependency: the fixtures are spelled in the domain's
// vocabulary and placed by its geometry, and nothing else.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: ["@waste/domain/*"],
  allowedTestImports: ["@waste/tooling/purity"],
})
