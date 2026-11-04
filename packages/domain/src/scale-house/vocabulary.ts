// The scale house's closed lists (M16a of #293, #404): a scale ticket's
// standing, whom it is for, where its tare came from and why it was voided,
// and a registered tare's standing. Like every context's lists, the database
// reads each into its `CHECK` (`oneOf`, packages/db/src/schema/checks.ts) and
// the contracts into a `z.enum`, so the two cannot drift.
//
// `SCALE_TICKET_STATUSES` is a ticket weighed in and waiting for its second
// pass, completed with its tare and its lines, or voided — never deleted, since
// a ticket is what the customer was handed. `SCALE_TICKET_PARTIES` is an
// account customer, charged under an agreement, or a walk-in paying at the
// window. `TARE_SOURCES` is a second pass over the scale or the register's
// tare for the vehicle.

/** A ticket's standing: weighed in, completed with its tare and lines, or voided. */
export const SCALE_TICKET_STATUSES = ["open", "completed", "voided"] as const
/** Whom a ticket is for: an account customer under an agreement, or a walk-in paying at the window. */
export const SCALE_TICKET_PARTIES = ["account", "cash"] as const
/** Where a ticket's tare came from: a second pass over the scale, or the vehicle's registered tare. */
export const TARE_SOURCES = ["weighed", "registered"] as const
/** Why a ticket was voided: written in error, a duplicate of another, the visitor left before the second pass, or another reason the note gives. */
export const SCALE_TICKET_VOID_REASONS = ["entered-in-error", "duplicate", "visitor-left", "other"] as const
/** A registered tare's standing: in use, or retired when the vehicle, trailer or container is no longer weighed by it. */
export const VEHICLE_TARE_STATUSES = ["active", "retired"] as const

export type ScaleTicketStatus = (typeof SCALE_TICKET_STATUSES)[number]
export type ScaleTicketParty = (typeof SCALE_TICKET_PARTIES)[number]
export type TareSource = (typeof TARE_SOURCES)[number]
export type ScaleTicketVoidReason = (typeof SCALE_TICKET_VOID_REASONS)[number]
export type VehicleTareStatus = (typeof VEHICLE_TARE_STATUSES)[number]

/** Every list of this module by its name, for the test that walks them. */
export const SCALE_HOUSE_VOCABULARIES = {
  SCALE_TICKET_STATUSES,
  SCALE_TICKET_PARTIES,
  TARE_SOURCES,
  SCALE_TICKET_VOID_REASONS,
  VEHICLE_TARE_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
