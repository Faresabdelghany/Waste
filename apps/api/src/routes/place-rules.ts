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
// has one sentence wherever it was noticed: the provider through
// `providerShapeIssue` (routes/shared.ts, the one refusal shape the fleet
// shares), and the hours, both collected into one 400 listing every rule the
// patch breaks, the way the validator lists a body's issues, so a client
// mending one is not told about the other on its next try. The route takes
// the row's lock before it reads the row (`lockRow`), since two patches of
// one depot each read and then write and would otherwise both pass; and the
// table's `<table>_provider_shape` and `<table>_hours_shape` checks stand
// behind that through `refuseCheck` (`placeShapeInvalid`), in the same words
// at the same paths, so a check the pre-check somehow did not foresee is a
// 400 and never a 500 with a constraint name in the log.
//
// The point goes in and comes back as GeoJSON through the column type, the
// way a property's does, and `refuseCheck` (routes/shared.ts) stands behind
// `<table>_location_valid` as it stands behind a planning area's polygon:
// SQLSTATE 23514 on that constraint is a 400 on `location`, "Not a valid
// point". For a point the door is a backstop and not a path a body can reach:
// the contracts already refuse an ordinate off the globe and a third ordinate
// by shape (`FlatPoint`), a Point with coordinates is never empty, and PostGIS
// calls every point valid — where a polygon's ring can cross itself past the
// shape rule and only ST_IsValid sees it. It is wired all the same, so a check
// the API did not foresee is a sentence and not a 500 with a constraint name
// in the log.
import { BOTH_HOURS_OR_NEITHER, hoursShape, PROVIDER_WITH_PROVIDER_OWNERSHIP } from "@waste/contracts/places"
import type { ProblemFieldError } from "@waste/contracts/problem"

import { invalidRequest } from "../problem"
import { providerShapeIssue, timeOf, type Refusal } from "./shared"

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
 * Both rules are judged and every refusal listed in the one 400, the provider
 * first, through the one refusal shape the fleet shares, then the hours.
 */
export function requirePlaceShape(current: PlaceShape, patch: PlaceShapePatch): void {
  const merged: PlaceShape = {
    ownership: patch.ownership ?? current.ownership,
    serviceProviderId: patch.serviceProviderId === undefined ? current.serviceProviderId : patch.serviceProviderId,
    opensAt: patch.opensAt === undefined ? current.opensAt : patch.opensAt,
    closesAt: patch.closesAt === undefined ? current.closesAt : patch.closesAt,
  }
  const errors: ProblemFieldError[] = []
  const provider = providerShapeIssue(merged.ownership, merged, PROVIDER_WITH_PROVIDER_OWNERSHIP)
  if (provider !== undefined) errors.push(provider)
  if (!hoursShape(merged)) errors.push({ path: "closesAt", message: BOTH_HOURS_OR_NEITHER })
  if (errors.length > 0) throw invalidRequest("body", errors)
}

/** The tables that carry the two shape checks, as their constraint names are spelled. */
export type PlaceShapeTable = "depot" | "unloading_station"

/**
 * The `refuseCheck` door for a place's `<table>_provider_shape` and
 * `<table>_hours_shape`, in the contracts' words at the contracts' paths: the
 * backstop behind `requirePlaceShape`, so a row the pre-check let through and
 * the table refuses is the same 400 and not a 500.
 */
export const placeShapeInvalid = (table: PlaceShapeTable): Record<string, Refusal> => ({
  [`${table}_provider_shape`]: { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP },
  [`${table}_hours_shape`]: { path: "closesAt", message: BOTH_HOURS_OR_NEITHER },
})

/** A nullable `time` column as the wire spells it: `HH:MM`, or null where no hour was recorded. */
export const hourOf = (value: string | null): string | null => (value === null ? null : timeOf(value))

/** One sentence for whatever PostGIS refuses in a point: the constraint cannot say which of its reasons it was. */
export const NOT_A_VALID_POINT = "Not a valid point"

/** The `refuseCheck` door for a place's `<table>_location_valid`, at the field the body carries the point in. */
export const pointInvalid = (constraint: string, path = "location"): Record<string, Refusal> => ({
  [constraint]: { path, message: NOT_A_VALID_POINT },
})
