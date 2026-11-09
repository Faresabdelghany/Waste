// What a Billable Event's bodies hold to at the boundary: the office's manual
// event is priced by the resolver, or by the person with a reason, never one
// without the other.

/** What a price of the person's own without a reason, or a reason without a price, is told. */
export const OVERRIDE_WITH_A_REASON = "Give the reason with a price of your own, and neither without the other"

export const overrideWithAReason = (body: { unitPriceMinor?: number; overrideReason?: string }): boolean => (body.unitPriceMinor === undefined) === (body.overrideReason === undefined)
