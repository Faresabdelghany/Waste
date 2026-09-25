// The Alert on the wire (Issue #109): "a condition that requires attention,
// notification, or acknowledgement and may create or link to a ticket"
// (CONTEXT.md). Current state and no ledger: acknowledged once and resolved
// once, the instants and the accounts columns held to the status by the
// table's `alert_stamps_shape`, the `route` stamps precedent; linked to at
// most one Ticket through `ticketId`, and "linked" is that column not null
// and no status. There is no display number — an alert is named by its title
// — and no patch: an alert is raised, acknowledged, resolved and linked, and
// nothing else changes it.
//
// `AlertCreate` is what the office raises by hand, the one source this issue
// writes: the API sets `source = manual`, `status = new` and `raisedBy` the
// caller, so none of the three is on the body, and `detectedAt` defaults to
// the request's clock. An alert is about something — a route, a vehicle, a
// driver or a container — or it is nothing (`namesASubject`, the prototype's
// own validation, at `routeId` since a refusal needs one field to stand on);
// the four links are nullable on the body so a form may send null for what it
// left blank. `AlertAcknowledge` says nothing (`VehicleAllocationConfirm`'s
// shape: a body with a member is refused), `AlertResolve` may carry the
// resolution's note, `AlertLinkTicket` names the one ticket.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { AlertKind, AlertSeverity, AlertSource, AlertStatus } from "./resolution"
import { stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const Alert = z.object({
  ...stamped,
  projectId: Id,
  kind: AlertKind,
  severity: AlertSeverity,
  /** Who raised it: `manual` for every alert the office raises. */
  source: AlertSource,
  status: AlertStatus,
  title: Label,
  details: Paragraph,
  /** When the condition was seen. */
  detectedAt: IsoDateTime,
  /** What the alert is about: at least one of the four. */
  routeId: Id.nullable(),
  vehicleId: Id.nullable(),
  driverId: Id.nullable(),
  containerId: Id.nullable(),
  /** The one ticket the alert created or was linked to; null until then. */
  ticketId: Id.nullable(),
  /** The caller; null for a source that is not a person. */
  raisedBy: Id.nullable(),
  acknowledgedAt: IsoDateTime.nullable(),
  acknowledgedBy: Id.nullable(),
  resolvedAt: IsoDateTime.nullable(),
  resolvedBy: Id.nullable(),
  resolutionNote: Paragraph.nullable(),
})
export type Alert = z.infer<typeof Alert>

/** What an alert about nothing is told. */
export const NAMES_A_SUBJECT = "An alert names what it is about: a route, a vehicle, a driver or a container"
const namesASubjectAt = { message: NAMES_A_SUBJECT, path: ["routeId"] }

/** At least one of the four links is given: the table's `alert_subject_shape`, at the boundary. */
export const namesASubject = (body: { routeId?: string | null; vehicleId?: string | null; driverId?: string | null; containerId?: string | null }): boolean =>
  body.routeId != null || body.vehicleId != null || body.driverId != null || body.containerId != null

/** `POST /alerts`: the office raises an alert by hand about something of the project. */
export const AlertCreate = z
  .strictObject({
    projectId: Id,
    title: Label,
    details: Paragraph,
    kind: AlertKind,
    severity: AlertSeverity,
    /** When the condition was seen; the request's clock when absent. */
    detectedAt: IsoDateTime.optional(),
    routeId: Id.nullable().optional(),
    vehicleId: Id.nullable().optional(),
    driverId: Id.nullable().optional(),
    containerId: Id.nullable().optional(),
    /** A ticket of the project the alert is raised about. */
    ticketId: Id.optional(),
  })
  .refine(namesASubject, namesASubjectAt)
export type AlertCreate = z.infer<typeof AlertCreate>

/** `POST /alerts/:id/acknowledge`: nothing to say; a body with a member is refused. */
export const AlertAcknowledge = z.strictObject({})
export type AlertAcknowledge = z.infer<typeof AlertAcknowledge>

/** `POST /alerts/:id/resolve`: the resolution's note, if the person has one. */
export const AlertResolve = z.strictObject({ note: Paragraph.optional() })
export type AlertResolve = z.infer<typeof AlertResolve>

/** `POST /alerts/:id/link-ticket`: the one ticket the alert links to. */
export const AlertLinkTicket = z.strictObject({ ticketId: Id })
export type AlertLinkTicket = z.infer<typeof AlertLinkTicket>

/** A page of alerts: one project's, of one status, severity or kind, about one route, vehicle, driver or container, linked to one ticket. */
export const AlertListQuery = ProjectScopedListQuery.extend({
  status: AlertStatus.optional(),
  severity: AlertSeverity.optional(),
  kind: AlertKind.optional(),
  routeId: Id.optional(),
  vehicleId: Id.optional(),
  driverId: Id.optional(),
  containerId: Id.optional(),
  ticketId: Id.optional(),
})
export type AlertListQuery = z.infer<typeof AlertListQuery>
