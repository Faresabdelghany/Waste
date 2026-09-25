// Resolution's closed lists at the API boundary (Issue #109): each of
// @waste/domain/resolution/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because two modules
// read them — `tickets.ts` the ticket's seven, `alerts.ts` the alert's four —
// and a list spelled in one place is a list that cannot drift between them.
//
// Two things beside the enums are the context's presentation on the wire,
// the `execution.ts` precedent. The ticket's display number is `T-8831`: the
// database stores `number: 8831` from the company's counter, the prefix is
// presentation and spelled once here as `TICKET_NUMBER_PREFIX`, and
// `ticketLabel` is the one way a number becomes the label a `Ticket` carries
// and every sentence names ("Ticket T-8831 is completed; reopen it first").
// And a comment's attachment is a Storage object under an agreed key,
// `<companyId>/<ticketId>/<objectId>.<ext>` in the bucket `ticket-attachments`
// (#109 §7.23, as corrected at integration): `<objectId>` is a UUID the
// client mints for the object before uploading it — as specified, the key had
// to name the comment's event id, which the server mints, so no client could
// ever have posted a matching key — and `TicketObjectKey` holds a key to that
// shape here, where a wrong shape is a 400 naming the field, while the API
// holds the first two segments to the row's own company and ticket, since
// only it knows which the key must name. It is `ObjectKey`'s path — `execution.ts`'s `objectKeyPattern`, the
// one spelling of three UUIDs and a format — over one format more, `pdf`,
// since a customer's letter is a document and not a photo, and a schema of
// its own because a ticket's object is not a proof's: the two buckets have
// two policies, and a key of the one must not parse as a key of the other.
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_SOURCES, ALERT_STATUSES, TICKET_EVENT_KINDS, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_STATUSES, TICKET_VISIBILITIES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { objectKeyPattern } from "./execution"

/** Where a Ticket stands. */
export const TicketStatus = z.enum(TICKET_STATUSES)
export type TicketStatus = z.infer<typeof TicketStatus>

/** What kind of case a Ticket is. */
export const TicketKind = z.enum(TICKET_KINDS)
export type TicketKind = z.infer<typeof TicketKind>

/** How urgent. */
export const TicketPriority = z.enum(TICKET_PRIORITIES)
export type TicketPriority = z.infer<typeof TicketPriority>

/** Where a Ticket came from; `driver-app` and `dispatch` are the consumer's and no create body's. */
export const TicketSource = z.enum(TICKET_SOURCES)
export type TicketSource = z.infer<typeof TicketSource>

/** What a completed Ticket ended in. */
export const TicketResolution = z.enum(TICKET_RESOLUTIONS)
export type TicketResolution = z.infer<typeof TicketResolution>

/** What a row of a Ticket's history is. */
export const TicketEventKind = z.enum(TICKET_EVENT_KINDS)
export type TicketEventKind = z.infer<typeof TicketEventKind>

/** Who may read a comment. */
export const TicketVisibility = z.enum(TICKET_VISIBILITIES)
export type TicketVisibility = z.infer<typeof TicketVisibility>

/** What an Alert is about. */
export const AlertKind = z.enum(ALERT_KINDS)
export type AlertKind = z.infer<typeof AlertKind>

/** How severe an Alert is. */
export const AlertSeverity = z.enum(ALERT_SEVERITIES)
export type AlertSeverity = z.infer<typeof AlertSeverity>

/** Who raised an Alert; the API writes `manual` and no body says otherwise. */
export const AlertSource = z.enum(ALERT_SOURCES)
export type AlertSource = z.infer<typeof AlertSource>

/** Where an Alert stands. */
export const AlertStatus = z.enum(ALERT_STATUSES)
export type AlertStatus = z.infer<typeof AlertStatus>

/** The prefix a ticket's number is shown with: `T-8831`. Presentation, spelled once. */
export const TICKET_NUMBER_PREFIX = "T-"

/** The label a ticket is named by, from the number the database stores. */
export const ticketLabel = (number: number): string => `${TICKET_NUMBER_PREFIX}${number}`

/** The formats a ticket's attachment may be: the four image formats a proof's object may be, and a document. */
export const TICKET_OBJECT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf"] as const

/** The shape of an attachment's key: `<companyId>/<ticketId>/<objectId>.<ext>`, three lowercase UUIDs and one of the five formats — a proof's path over a ticket's formats. */
export const TICKET_OBJECT_KEY = objectKeyPattern(TICKET_OBJECT_EXTENSIONS)

/** What a key of another shape is told. */
export const TICKET_OBJECT_KEY_SHAPE = "An attachment key is <companyId>/<ticketId>/<objectId>.<jpg|jpeg|png|webp|pdf>"

/** An attachment's Storage key, held to its shape; which company and ticket it must name is the comment route's rule, and the object's id is the client's. */
export const TicketObjectKey = z.string().regex(TICKET_OBJECT_KEY, TICKET_OBJECT_KEY_SHAPE)
export type TicketObjectKey = z.infer<typeof TicketObjectKey>
