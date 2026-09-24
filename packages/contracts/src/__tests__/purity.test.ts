// The wire primitives bundle into the browser and run on the server alike, so
// they pass the same gate as packages/domain (see @waste/tooling/purity): zod
// is the one runtime dependency, tests may add Node built-ins and the tooling.
//
// The domain is the other allowed import, by exact subpath: permissions.ts
// turns @waste/domain/access/modules into the enums the API boundary checks
// (Issue #70), and the Registry's modules turn
// @waste/domain/registry/vocabulary into theirs (Issue #78). The direction is
// sound — the innermost ring depends on nothing — and listing the subpath,
// not the package, keeps every further reach into the domain a deliberate
// line here.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { definePurityTests } from "@waste/tooling/purity"

definePurityTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  allowedImports: ["@waste/domain/access/modules", "@waste/domain/registry/vocabulary", "zod"],
  allowedTestImports: ["@waste/tooling/purity"],
})
