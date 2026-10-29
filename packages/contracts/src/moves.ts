// A move (#374, #291 C11): a Property changes occupant on a day. The outgoing
// customer's parties at the property end on `on` and the incoming customer
// takes the same roles from it; the outgoing customer's subscriptions at the
// property end on `on` with their placements, and one agreement for the
// incoming customer begins there with the same products, the containers
// carried over so the bins never leave service. A sale is a move: an owner
// change and a tenant change are the same command, and the roles say which.
//
// The body names the day, the two customers, the payer of the incoming
// agreement where it is not the incoming customer, and that agreement's
// number, which the office types as it types any agreement's; a property the
// outgoing customer subscribes at nowhere moves its parties alone, so the
// number is the route's to ask for when it is owed. `dryRun` answers what the
// move would do and writes nothing, the wizard's review step.
//
// `chargesToCredit` is what the move does not do (the owner's decision on
// #374): the outgoing subscriptions' recurring charges whose period crosses
// or follows `on`, invoiced or not as their status says, for the office to
// look at — a charge minted in advance is not repriced by an end that comes
// after it. A termination is to share the rule (#328).
import * as z from "zod"

import { Agreement, Subscription } from "./agreements"
import { BillableEvent } from "./billable-events"
import { Property } from "./customers"
import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Label } from "./text"

export const MoveCreate = z
  .strictObject({
    /** The first day the incoming customer holds the property: the outgoing customer's last day is the day before. */
    on: IsoDate,
    outgoingCustomerId: Id,
    incomingCustomerId: Id,
    /** Who the incoming agreement invoices; absent is the incoming customer. */
    payerCustomerId: Id.optional(),
    /** The incoming agreement's number; owed when the outgoing customer subscribes at the property. */
    agreementNumber: Label.optional(),
    dryRun: z.boolean().default(false).describe("True answers what the move would do and writes nothing."),
  })
  .refine((body) => body.incomingCustomerId !== body.outgoingCustomerId, { message: "A customer does not move into the property they move out of", path: ["incomingCustomerId"] })
export type MoveCreate = z.infer<typeof MoveCreate>

/** One side of a move: the agreement it is under, or none where the property was subscribed at by nobody, and the subscriptions at the property. */
const MoveSide = z.object({
  agreement: Agreement.nullable(),
  subscriptions: z.array(Subscription),
})

export const MoveOutcome = z.object({
  /** True where nothing was written: what the move would do. */
  dryRun: z.boolean(),
  on: IsoDate,
  /** The property with its parties as the move leaves them. */
  property: Property,
  /** The outgoing customer's agreement as it stands after the move — ended on `on` where nothing of it runs elsewhere — and its subscriptions here, ended. */
  outgoing: MoveSide,
  /** The incoming customer's agreement and its subscriptions, from `on`. */
  incoming: MoveSide,
  /** The containers whose placements went on under the incoming subscriptions, without leaving service. */
  containersCarried: z.array(Id),
  /** The outgoing subscriptions' recurring charges whose period crosses or follows `on`, for the office to credit or cancel; their status says which are invoiced. */
  chargesToCredit: z.array(BillableEvent),
})
export type MoveOutcome = z.infer<typeof MoveOutcome>
