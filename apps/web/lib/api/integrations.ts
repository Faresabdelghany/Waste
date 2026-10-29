// The deployment's connections (#487): `GET /integrations`, which Settings ›
// Integrations reads on the Pilot beside the routing quota and the imports.
// The contract is a type here; a runtime zod import would land in every
// workspace route's bundle.
import type { Integrations } from "@waste/contracts/integrations"

import { get, type ApiClient } from "./client"

/** The routing provider, the address register or none, and whether Storage is set up. */
export function deploymentIntegrations(client: ApiClient): Promise<Integrations> {
  return get<Integrations>(client, "/integrations")
}
