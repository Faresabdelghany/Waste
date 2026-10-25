// The office's unload as one function (Issue #112, §3 "Weight control").
// `POST /routes/:id/unloads` (routes/unloads.ts) appends a weighbridge ticket
// the device did not record, and `POST /unloads/:id/correct`
// (routes/weight-control.ts) appends the corrected reading of a wrong one —
// #104 §2's rule, "a wrong unload is corrected there by a new row naming the
// old, the way `adjust` corrects a movement, and nothing here is updated".
// Two doors, one statement: the row is `source = dispatch`, `recordedBy` the
// caller, `sessionId` null (a session is named by every driver-recorded row
// and by no office row, `unload_session_shape`), no device, no location, no
// photo, the id server-minted, so the capture and the correction cannot drift
// on what an office row is.
//
// What the two doors differ on is theirs and not here: the capture holds its
// route to having run and its `occurredAt` to the request's clock and emits
// `unload-recorded`; the correction copies the route, the station, the
// fraction and the instant off the row it corrects, takes the body's weights,
// and emits nothing (#112 §7.26: the outbox carries what another context acts
// on, and the reader of a weight is Finance itself). Neither reads the row
// back: a row just appended has no review by construction (`NO_REVIEW`).
//
// The weighbridge in the office (O9 of #290): a load the station refused
// carries its reason and note from capture, the correction copying its
// original's, since the refusal is what happened at the station and not a
// reading. An accepted load's fraction is one the station takes
// (`stationTakes`, over `unloading_station_fraction`; a station that names
// none takes nothing, as the route's assignment holds it): the office's
// capture is refused at `wasteFractionId` in the station's sentence
// (`notTaken`), and the driver's `record-unload` is never refused for it —
// the load is tipped, and a refusal would lose the weighbridge's reading — so
// the driver door records it and opens the office an internal task in the
// same sentence (`tellOfficeNotTaken`), in the command's savepoint, once while
// it is open for a route, a station and a fraction.
import { routeLabel } from "@waste/contracts/execution"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { unload } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { ticket } from "@waste/db/schema/resolution"
import { doesNotTake, takesNoneSet, unloadNotAccepted } from "@waste/domain/execution/unloads"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray, sql } from "drizzle-orm"

import { newId } from "../ids"
import { NO_REVIEW, unloadColumns, type UnloadRow } from "./execution-shapes"
import { whenOn } from "./ticket-evidence"
import { BY_SLA, openTicket } from "./ticket-writes"

/** What an office unload says: the route it is on, the project the route is in, where and what was tipped, when, by whose word, the weights, the station's ticket and a note. */
export type OfficeUnload = {
  projectId: string
  routeId: string
  unloadingStationId: string
  wasteFractionId: string
  occurredAt: Date
  recordedBy: string
  grossKg: number | null
  tareKg: number | null
  netKg: number
  weighbridgeTicket: string | null
  note: string | null
  /** Why the station refused the load (O9 of #290), null for one it took; a correction copies its original's. */
  refusalReason: string | null
  refusalNote: string | null
}

/** Appends one office unload — `dispatch`, no session, no device, no location, no photo, a server-minted id — and answers the row with the reading a new row has. */
export async function appendUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<UnloadRow> {
  const [row] = await tx
    .insert(unload)
    .values({
      id: newId(),
      companyId,
      projectId: draft.projectId,
      routeId: draft.routeId,
      sessionId: null,
      unloadingStationId: draft.unloadingStationId,
      wasteFractionId: draft.wasteFractionId,
      source: "dispatch",
      occurredAt: draft.occurredAt,
      recordedBy: draft.recordedBy,
      deviceId: null,
      location: null,
      grossKg: draft.grossKg,
      tareKg: draft.tareKg,
      netKg: draft.netKg,
      weighbridgeTicket: draft.weighbridgeTicket,
      objectKey: null,
      note: draft.note,
      refusalReason: draft.refusalReason,
      refusalNote: draft.refusalNote,
    })
    .returning(unloadColumns)
  return { ...row, ...NO_REVIEW }
}

/** What a station says of a fraction an unload names: both names, whether the station takes it, and whether the station names any fraction it takes. */
export type StationTakes = { stationName: string; fractionName: string; takes: boolean; takesAny: boolean }

/** The station's accepted fractions against the one an unload names, in one statement; both are the company's already, checked by the door. */
export async function stationTakes(tx: Tx, companyId: string, stationId: string, fractionId: string): Promise<StationTakes> {
  const accepted = and(eq(unloadingStationFraction.companyId, companyId), eq(unloadingStationFraction.unloadingStationId, unloadingStation.id))
  const [row] = await tx
    .select({
      stationName: unloadingStation.name,
      fractionName: wasteFraction.name,
      takes: sql<boolean>`exists (select 1 from ${unloadingStationFraction} where ${and(accepted, eq(unloadingStationFraction.wasteFractionId, wasteFraction.id))})`,
      takesAny: sql<boolean>`exists (select 1 from ${unloadingStationFraction} where ${accepted})`,
    })
    .from(unloadingStation)
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, companyId), eq(wasteFraction.id, fractionId)))
    .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, stationId)))
    .limit(1)
  if (row === undefined) throw new Error(`station ${stationId} or fraction ${fractionId} is not company ${companyId}'s, which the door checked`)
  return row
}

/** What an accepted unload of a fraction the station does not take is told: the station's sentence, or that it names none. */
export const notTaken = (takes: StationTakes): string => (takes.takesAny ? doesNotTake(takes.stationName, takes.fractionName) : takesNoneSet(takes.stationName))

/** A driver's accepted unload of a fraction the station does not take, as the office is told of it. */
export type NotTakenUnload = {
  companyId: string
  projectId: string
  routeId: string
  routeNumber: number
  driverId: string
  /** The driver's account: the opener of the task their command made. */
  recordedBy: string
  netKg: number
  occurredAt: string
  takes: StationTakes
  now: () => Date
}

/** Opens the office's internal task for the unload, in the station's sentence and on the project's clock, due by the project's SLA — once while it is open: a route's next unload of the fraction at the station is the same news. */
export async function tellOfficeNotTaken(tx: Tx, input: NotTakenUnload): Promise<void> {
  const [scope] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, input.companyId), eq(project.id, input.projectId)))
    .limit(1)
  if (scope === undefined) throw new Error(`project ${input.projectId} of route ${input.routeId} is not there`)
  const task = unloadNotAccepted({
    stationName: input.takes.stationName,
    fractionName: input.takes.fractionName,
    routeLabel: routeLabel(input.routeNumber),
    netKg: input.netKg,
    recordedAt: whenOn(input.occurredAt, scope.timezone),
    stationTakesAny: input.takes.takesAny,
  })
  const [told] = await tx
    .select({ id: ticket.id })
    .from(ticket)
    .where(
      and(
        eq(ticket.companyId, input.companyId),
        eq(ticket.projectId, input.projectId),
        eq(ticket.routeId, input.routeId),
        eq(ticket.kind, task.kind),
        eq(ticket.subject, task.subject),
        inArray(ticket.status, [...OPEN_TICKET_STATUSES]),
      ),
    )
    .limit(1)
  if (told !== undefined) return
  await openTicket(tx, {
    companyId: input.companyId,
    draft: {
      projectId: input.projectId,
      kind: task.kind,
      priority: task.priority,
      source: "driver-app",
      subject: task.subject,
      description: task.description,
      occurredAt: new Date(input.occurredAt),
      dueAt: BY_SLA,
      assigneeUserAccountId: null,
      links: { routeId: input.routeId, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: input.driverId, parentTicketId: null },
      alertId: null,
    },
    createdBy: input.recordedBy,
    sourceEventId: null,
    newId,
    now: input.now,
  })
}
