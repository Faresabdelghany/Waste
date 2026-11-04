// The notifications' closed lists (O16 of #290), spelled once for the
// database's CHECK and the contracts' `z.enum`, as the Registry's are
// (registry/vocabulary.ts says why one tuple serves both).

/**
 * What a staff member may be told about by e-mail: an alert raised in a
 * project they work in (at or above the severity they pick), and a ticket
 * assigned to them. Each is the outbox kind of the same name, which the
 * worker's notifications consumer takes. Nothing is sent to anyone who has
 * not opted in (the coordinator's default, pending the owner's review on #351).
 */
export const NOTIFICATION_EVENTS = ["alert-raised", "ticket-assigned"] as const

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

/**
 * What a customer may be told about (O16 of #290, part b): their Bulky
 * Booking booked, cancelled, collected, or not collected — the last two read
 * off its stop's `pickup-completed` and `pickup-failed`. A project sends one
 * only where a notification rule maps it to a message template; nothing has
 * a default text (the coordinator's default, pending the owner's review on
 * #351). C18 adds its notices here, rows of the same rules.
 */
export const CUSTOMER_NOTICE_EVENTS = ["bulky-booking-booked", "bulky-booking-cancelled", "bulky-booking-collected", "bulky-booking-not-collected"] as const

export type CustomerNoticeEvent = (typeof CUSTOMER_NOTICE_EVENTS)[number]

/** Every list of this module by its name. */
export const NOTIFICATIONS_VOCABULARIES = { NOTIFICATION_EVENTS, CUSTOMER_NOTICE_EVENTS } as const satisfies Record<string, readonly [string, ...string[]]>
