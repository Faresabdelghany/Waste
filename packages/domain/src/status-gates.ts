// A status gates a new reference and never an existing one (Issue #79).
//
// A record that is not effective-dated carries a status — a Customer active or
// inactive, a Product draft, active or inactive, a Shared Collection Point
// draft, open, restricted or closed, a vehicle in service or retired — and a
// body that names one afresh is making a new reference, which the row has to
// be in a state to take: a Customer active to hold or be billed for an
// agreement, a Product offered to be subscribed to, a place served to be
// delivered at, a vehicle in service to be planned with. A reference already
// made stands whatever the row does afterwards, and a row's own status never
// blocks a write to the row itself; a patch that re-states the id a record
// already carries names nothing new. An Application names a customer, a place
// and a subscription to say whom and what a request is about, not to hold,
// bill or serve anything, so no status gates it: an inactive customer's fee
// correction is exactly what one is for. Each vocabulary names the statuses that
// take a new reference (`OFFERED_PRODUCT_STATUSES`, `SERVING_POINT_STATUSES`,
// `LIVE_ALLOCATION_STATUSES`, …) beside its tuple, so the API's gate, a
// statement both processes run and the web's picker read one list.
//
// The refusal is a conflict, not an invalid value: the id is right and the row
// is there, and what refuses is the state it is in. Its sentence names the
// status the row has and the state the reference needs, and is the family's
// own, spelled beside the family's rules. A caller runs every refusal of a
// value first and these after, so a body that is wrong is told so before a
// state it did not choose. No lock is taken for the rule, since it has one
// side: a status change never looks at what references the row, and a
// reference made the instant before is an existing one, and stands.
import { isOneOf } from "./lists"
import { Refused } from "./refusal"

/** Whether a row in `status` takes a new reference: its status is one of the vocabulary's that do. */
export const takesReference: <Status extends string, Taking extends Status>(status: Status, taking: readonly Taking[]) => status is Taking = isOneOf

/**
 * A row a new reference names: in a status that takes one, or a conflict with
 * the family's sentence, which may name the status the row has. Nothing named
 * is nothing to gate.
 */
export function refuseUnless<Status extends string, Taking extends Status>(status: Status | undefined, taking: readonly Taking[], sentence: string | ((status: Exclude<Status, Taking>) => string)): void {
  if (status === undefined || takesReference(status, taking)) return
  throw Refused.conflict(typeof sentence === "string" ? sentence : sentence(status as Exclude<Status, Taking>))
}
