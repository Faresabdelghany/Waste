// An Agreement's subscriptions (Issue #78, #291 slice 10): each delivered at
// one place, a Property or a Shared Collection Point, and changed by a
// replacement that takes another product or another quantity. And the
// customers it names (Issue #79): its holder and its payer are active, since a
// status gates a new reference (`../status-gates`); an agreement of a customer
// that goes inactive runs on.
import { refuseUnless } from "../status-gates"
import { ACTIVE_CUSTOMER_STATUSES, type CustomerStatus } from "./vocabulary"

/** What a subscription naming no place, or both, is told. */
export const ONE_PLACE = "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place"

/** What a change naming neither the product nor the quantity is told. */
export const CHANGE_NAMES_SOMETHING = "Give the product or the quantity the replacement takes"

/** The two fields an agreement names a customer in: as its holder, and as the customer it is billed to. */
export type Party = "customerId" | "payerCustomerId"

/** What an inactive customer is told in each field; the sentence says which, and a payer is a Customer in the glossary's terms. */
const INACTIVE_PARTY: Readonly<Record<Party, string>> = {
  customerId: "The customer is inactive; an agreement needs an active customer",
  payerCustomerId: "The customer named as payer is inactive; an agreement needs an active one",
}

/** A Customer an agreement names, in either field: active, or the conflict for that field. Nothing named is nothing to gate. */
export function refuseInactiveCustomer(status: CustomerStatus | undefined, path: Party): void {
  refuseUnless(status, ACTIVE_CUSTOMER_STATUSES, INACTIVE_PARTY[path])
}
