// The deployment's connections on the wire (#487): `GET /integrations`, what
// Settings › Integrations shows on the Pilot — the routing provider every
// Plan is fingerprinted by, the address register a Property is looked up in
// (none where the deployment names no register), and whether the proofs'
// Storage is set up. Each is the deployment's own setting, never a tenant's
// row, and none of their keys travels: a name says whose service it is.
// The routing provider's quota is `GET /routing/quota`'s.
import * as z from "zod"

/** A service the deployment calls, by whose it is: `fake`, `openrouteservice`, `dataforsyningen`. */
const Connected = z.object({ provider: z.string().min(1) })

export const Integrations = z.object({
  routing: Connected,
  /** Null where the deployment names no register (ADDRESS_PROVIDER unset): an address is typed. */
  addressRegister: Connected.nullable(),
  /** Whether the deployment holds Storage's key, where a driver's photos and signatures are kept. */
  proofStorage: z.object({ configured: z.boolean() }),
})
export type Integrations = z.infer<typeof Integrations>
