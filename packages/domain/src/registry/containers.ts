// A Container's service placement (Issue #78): it serves a subscription, or
// stands for the project at a Shared Collection Point — one of the two — and
// what stands at a place is read on a day.

/** What a placement serving neither, or both, is told. */
export const SERVED_BY_ONE = "Give exactly one of subscriptionId and sharedCollectionPointId: a container serves a subscription, or stands for the project at a Shared Collection Point"

/** What a read of a place's containers naming no day is told. */
export const A_DAY_FOR_A_PLACE = "Give validOn with propertyId or sharedCollectionPointId: what stands at a place is what stands there on a day"
