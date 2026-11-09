// `GET /integrations` (#487): the deployment's connections, for Settings ›
// Integrations on the Pilot — the routing provider, the address register or
// none, and whether the proofs' Storage is set up. Each is read off what the
// composition root injected (server.ts), never a row and never a key; the
// grant is `configure.integrations` `view`, the pane's module. Nothing here
// calls the services themselves: the routing quota is `GET /routing/quota`'s
// reading, and a register's or Storage's silence is told where it is asked.
import { Integrations } from "@waste/contracts/integrations"
import type { ModuleKey } from "@waste/domain/access/modules"
import type { RouteDeps } from "../deps"
import { describeJson, routes } from "../operation"

const MODULE: ModuleKey = "configure.integrations"

export function integrationRoutes(deps: RouteDeps) {
  const { routing, addressRegister } = deps
  const proofStorage = deps.storage !== null
  return routes(deps).get(
    "/integrations",
    {
      operationId: "getIntegrations",
      summary: "The deployment's connections",
      description:
        "The services this deployment calls, by whose they are: the routing provider every Plan is fingerprinted by, the address register a Property is looked up in (null where the deployment names none, and an address is typed), and whether Storage, where a driver's photos and signatures are kept, is set up. They are the deployment's settings, never a key; the routing provider's quota is `GET /routing/quota`.",
      module: MODULE,
      action: "view",
      responses: {
        200: describeJson("The deployment's connections.", Integrations),
      },
    },
    (c) => {
      const answer: Integrations = {
        routing: { provider: routing.name },
        addressRegister: addressRegister === null ? null : { provider: addressRegister.name },
        proofStorage: { configured: proofStorage },
      }
      return c.json(answer)
    },
  )
}
