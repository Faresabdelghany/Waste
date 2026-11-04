// Whether a vehicle fits the stops it is given (O7 of #290), as the commands
// that put a vehicle and stops together read it: `assign` naming a vehicle
// afresh, a split's new route, a move or a merge onto a route with a planned
// vehicle, Add stop on one, and the Balance day's proposal. The rule is the
// domain's (`firstMisfit`, @waste/domain/resources/fleet-fit): a fraction no
// compartment carries, a container its type does not lift, a stop heavier
// than one trip of its fraction — each a 409 in its sentence, after every 400
// of the command. A route heavier than one payload is not refused: its Plan
// unloads on the way (O15), and the route read says how far over it runs.
//
// The stops judged are the ones that load waste (`loadsWaste`: an emptying, a
// swap, a bulky collection) and are still planned: a delivery's container is
// empty and a repair loads nothing, and a stop done or skipped is not the
// vehicle's to serve. A vehicle's fit is three statements however many are
// asked — the vehicles, their compartments with their fractions, and the
// container types their types lift — and the stops' one; names are read only
// once a sentence needs them.
//
// The statements are `@waste/db/commands/fleet-fit`'s since O26 of #290,
// which the worker's fill-driven emptying reads too; this module re-exports
// them and answers a misfit as the 409.
import type { Tx } from "@waste/db/client"
import { misfitOf } from "@waste/db/commands/fleet-fit"
import type { FitStop } from "@waste/domain/resources/fleet-fit"

import { problem } from "../problem"

export { fitsOf, pickupFitStops, routeFitStops, type FitRow } from "@waste/db/commands/fleet-fit"

/**
 * The vehicle serves the stops (`firstMisfit`): a 409 in the first broken
 * rule's sentence otherwise, `of` naming whose stops they are (`route
 * RC-1042`; absent, the stops alone). A vehicle that is not there is asked
 * nothing: the caller has refused it at its field already.
 */
export async function refuseMisfit(tx: Tx, companyId: string, vehicleId: string, stops: readonly FitStop[], of?: string): Promise<void> {
  const sentence = await misfitOf(tx, companyId, vehicleId, stops, of)
  if (sentence !== undefined) throw problem(409, { detail: sentence })
}
