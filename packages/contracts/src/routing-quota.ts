// The routing quota on the wire (#171, decided on #132 §5): what the quota
// engine last knew of each request family of the provider this deployment
// routes with — the provider's reading (`x-ratelimit-remaining`, its limit,
// its reset) and since when the family is exhausted or its key refused — as
// `GET /routing/quota` answers it for the office's banner in Route Studio
// and the guided setup's footer. A route's own waiting is read off its
// active Plan (`deferredUntil`), never joined to this. The families are the
// domain's tuple, the one the database's CHECK reads.
import * as z from "zod"

import { ROUTING_QUOTA_FAMILIES } from "@waste/domain/routing/vocabulary"

import { IsoDateTime } from "./dates"
import { NonNegativeInt } from "./resource"

export const RoutingQuotaFamily = z.enum(ROUTING_QUOTA_FAMILIES)
export type RoutingQuotaFamily = z.infer<typeof RoutingQuotaFamily>

/** One family's reading; nulls where the provider enforces no limit (the fake) or named none. */
export const RoutingQuotaReading = z.object({
  family: RoutingQuotaFamily,
  remaining: NonNegativeInt.nullable(),
  limit: NonNegativeInt.nullable(),
  /** When the provider's daily window resets. */
  resetAt: IsoDateTime.nullable(),
  /** Since when the day's quota is spent; jobs of the family wait for `resetAt`. */
  exhaustedAt: IsoDateTime.nullable(),
  /** Since when the provider refuses the key: "Routing unavailable: key refused". */
  keyRefusedAt: IsoDateTime.nullable(),
  /** When the reading was last written. */
  updatedAt: IsoDateTime,
})
export type RoutingQuotaReading = z.infer<typeof RoutingQuotaReading>

export const RoutingQuota = z.object({
  /** The provider this deployment routes with, whose readings these are. */
  provider: z.string().min(1),
  /** One per family the provider has been asked of, in the vocabulary's order; none before the first call. */
  families: z.array(RoutingQuotaReading),
})
export type RoutingQuota = z.infer<typeof RoutingQuota>
