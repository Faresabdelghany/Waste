// Resolution's closed lists at the API boundary (Issue #109): each of
// @waste/domain/resolution/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because several
// modules read them, and a list spelled in one place is a list that cannot
// drift between them.
//
// A comment's attachment is a Storage object under an agreed key,
// `<companyId>/<ticketId>/<objectId>.<ext>` in the bucket `ticket-attachments`
// (#109 §7.23, as corrected at integration): `<objectId>` is a UUID the
// client mints for the object before uploading it — as specified, the key had
// to name the comment's event id, which the server mints, so no client could
// ever have posted a matching key — and `TicketObjectKey` holds a key to that
// shape here, where a wrong shape is a 400 naming the field, while the API
// holds the first two segments to the row's own company and ticket, since
// only it knows which the key must name. It is a proof's path over one format
// more, `pdf`, since a customer's letter is a document and not a photo
// (@waste/domain/storage-objects), and a schema of its own because a ticket's
// object is not a proof's: the two buckets have two policies, and a key of
// the one must not parse as a key of the other.
import { ALERT_KINDS, ALERT_RULES, ALERT_SEVERITIES, ALERT_SOURCES, ALERT_STATUSES, TICKET_EVENT_KINDS, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_STATUSES, TICKET_VISIBILITIES } from "@waste/domain/resolution/vocabulary"
import { ATTACHMENT_KEY_PATTERN, ATTACHMENT_KEY_SHAPE } from "@waste/domain/storage-objects"
import * as z from "zod"

export const TicketStatus = z.enum(TICKET_STATUSES)
export type TicketStatus = z.infer<typeof TicketStatus>

export const TicketKind = z.enum(TICKET_KINDS)
export type TicketKind = z.infer<typeof TicketKind>

export const TicketPriority = z.enum(TICKET_PRIORITIES)
export type TicketPriority = z.infer<typeof TicketPriority>

/** Where a Ticket came from; `driver-app` and `dispatch` are the consumer's and no create body's. */
export const TicketSource = z.enum(TICKET_SOURCES)
export type TicketSource = z.infer<typeof TicketSource>

/** What a completed Ticket ended in. */
export const TicketResolution = z.enum(TICKET_RESOLUTIONS)
export type TicketResolution = z.infer<typeof TicketResolution>

export const TicketEventKind = z.enum(TICKET_EVENT_KINDS)
export type TicketEventKind = z.infer<typeof TicketEventKind>

/** Who may read a comment. */
export const TicketVisibility = z.enum(TICKET_VISIBILITIES)
export type TicketVisibility = z.infer<typeof TicketVisibility>

export const AlertKind = z.enum(ALERT_KINDS)
export type AlertKind = z.infer<typeof AlertKind>

export const AlertSeverity = z.enum(ALERT_SEVERITIES)
export type AlertSeverity = z.infer<typeof AlertSeverity>

/** Who raised an Alert: the API writes `manual` and no body says otherwise; the worker's rules write `rule` and `execution` (O4 of #290). */
export const AlertSource = z.enum(ALERT_SOURCES)
export type AlertSource = z.infer<typeof AlertSource>

export const AlertStatus = z.enum(ALERT_STATUSES)
export type AlertStatus = z.infer<typeof AlertStatus>

/** The worker's rule an Alert was raised by (O4 of #290). */
export const AlertRule = z.enum(ALERT_RULES)
export type AlertRule = z.infer<typeof AlertRule>

/** An attachment's Storage key, held to its shape; which company and ticket it must name is the comment route's rule, and the object's id is the client's. */
export const TicketObjectKey = z.string().regex(new RegExp(ATTACHMENT_KEY_PATTERN), ATTACHMENT_KEY_SHAPE)
export type TicketObjectKey = z.infer<typeof TicketObjectKey>
