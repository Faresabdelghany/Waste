// Every value the wire states is the domain's — a closed list, a shape, a
// bound, a refusal's sentence, a document's number — read alike by the
// database's checks, the API and the web; a module here wraps it in zod and
// spells none of its own (@waste/tooling/wire-values). The probes' answer
// states the process's state rather than any value of the domain, and stands
// beside the rule.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineWireValueTests } from "@waste/tooling/wire-values"

defineWireValueTests({
  packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  beside: {
    "health.ts": "the probes' answer to a release and a load balancer: the process's state, not the domain's",
  },
})
