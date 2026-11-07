// What a warehouse, a depot and an unloading station hold to beside their
// lists (Issue #101): a place a service provider owns names its provider and
// no other does, a yard's opening hours are both times or neither, and a
// station's fractions are a set.

/** What a body whose ownership and provider disagree is told, at the provider. A driver's employment has a sentence of its own (./fleet). */
export const PROVIDER_WITH_PROVIDER_OWNERSHIP = "Name the owning service provider with service-provider ownership and with nothing else"

type Provided = { serviceProviderId?: string | null }

/**
 * The owning provider is named exactly when `owner` says `service-provider`.
 * `owner` is the ownership of a depot or a station, the employment of a
 * driver. A half-seen pair — a patch giving one of the two — is not judged;
 * only the route, which has the stored row, can hold the two together.
 */
export function providerShape(owner: string | undefined, body: Provided): boolean {
  if (owner === undefined || body.serviceProviderId === undefined) return true
  return (owner === "service-provider") === (body.serviceProviderId !== null)
}

/** The same rule as a create body sees it, `owner` being the body's ownership or employment: an absent provider is none. */
export const providerShapeGiven = (owner: string, body: Provided): boolean => providerShape(owner, { serviceProviderId: body.serviceProviderId ?? null })

/** What a body giving one opening time is told, at the closing time. */
export const BOTH_HOURS_OR_NEITHER = "Give both opening and closing time or neither"

/** Both times or neither. A half-seen pair is not judged, which is what a patch gives. */
export function hoursShape(body: { opensAt?: string | null; closesAt?: string | null }): boolean {
  if (body.opensAt === undefined || body.closesAt === undefined) return true
  return (body.opensAt === null) === (body.closesAt === null)
}
