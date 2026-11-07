// A Customer's contacts and a Property's sets (Issue #78, #291 C13–C14, #374):
// a contact is reached on an e-mail or a phone; a Property names its address
// one way, typed or the register's; and each set — the parties, a group's
// members, a point's members — names each of its rows once, as the database's
// key insists.

/** Whether a contact can be written to: an e-mail or a phone, or both. */
export const reachable = (contact: { email?: string | null; phone?: string | null }): boolean => contact.email != null || contact.phone != null

/** What a contact with neither is told. */
export const REACHABLE_ON_A_CHANNEL = "Give an e-mail or a phone: a contact is reached on one at least"

/** What a Property naming its address both ways is told. */
export const ONE_ADDRESS = "Give the address typed, or the address register's addressId, not both"

/** What a Property naming its address neither way is told. */
export const AN_ADDRESS = "Give the address, typed or as the address register's addressId"

/** What a set of parties naming a customer twice in one role is told. */
export const EACH_PARTY_ONCE = "Name each customer once per role: a party is a customer and a role, and the list holds each pair once"

/** What a group's members naming a property twice is told. */
export const EACH_GROUP_MEMBER_ONCE = "Name each property once: a property is a member of the group or it is not, and the role says what kind"

/** What a point's members naming a property twice is told. */
export const EACH_POINT_MEMBER_ONCE = "Name each property once: a property is a member of the point or it is not, and the role says what kind"
