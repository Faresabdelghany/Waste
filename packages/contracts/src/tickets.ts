// The Ticket on the wire (Issue #109): "a case that owns the resolution of a
// request, deviation, complaint, task, or operational issue" (CONTEXT.md),
// with its appended history. A ticket carries its display `number` with the
// `label` a person reads (`T-8831`, `ticketLabel`; the two held together at
// `label` as a route's are), its kind, status, priority and source, the
// case's own words, when it happened and when it is due, who works it, who
// opened it — a person (`createdBy`) or an outbox event (`sourceEventId`),
// never both — what it is about (`links`, nine ids the database checks, any,
// several or none: an internal task is a ticket about nothing but itself),
// and the three closing columns `reopen` clears. `TicketDetail` is the ticket
// with its history in recording order and the alerts naming it.
//
// The writes (#109 §3). `TicketCreate` opens a case from the office's doors —
// `source` defaults to `office` and may never be `driver-app` or `dispatch`,
// which are the consumer's — and may name what it is about, the pickup with
// its route (`pickupWithItsRoute`, at `links.pickupId`), the assignee and the
// alert it answers; `occurredAt` defaults to the request's clock. `TicketPatch`
// moves the case's own fields and nothing the machine or the assignment owns:
// never `status`, `assigneeUserAccountId`, `source`, `projectId`, `number`,
// `resolution` or the stamps; the pickup rule is held here where both halves
// are in the body and by the route against the stored row where only one is.
// Then the seven commands, each a body and no more: `assign` (an account or
// null, with a note), `start` (a note if any), `wait` and `hold` (a note,
// since waiting says for what), `complete` (the resolution, the note, and the
// re-collection's route with `recollected` alone —
// `recollectionRouteWithRecollected` — and, beside it, the stop of that route
// the re-collection is, where the office added one: `recollectionPickupId`,
// #111, never without its route), `reject` (the reason), `reopen` (the
// note). A comment is appended, never a change: `TicketComment` carries the
// body, who may read it (`internal` unless said) and an attachment's key.
//
// `TicketEvent` is a history row — `recorded`, never `updatedAt` — a snapshot
// of the status and the assignee after the event, and it runs the domain's
// `ticketEventShape` as a refine at `kind`
// (@waste/domain/resolution/event-shapes, the `ProofOfService` precedent), so
// a row that disagrees with its kind does not parse on the client either.
import { ticketEventShapeIssue } from "@waste/domain/resolution/event-shapes"
import { BILLABLE_RESOLUTIONS } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Alert } from "./alerts"
import { IsoDate, IsoDateTime } from "./dates"
import { ExecutionSource, ObjectKey, PickupOutcome, PickupReason, PickupService, PickupStatus, ProofKind } from "./execution"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { ticketLabel, TicketEventKind, TicketKind, TicketObjectKey, TicketPriority, TicketResolution, TicketSource, TicketStatus, TicketVisibility } from "./resolution"
import { changesSomething, PositiveInt, recorded, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

/** What a ticket is about: nine ids the database checks, each null where the ticket names none. */
export const TicketLinks = z.object({
  routeId: Id.nullable(),
  /** A pickup of the route the ticket names. */
  pickupId: Id.nullable(),
  containerId: Id.nullable(),
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  customerId: Id.nullable(),
  agreementId: Id.nullable(),
  driverId: Id.nullable(),
  /** The parent case; never the ticket itself. */
  parentTicketId: Id.nullable(),
})
export type TicketLinks = z.infer<typeof TicketLinks>

/** What a ticket whose label is not its number is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the ticket prefix"
export const labelIsTheNumber = { message: LABEL_IS_THE_NUMBER, path: ["label"] }

/** The label is the number's. */
export const labelMatches = (value: { number: number; label: string }): boolean => value.label === ticketLabel(value.number)

/** A ticket's fields, spelled once for the two resources that carry them; each refines `labelMatches` again, since spreading takes the fields and not the rule. */
export const ticketFields = {
  ...stamped,
  projectId: Id,
  /** The display number; `label` is it under the prefix. */
  number: PositiveInt,
  label: z.string().min(1),
  kind: TicketKind,
  status: TicketStatus,
  priority: TicketPriority,
  /** Provenance; never patched. */
  source: TicketSource,
  subject: Label,
  description: Paragraph,
  /** When the issue or request happened. */
  occurredAt: IsoDateTime,
  /** The due date: the opener's, or the project's SLA target of the kind and priority from `occurredAt` (O4 of #290); null for neither. */
  dueAt: IsoDateTime.nullable(),
  /** Who works it; null is unassigned. */
  assigneeUserAccountId: Id.nullable(),
  /** The person who opened it, or null for the consumer's ticket. */
  createdBy: Id.nullable(),
  /** The outbox event the consumer made it from, or null for a person's. */
  sourceEventId: Id.nullable(),
  links: TicketLinks,
  /** What a completed ticket ended in; null otherwise. */
  resolution: TicketResolution.nullable(),
  /** The route the re-collection rides on, with `recollected`. */
  recollectionRouteId: Id.nullable(),
  /**
   * The stop of that route the re-collection is (#111), where the completion
   * named one; null otherwise. On every answer; absent on an event the outbox
   * took before #111, when no completion could name one, so it reads as null
   * and never as a dead letter.
   */
  recollectionPickupId: Id.nullable().default(null),
  /**
   * The product its completion charges (#291 C3), where the completion named
   * one; null otherwise, the project's charge for the ticket's kind standing in.
   * Absent on an event the outbox took before #291 C3, and read as null.
   */
  chargeProductId: Id.nullable().default(null),
  /** When the ticket was completed or rejected; null while open. */
  closedAt: IsoDateTime.nullable(),
  /**
   * The stop the office booked to answer the ticket (O3c of #290) — a
   * container request's delivery, an overflow's emptying, a defect's repair or
   * swap — its route and its pickup, both or neither: the latest booking, a
   * missed one's story being in the comments. Absent on an event the outbox
   * took before O3c, read as none.
   */
  bookedRouteId: Id.nullable().default(null),
  bookedPickupId: Id.nullable().default(null),
}

export const Ticket = z.object(ticketFields).refine(labelMatches, labelIsTheNumber)
export type Ticket = z.infer<typeof Ticket>

export const TicketEvent = z
  .object({
    ...recorded,
    projectId: Id,
    ticketId: Id,
    kind: TicketEventKind,
    /** The ticket's status after the event: a snapshot, so the history reads without the row. */
    status: TicketStatus,
    /** The assignee after the event, likewise. */
    assigneeUserAccountId: Id.nullable(),
    /** On a status change to completed: what the ticket ended in. */
    resolution: TicketResolution.nullable(),
    /** The comment, the note a command carried, the reason a rejection gave. */
    body: Paragraph.nullable(),
    /** Who may read it: `customer` on a comment the customer may read. */
    visibility: TicketVisibility,
    /** An attachment's Storage key, on a comment. */
    objectKey: TicketObjectKey.nullable(),
    /** The outbox event a consumer's comment came from. */
    sourceEventId: Id.nullable(),
    /** The caller, or null for the consumer's rows. */
    recordedBy: Id.nullable(),
  })
  .superRefine((row, context) => {
    const issue = ticketEventShapeIssue(row.kind, row)
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue, path: ["kind"] })
  })
export type TicketEvent = z.infer<typeof TicketEvent>

/** A ticket with its history in recording order and the alerts naming it. */
export const TicketDetail = z
  .object({
    ...ticketFields,
    /** Oldest first. */
    events: z.array(TicketEvent),
    /** The alerts linked to this ticket. */
    alerts: z.array(Alert),
  })
  .refine(labelMatches, labelIsTheNumber)
export type TicketDetail = z.infer<typeof TicketDetail>

/** What a body naming a pickup without its route is told. */
export const PICKUP_WITH_ITS_ROUTE = "Name the pickup's route with the pickup"
const pickupWithItsRouteAt = { message: PICKUP_WITH_ITS_ROUTE, path: ["links", "pickupId"] }

/** A pickup names its route: the table's `ticket_pickup_shape`, at the boundary, over a body that carries the whole picture. */
export const pickupWithItsRoute = (links: { routeId?: string | null; pickupId?: string | null } | undefined): boolean => links === undefined || links.pickupId == null || links.routeId != null

/** The links as a write body names them: each optional, null clearing one on a patch. */
export const TicketLinksSet = z.strictObject({
  routeId: Id.nullable().optional(),
  pickupId: Id.nullable().optional(),
  containerId: Id.nullable().optional(),
  propertyId: Id.nullable().optional(),
  sharedCollectionPointId: Id.nullable().optional(),
  customerId: Id.nullable().optional(),
  agreementId: Id.nullable().optional(),
  driverId: Id.nullable().optional(),
  parentTicketId: Id.nullable().optional(),
})
export type TicketLinksSet = z.infer<typeof TicketLinksSet>

/** `POST /tickets`: the office opens a case. The number, the status, the stamps and the provenance are the server's; the source is one of the office's doors. */
export const TicketCreate = z
  .strictObject({
    projectId: Id,
    subject: Label,
    description: Paragraph,
    kind: TicketKind,
    priority: TicketPriority.default("none").describe("Defaults to none when absent."),
    /** Never `driver-app` or `dispatch`, what the outbox's consumer writes, nor `service-provider`, what the API writes for a provider's account (#291 slice 23b). */
    source: TicketSource.exclude(["driver-app", "dispatch", "service-provider"])
      .default("office")
      .describe("Defaults to office when absent; driver-app and dispatch are the consumer's, and service-provider is what the API writes for a ticket a Service Provider's account raises."),
    /** When the issue or request happened; the request's clock when absent. */
    occurredAt: IsoDateTime.optional(),
    /** The due date; null for none, and the project's SLA target of the kind and priority when absent. */
    dueAt: IsoDateTime.nullable().optional(),
    assigneeUserAccountId: Id.nullable().optional(),
    /** What the ticket is about; nothing at all for an internal task. */
    links: TicketLinksSet.optional(),
    /** An alert of the project the ticket answers, linked to it in the same transaction. */
    alertId: Id.optional(),
    /**
     * A missed collection against a stop recorded `not-presented` is answered by
     * the stop's record (#293 M6): the reply quoting it is recorded for the
     * customer and the case completed `answered` in the same transaction.
     * False opens it for the office to judge instead.
     */
    answerFromRecord: z.boolean().default(true).describe("Defaults to true: a missed collection the stop's record answers is answered, not opened."),
  })
  // zod 4 runs a check on a body whose fields failed, so the links are read with care.
  .refine((body) => pickupWithItsRoute(body.links), pickupWithItsRouteAt)
export type TicketCreate = z.infer<typeof TicketCreate>

/** The pickup rule on a patch, where only both halves in the body are judged: a body moving `pickupId` alone names the stored route, and the route holds it. */
export const pickupWithItsRouteOnPatch = (links: { routeId?: string | null; pickupId?: string | null } | undefined): boolean => links === undefined || links.pickupId == null || links.routeId !== null

/** `PATCH /tickets/:id`: the case's own fields — never the status, the assignee, the source, the project, the number, the resolution or the stamps. */
export const TicketPatch = z
  .strictObject({
    subject: Label.optional(),
    description: Paragraph.optional(),
    kind: TicketKind.optional(),
    priority: TicketPriority.optional(),
    dueAt: IsoDateTime.nullable().optional(),
    links: TicketLinksSet.optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine((body) => pickupWithItsRouteOnPatch(body.links), pickupWithItsRouteAt)
export type TicketPatch = z.infer<typeof TicketPatch>

/** `POST /tickets/:id/assign`: who works it, or null for nobody, with a note if any. */
export const TicketAssign = z.strictObject({ assigneeUserAccountId: Id.nullable(), note: Paragraph.optional() })
export type TicketAssign = z.infer<typeof TicketAssign>

/** `POST /tickets/:id/start`: work begins; a note if any. */
export const TicketStart = z.strictObject({ note: Paragraph.optional() })
export type TicketStart = z.infer<typeof TicketStart>

/** `POST /tickets/:id/wait`: waiting for the customer, and the note says for what. */
export const TicketWait = z.strictObject({ note: Paragraph })
export type TicketWait = z.infer<typeof TicketWait>

/** `POST /tickets/:id/hold`: waiting on us, and the note says for what. */
export const TicketHold = z.strictObject({ note: Paragraph })
export type TicketHold = z.infer<typeof TicketHold>

/** What a completion naming a re-collection route with another resolution is told. */
export const RECOLLECTION_ROUTE_WITH_RECOLLECTED = "Name the re-collection's route with recollected and with nothing else"
const recollectionRouteWithRecollectedAt = { message: RECOLLECTION_ROUTE_WITH_RECOLLECTED, path: ["recollectionRouteId"] }

/** The re-collection's route goes with `recollected`: the table's `ticket_recollection_shape`, at the boundary. */
export const recollectionRouteWithRecollected = (body: { resolution?: string; recollectionRouteId?: string }): boolean => body.recollectionRouteId === undefined || body.resolution === "recollected"

/** What a completion naming a re-collection stop without its route is told. */
export const RECOLLECTION_STOP_WITH_ITS_ROUTE = "Name the re-collection's stop with the route it is a stop of"
const recollectionStopWithItsRouteAt = { message: RECOLLECTION_STOP_WITH_ITS_ROUTE, path: ["recollectionPickupId"] }

/** The re-collection's stop goes with its route (#111): the table's `ticket_recollection_pickup_shape`, at the boundary. */
export const recollectionStopWithItsRoute = (body: { recollectionRouteId?: string; recollectionPickupId?: string }): boolean => body.recollectionPickupId === undefined || body.recollectionRouteId !== undefined

/** What a completion naming a product with a resolution nothing is charged for is told. */
export const CHARGE_WITH_A_BILLABLE_RESOLUTION = "Only a re-collection or a service is charged; name a product with recollected or serviced"
const chargeWithABillableResolutionAt = { message: CHARGE_WITH_A_BILLABLE_RESOLUTION, path: ["productId"] }

/** The product goes with a resolution Finance charges for (#291 C3): the table's `ticket_charge_shape`, at the boundary. */
export const chargeWithABillableResolution = (body: { resolution: string; productId?: string }): boolean => body.productId === undefined || (BILLABLE_RESOLUTIONS as readonly string[]).includes(body.resolution)

/** `POST /tickets/:id/complete`: what the ticket ended in, the note, — with `recollected` — the route the re-collection rides on and the stop of it the re-collection is, and — with `recollected` or `serviced` — the product its work is charged at. */
export const TicketComplete = z
  .strictObject({
    resolution: TicketResolution,
    note: Paragraph,
    /** A route of the project that has not ended; with `recollected` alone. */
    recollectionRouteId: Id.optional(),
    /** A stop of that route: the one the office added for the re-collection (#111); with the route alone. */
    recollectionPickupId: Id.optional(),
    /** An offered product of the ticket's project, not sold by the month; without it, the project's charge for the ticket's kind (#291 C3). */
    productId: Id.optional(),
  })
  .refine(recollectionRouteWithRecollected, recollectionRouteWithRecollectedAt)
  .refine(recollectionStopWithItsRoute, recollectionStopWithItsRouteAt)
  .refine(chargeWithABillableResolution, chargeWithABillableResolutionAt)
export type TicketComplete = z.infer<typeof TicketComplete>

/** One ticket kind's charge (#291 C3): the product a completed ticket of the kind is charged at when its completion names none. */
export const TicketCharge = z.object({ kind: TicketKind, productId: Id })
export type TicketCharge = z.infer<typeof TicketCharge>

/** `GET /ticket-charges`: a project's charges, a kind at most once, in the kinds' order. */
export const TicketCharges = z.object({ projectId: Id, charges: z.array(TicketCharge) })
export type TicketCharges = z.infer<typeof TicketCharges>

/** What a set naming a kind twice is told. */
export const KIND_CHARGED_ONCE = "Each ticket kind is charged at one product; name a kind once"

/** `PUT /ticket-charges`: a project's charges, replaced whole — a kind left out is charged at nothing afterwards; each product an offered product of the project, not sold by the month, which only the route can judge. */
export const TicketChargesSet = z
  .strictObject({ projectId: Id, charges: z.array(TicketCharge.strict()).max(TicketKind.options.length) })
  .refine((body) => new Set(body.charges.map((charge) => charge.kind)).size === body.charges.length, { message: KIND_CHARGED_ONCE, path: ["charges"] })
export type TicketChargesSet = z.infer<typeof TicketChargesSet>

/** `GET /ticket-charges`: the project the charges are read for. */
export const TicketChargesQuery = z.object({ projectId: Id })
export type TicketChargesQuery = z.infer<typeof TicketChargesQuery>

/** `POST /tickets/:id/reject`: the reason, which becomes the history row's body. */
export const TicketReject = z.strictObject({ reason: Paragraph })
export type TicketReject = z.infer<typeof TicketReject>

/** `POST /tickets/:id/reopen`: a closed ticket back to open, and the note says why. */
export const TicketReopen = z.strictObject({ note: Paragraph })
export type TicketReopen = z.infer<typeof TicketReopen>

/** `POST /tickets/:id/comments`: a note on the thread, the office's unless said to be the customer's, with an attachment's key if one was uploaded. */
export const TicketComment = z.strictObject({
  body: Paragraph,
  visibility: TicketVisibility.default("internal").describe("Defaults to internal when absent: the office's to read, not the customer's; service-provider is the thread the office and the provider running the ticket's route read, and what a provider's comment always is."),
  /** `<companyId>/<ticketId>/<objectId>.<ext>`: the route holds the company and the ticket to the row's own, the object's id is the client's (#109 §7.23 as corrected). */
  objectKey: TicketObjectKey.optional(),
})
export type TicketComment = z.infer<typeof TicketComment>

/** A page of tickets: one project's, by status or open at all, overdue or not, by kind, priority or source, by assignee, about a customer, a property, a route, a pickup, a container or a driver, over a window of when they happened. */
export const TicketListQuery = ProjectScopedListQuery.extend({
  status: TicketStatus.optional(),
  /** A query string spells a boolean as `true` or `false`, exactly; `true` is the four open statuses, `false` the two closed. */
  open: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
  /** Likewise: `true` is an open ticket past its due date (O4 of #290), `false` every other. */
  overdue: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
  kind: TicketKind.optional(),
  priority: TicketPriority.optional(),
  source: TicketSource.optional(),
  assigneeUserAccountId: Id.optional(),
  /** The portal's read: the tickets naming the customer, or a property they are a party to. */
  customerId: Id.optional(),
  propertyId: Id.optional(),
  routeId: Id.optional(),
  pickupId: Id.optional(),
  containerId: Id.optional(),
  driverId: Id.optional(),
  /** The first day of the window over `occurredAt`, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type TicketListQuery = z.infer<typeof TicketListQuery>

/** A page of one ticket's history: by kind, and by who may read it — `customer` is what the portal reads. */
export const TicketEventListQuery = PageRequest.extend({
  kind: TicketEventKind.optional(),
  visibility: TicketVisibility.optional(),
})
export type TicketEventListQuery = z.infer<typeof TicketEventListQuery>

/**
 * What the stop a ticket is about recorded (#293 M6): its outcome, when, where
 * the device stood for it, the proofs taken there in recording order — a
 * photo's or a signature's bytes are signed for through
 * `GET /pickups/{id}/proof-objects`, never here — the reply that quotes it,
 * and whether a missed collection is answered by it.
 */
/**
 * A proof at the stop as the ticket's evidence tells it: what was recorded,
 * by which door, when, and the object a photo or a signature names — read
 * under the ticket's grant, so narrower than the stop's own read (`GET
 * /pickups/{id}`): no device, no account, no session, no driver's note and no
 * weight. The object's bytes are signed for through `GET
 * /pickups/{id}/proof-objects`, under the stops' grant.
 */
export const EvidenceProof = z.object({
  id: Id,
  kind: ProofKind,
  source: ExecutionSource,
  occurredAt: IsoDateTime,
  reason: PickupReason.nullable(),
  /** On a correction: the outcome the stop was moved to. */
  outcome: PickupOutcome.nullable(),
  objectKey: ObjectKey.nullable(),
})
export type EvidenceProof = z.infer<typeof EvidenceProof>

export const StopEvidence = z.object({
  pickupId: Id,
  routeId: Id,
  outcome: PickupStatus,
  reason: PickupReason.nullable(),
  /** What the stop is for: an emptying, or a work order's visit. */
  service: PickupService,
  /** Whether the outcome stands on the office's correction rather than the driver's record. */
  corrected: z.boolean(),
  /** The outcome's instant, else the arrival's; null for a stop not yet recorded. */
  at: IsoDateTime.nullable(),
  location: FlatPoint.nullable(),
  proofs: z.array(EvidenceProof),
  /** The customer-visible reply that quotes the record, its time on the project's clock. */
  reply: z.string(),
  /** Whether a missed collection against this stop is answered by the record. */
  answeredByRecord: z.boolean(),
})
export type StopEvidence = z.infer<typeof StopEvidence>

/** `GET /tickets/:id/evidence`: the stop's evidence, or null for a ticket about no stop. */
export const TicketEvidence = z.object({ stop: StopEvidence.nullable() })
export type TicketEvidence = z.infer<typeof TicketEvidence>

/** `POST /tickets/:id/reply-with-evidence`: one step — the reply quoting the stop's record, the office's note after it, and the case completed `answered` where asked. */
/** The office's note after the record's reply: bounded so the two, a blank line between, fit a comment's `Paragraph`. */
export const REPLY_NOTE_MAX = 1500

export const TicketReplyWithEvidence = z.strictObject({
  note: Paragraph.max(REPLY_NOTE_MAX).optional(),
  complete: z.boolean().default(false).describe("Defaults to false: the reply alone; true completes the case `answered` in the same transaction."),
})
export type TicketReplyWithEvidence = z.infer<typeof TicketReplyWithEvidence>
