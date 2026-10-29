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

/** Every list of this module by its name. */
export const NOTIFICATIONS_VOCABULARIES = { NOTIFICATION_EVENTS } as const satisfies Record<string, readonly [string, ...string[]]>
