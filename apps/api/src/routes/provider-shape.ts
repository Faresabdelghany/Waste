// The owning provider's shape, once (Issue #101, round A of the review).
// A depot, an unloading station, a vehicle and a driver each name a service
// provider exactly when their ownership (or a driver's employment) says so,
// and each route held that against its stored row in its own lines. The
// refusal has one shape here: the rule is the domain's (`providerShape`,
// @waste/domain/resources/places, which judges a half-seen pair as fine and leaves
// it to the route to merge the stored row in), the path is always
// `serviceProviderId`, and the sentence is the family's, since a depot's and
// a driver's differ. It comes in two doors: `providerShapeIssue` answers the
// field error or nothing, for a caller that holds a row to more than one
// rule and lists every refusal in one 400 (routes/place-rules.ts, the two
// places), and `requireProviderShape` throws it, for a caller with one rule
// to hold (routes/vehicles.ts and routes/drivers.ts, since the closing
// round). Both take the row as the write leaves it — the provider merged onto
// the stored row, `string | null` and never absent — so a raw patch, whose
// provider may be undefined, does not compile.
import type { ProblemFieldError } from "@waste/contracts/problem"
import { providerShape } from "@waste/domain/resources/places"

import { invalidRequest } from "../problem"

/** The provider rule's answer for a row as a write leaves it — `owner` its ownership or employment, `body` its provider — at `serviceProviderId` with the family's sentence; undefined where the row holds. */
export function providerShapeIssue(owner: string, body: { serviceProviderId: string | null }, sentence: string): ProblemFieldError | undefined {
  return providerShape(owner, body) ? undefined : { path: "serviceProviderId", message: sentence }
}

/** Holds a row as a write leaves it to the domain's provider rule, refusing at `serviceProviderId` with the family's sentence: `providerShapeIssue`, thrown. */
export function requireProviderShape(owner: string, body: { serviceProviderId: string | null }, sentence: string): void {
  const issue = providerShapeIssue(owner, body, sentence)
  if (issue !== undefined) throw invalidRequest("body", [issue])
}
