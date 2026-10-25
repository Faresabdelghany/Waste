// A ticket the office answers with a stop (O3c of #290): a container request
// with a delivery, an overflow with an emptying, a defective container with a
// repair or a swap. The office books the stop on a route naming the ticket it
// serves, and the ticket names the stop (`ticket.booked_pickup_id`), held to
// what the ticket is about — its container, its place — where the ticket names
// them (`stopMismatch`). A ticket booked again names its new stop, and the
// `ticket_booking` ledger keeps every one (#422), so one ticket may hear from
// several stops. The
// stop's completion completes the ticket as serviced, in the completion's own
// request (`servicedBy`), and names a stop booked for it since that is still
// planned, for the office to take off; a stop missed, by the driver, the
// route's end or cancellation or the office, leaves the ticket open with a
// word of what happened (`stopMissed`), for the office to book another unless
// it has; and a stop the office corrects away from completed once it has
// serviced its ticket leaves the ticket as it is, the reopening the office's
// to decide (`correctedAway`).
import type { TicketKind } from "../resolution/vocabulary"
import { SERVICE_NOUNS } from "./services"
import type { OfficeStopService, PickupService } from "./vocabulary"

/** Which services answer each ticket kind a stop answers; no other kind is answered by a stop. */
const ANSWERED_BY = {
  overflow: ["empty"],
  "container-request": ["deliver"],
  "container-defect": ["repair", "swap"],
} as const satisfies Partial<Record<TicketKind, readonly OfficeStopService[]>>

export type StopTicketKind = keyof typeof ANSWERED_BY

/** Whether a stop answers tickets of this kind. */
export const isStopTicketKind = (kind: TicketKind): kind is StopTicketKind => Object.hasOwn(ANSWERED_BY, kind)

/** The services a stop for a ticket of this kind may be booked as; none for a kind no stop answers. */
export const servicesAnswering = (kind: TicketKind): readonly OfficeStopService[] => (isStopTicketKind(kind) ? ANSWERED_BY[kind] : [])

/** A kind or a service with its article: "a container request", "an emptying". */
const withArticle = (noun: string) => `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`
const kindNoun = (kind: TicketKind) => kind.replaceAll("-", " ")
const capitalised = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`

/** What a stop for a ticket its service does not answer is told: what would answer it, or that no stop does. */
export function notAnsweredBy(kind: TicketKind, service: PickupService): string {
  const ticket = capitalised(withArticle(kindNoun(kind)))
  const answers = servicesAnswering(kind)
  if (answers.length === 0) return `${ticket} is not answered by a stop`
  return `${ticket} is answered by ${answers.map((answer) => withArticle(SERVICE_NOUNS[answer])).join(" or ")}, not ${withArticle(SERVICE_NOUNS[service])}`
}

/** Where a ticket or a stop is: its container and its place, null where it names none. */
type At = { containerId: string | null; propertyId: string | null; sharedCollectionPointId: string | null }

/**
 * The first way the stop is not about what its ticket is, at the field that
 * names it; undefined where it is. A ticket's container is the stop's — but a
 * delivery's, which brings another — and a ticket's place is the stop's: a
 * delivery's through its subscription, a container's through its placement,
 * an address-only stop's its own.
 */
export function stopMismatch(ticket: At, stop: At & { service: PickupService }): { path: string; message: string } | undefined {
  if (ticket.containerId !== null && stop.service !== "deliver" && stop.containerId !== ticket.containerId) return { path: "containerId", message: "Name the container the ticket is about" }
  const samePlace = (ticket.propertyId === null || stop.propertyId === ticket.propertyId) && (ticket.sharedCollectionPointId === null || stop.sharedCollectionPointId === ticket.sharedCollectionPointId)
  if (samePlace) return undefined
  if (stop.service === "deliver") return { path: "subscriptionId", message: "Name a subscription at the ticket's place" }
  if (stop.containerId !== null) return { path: "containerId", message: "Name a container at the ticket's place" }
  return { path: ticket.propertyId !== null ? "propertyId" : "sharedCollectionPointId", message: "Collect at the ticket's place" }
}

/** A stop as a ticket's words name it. */
type StopRef = { position: number; route: string }
const stopName = (stop: StopRef) => `stop ${stop.position} of route ${stop.route}`

/** The booking's words on the ticket: which stop answers it, and what it does. */
export const bookedFor = (stop: StopRef & { service: PickupService }): string => `Booked ${stopName(stop)}: ${withArticle(SERVICE_NOUNS[stop.service])}`

/** What a second booking is told while the ticket's booked stop is still planned. */
export const answeredAlready = (ticketLabel: string, stop: StopRef): string => `Ticket ${ticketLabel} is answered by ${stopName(stop)} already; take that stop off first`

/** What a booking for a ticket no longer open is told. */
export const onlyAnOpenTicket = (ticketLabel: string, status: string): string => `Ticket ${ticketLabel} is ${status}; a stop answers an open ticket`

/** The completion's words on the ticket its stop serviced, and the stop booked for it since that is still planned, which the office takes off (#422). */
export const servicedBy = (stop: StopRef, stillBooked?: StopRef): string =>
  stillBooked === undefined ? `Serviced by ${stopName(stop)}` : `Serviced by ${stopName(stop)}. ${capitalised(stopName(stillBooked))} is still booked for this ticket: take it off`

/** What a ticket closed already is told when its stop is done after all. */
export const servedAfterClose = (stop: StopRef & { service: PickupService }): string => `The ${SERVICE_NOUNS[stop.service]} at ${stopName(stop)} was completed after this ticket closed`

/** What a ticket is told when its stop is missed: what happened and why, and, while the ticket is open and waits on this stop, that another stop answers it. */
export function stopMissed(stop: StopRef & { service: PickupService; outcome: "skipped" | "failed"; reason: string; open: boolean }): string {
  const happened = stop.outcome === "failed" ? "failed" : "was skipped"
  const missed = `The ${SERVICE_NOUNS[stop.service]} at ${stopName(stop)} ${happened}: ${stop.reason.replaceAll("-", " ")}.`
  return stop.open ? `${missed} Book another stop to answer this ticket.` : missed
}

/** What a ticket its stop did not service is told when the stop is corrected away from completed: the correction, in the office's words. */
export const stopCorrected = (stop: StopRef & { outcome: "skipped" | "failed"; note: string }): string => `${capitalised(stopName(stop))} was corrected to ${stop.outcome}: ${stop.note.replace(/[.\s]+$/, "")}.`

/** What a serviced ticket is told when its stop is corrected away from completed: the office's words, the reopening the office's to decide. */
export const correctedAway = (stop: StopRef & { service: PickupService; outcome: "skipped" | "failed"; note: string }): string =>
  `${capitalised(stopName(stop))} was corrected to ${stop.outcome} after it serviced this ticket: ${stop.note.replace(/[.\s]+$/, "")}. Reopen the ticket if the ${SERVICE_NOUNS[stop.service]} is still owed.`
