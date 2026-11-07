// An Agreement's subscriptions (Issue #78, #291 slice 10): each delivered at
// one place, a Property or a Shared Collection Point, and changed by a
// replacement that takes another product or another quantity.

/** What a subscription naming no place, or both, is told. */
export const ONE_PLACE = "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place"

/** What a change naming neither the product nor the quantity is told. */
export const CHANGE_NAMES_SOMETHING = "Give the product or the quantity the replacement takes"
