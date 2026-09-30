// What is known of a request family's quota (#132 §5): the provider's own
// reading off its `x-ratelimit-*` headers, and since when the family is
// exhausted or its key refused. The quota engine (@waste/routing/quota)
// holds it per family with the instant it learned it; the `routing_quota`
// row (@waste/db/commands/routing-quota) stores it with the instant it was
// written; the one shape is spelled here, so the two convert by spreading
// and a new field reaches both.

export type RoutingQuotaStanding = {
  /** The provider's `x-ratelimit-remaining`; null where it enforces none (the fake) or said nothing. */
  remaining: number | null
  /** Its `x-ratelimit-limit`. */
  limit: number | null
  /** When its daily window resets. */
  resetAt: Date | null
  /** Since when the day's quota is spent: a quota 403; cleared by the next answer. */
  exhaustedAt: Date | null
  /** Since when the provider refuses the key: a 401, or a 403 without the headers; cleared by the next answer. */
  keyRefusedAt: Date | null
}
