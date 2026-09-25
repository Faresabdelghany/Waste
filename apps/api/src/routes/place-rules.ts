// What the three place families share beyond the shape every family has
// (Issue #101, slice 3): the two rules a Depot and an Unloading Station carry
// together, a `time` column on the way to the wire, and the one check only
// the database runs on a point.
//
// The two shape rules are the contracts' (@waste/contracts/places):
// `providerShape` — the owning service provider is named with
// `service-provider` ownership and with nothing else — and `hoursShape`, the
// opening hours are both given or neither. A create body carries the whole
// picture, so the schema settles it; a patch carries a part of it, and the
// contracts judge a patch only where it carries both halves, so the route
// holds the patch against the stored row before the update goes out and
// refuses in the contracts' own words at the contracts' own paths, so one rule
// has one sentence wherever it was noticed. Without that the table's
// `depot_provider_shape` or `depot_hours_shape` check would answer, and a rule
// a client can fix would arrive as a 500.
//
// The point goes in and comes back as GeoJSON through the column type, the
// way a property's does, and `refuseCheck` (routes/shared.ts) stands behind
// `<table>_location_valid` as it stands behind a planning area's polygon:
// SQLSTATE 23514 on that constraint is a 400 on `location`, "Not a valid
// point". For a point the door is a backstop and not a path a body can reach:
// the contracts already refuse an ordinate off the globe by shape, a Point
// with coordinates is never empty, and PostGIS calls every point valid — where
// a polygon's ring can cross itself past the shape rule and only ST_IsValid
// sees it. It is wired all the same, so a check the API did not foresee is a
// sentence and not a 500 with a constraint name in the log.
import { BOTH_HOURS_OR_NEITHER, hoursShape, PROVIDER_WITH_PROVIDER_OWNERSHIP, providerShape } from "@waste/contracts/places"

import { invalidRequest } from "../problem"
import { timeOf, type Refusal } from "./shared"

/** The four columns the two shape rules read, as a stored depot or station carries them. */
export type PlaceShape = {
  ownership: string
  serviceProviderId: string | null
  opensAt: string | null
  closesAt: string | null
}

/** The same four as a patch may carry them: each absent where the body did not name it. */
export type PlaceShapePatch = {
  ownership?: string
  serviceProviderId?: string | null
  opensAt?: string | null
  closesAt?: string | null
}

/**
 * Holds the row a patch leaves behind to the two shape rules, in the
 * contracts' words and at their paths — `serviceProviderId` for the owner,
 * `closesAt` for the hours — so a client reads one answer whichever noticed.
 * Both rules are judged, since a form can fix both at once.
 */
export function requirePlaceShape(current: PlaceShape, patch: PlaceShapePatch): void {
  const merged: PlaceShape = {
    ownership: patch.ownership ?? current.ownership,
    serviceProviderId: patch.serviceProviderId === undefined ? current.serviceProviderId : patch.serviceProviderId,
    opensAt: patch.opensAt === undefined ? current.opensAt : patch.opensAt,
    closesAt: patch.closesAt === undefined ? current.closesAt : patch.closesAt,
  }
  const errors: { path: string; message: string }[] = []
  if (!providerShape(merged.ownership, merged)) errors.push({ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
  if (!hoursShape(merged)) errors.push({ path: "closesAt", message: BOTH_HOURS_OR_NEITHER })
  if (errors.length > 0) throw invalidRequest("body", errors)
}

/** A nullable `time` column as the wire spells it: `HH:MM`, or null where no hour was recorded. */
export const hourOf = (value: string | null): string | null => (value === null ? null : timeOf(value))

/** One sentence for whatever PostGIS refuses in a point: the constraint cannot say which of its reasons it was. */
export const NOT_A_VALID_POINT = "Not a valid point"

/** The `refuseCheck` door for a place's `<table>_location_valid`, at the field the body carries the point in. */
export const pointInvalid = (constraint: string, path = "location"): Record<string, Refusal> => ({
  [constraint]: { path, message: NOT_A_VALID_POINT },
})
