// `GET /integrations` (#487): the deployment's connections, for Settings ›
// Integrations on the Pilot — the routing provider, the address register or
// none, and whether the proofs' Storage is set up. Each is read off what the
// composition root injected (server.ts), never a row and never a key; the
// grant is `configure.integrations` `view`, the pane's module. Nothing here
// calls the services themselves: the routing quota is `GET /routing/quota`'s
// reading, and a register's or Storage's silence is told where it is asked.
import { Integrations } from "@waste/contracts/integrations"
import type { ModuleKey } from "@waste/domain/access/modules"
import type { RoutingIdentity } from "@waste/routing/provider"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import type { AddressRegister } from "../address-register/register"
import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem } from "../problem"
import { describeJson } from "./shared"

const MODULE: ModuleKey = "configure.integrations"

export type IntegrationsOptions = {
  routing: RoutingIdentity
  /** Null where the deployment names no register. */
  addressRegister: Pick<AddressRegister, "name"> | null
  /** Whether the deployment holds Storage's key. */
  proofStorage: boolean
}

export function integrationRoutes(guard: MiddlewareHandler<AuthEnv>, { routing, addressRegister, proofStorage }: IntegrationsOptions) {
  return new Hono<AuthEnv>().get(
    "/integrations",
    describeRoute({
      operationId: "getIntegrations",
      summary: "The deployment's connections",
      description:
        "The services this deployment calls, by whose they are: the routing provider every Plan is fingerprinted by, the address register a Property is looked up in (null where the deployment names none, and an address is typed), and whether Storage, where a driver's photos and signatures are kept, is set up. They are the deployment's settings, never a key; the routing provider's quota is `GET /routing/quota`.",
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The deployment's connections.", Integrations),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
      },
    }),
    guard,
    requireGrant(MODULE, "view"),
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
