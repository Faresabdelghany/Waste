// The office's unloads (Issue #112, §3 "Weight control"; O9 and O27 of #290),
// written through the one write every door records an unload with
// (`recordUnload`, @waste/db/commands/unloads): `POST /routes/:id/unloads`
// (routes/unloads.ts) appends a weighbridge ticket the device did not record,
// `POST /unloads/:id/correct` (routes/weight-control.ts) appends the
// corrected reading of a wrong one — #104 §2's rule, "a wrong unload is
// corrected there by a new row naming the old, the way `adjust` corrects a
// movement, and nothing here is updated" — and a weighbridge's ticket matched
// to a route is written as one (routes/weighbridge.ts, routes/scale-house.ts,
// `writeUnload`). An office row is `source = dispatch`, or `integration` for
// a weighbridge's, `recordedBy` the caller, the id server-minted.
//
// What the doors differ on is theirs: the capture holds its route to having
// run and its `occurredAt` to the request's clock, and is told
// (`recordOfficeUnload`: `unload-recorded`, the answer as every door gives
// it); the correction copies the route, the station, the fraction and the
// instant off the row it corrects, takes the body's weights, and emits
// nothing (#112 §7.26: the outbox carries what another context acts on, and
// the reader of a weight is Finance itself). A row just appended has no
// review by construction (`NO_REVIEW`).
//
// The weighbridge in the office (O9 of #290): a load the station refused
// carries its reason and note from capture, the correction copying its
// original's, since the refusal is what happened at the station and not a
// reading. An accepted load's fraction is one the station takes
// (`stationTakes`): the office's capture is refused at `wasteFractionId` in
// the station's sentence (`notTaken`), and the driver's `record-unload` is
// never refused for it — the load is tipped, and a refusal would lose the
// weighbridge's reading — so the driver door records it and opens the office
// an internal task in the same sentence (`tellOfficeNotTaken`), in the
// command's savepoint, once while it is open for a route, a station and a
// fraction.
import { routeLabel } from "@waste/contracts/execution"
import type { Unload } from "@waste/contracts/unloads"
import type { Tx } from "@waste/db/client"
import { lockRow } from "@waste/db/commands/shared"
import { BY_SLA, openTicket } from "@waste/db/commands/open-ticket"
import { emit } from "@waste/db/commands/outbox"
import { recordUnload, type StationTakes } from "@waste/db/commands/unloads"
import { newId } from "@waste/db/ids"
import type { Send } from "@waste/db/jobs"
import { route } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { ticket } from "@waste/db/schema/resolution"
import { NO_TICKET_LINKS } from "@waste/db/commands/resolution-rows"
import { unloadNotAccepted } from "@waste/domain/execution/unloads"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { NO_REVIEW, unloadAnswered, type UnloadRow } from "./execution-shapes"
import { whenOn } from "./ticket-evidence"

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
  /** Whose reading it is: the office's, `dispatch`, unless a weighbridge's ticket is written as it (`integration`, O27 of #290). */
  source?: "dispatch" | "integration"
}

/** Appends one office unload — `dispatch`, or a weighbridge's `integration` — and answers the row with the reading a new row has. */
export async function appendUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<UnloadRow> {
  const row = await recordUnload(tx, companyId, { ...draft, source: draft.source ?? "dispatch" })
  return { ...row, ...NO_REVIEW }
}

/** An office unload appended and told: answered as every door answers an unload, and `unload-recorded` written with that answer, dated when the load was tipped. */
export async function recordOfficeUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<Unload> {
  const row = await appendUnload(tx, companyId, draft)
  const answered = await unloadAnswered(tx, companyId, row)
  await emit(tx, { companyId }, { aggregateId: row.id, kind: "unload-recorded", payload: answered, projectId: row.projectId, occurredAt: draft.occurredAt })
  return answered
}

/** Writes a matched weighbridge ticket's Unload on its route under the route's lock, `integration`, and tells it; answers the Unload's id. */
export async function writeUnload(tx: Tx, principal: Principal, ticket: { routeId: string; wasteFractionId: string; unloadingStationId: string; weighedAt: Date; grossKg: number | null; tareKg: number | null; netKg: number; ticketNumber: string }): Promise<{ unloadId: string; projectId: string }> {
  await lockRow(tx, route, { companyId: principal.companyId, id: ticket.routeId })
  const [ran] = await tx.select({ projectId: route.projectId }).from(route).where(and(eq(route.companyId, principal.companyId), eq(route.id, ticket.routeId)))
  if (ran === undefined) throw new Error(`route ${ticket.routeId} vanished under its lock`)
  const answered = await recordOfficeUnload(tx, principal.companyId, {
    projectId: ran.projectId,
    routeId: ticket.routeId,
    unloadingStationId: ticket.unloadingStationId,
    wasteFractionId: ticket.wasteFractionId,
    occurredAt: ticket.weighedAt,
    recordedBy: principal.user.id,
    grossKg: ticket.grossKg,
    tareKg: ticket.tareKg,
    netKg: ticket.netKg,
    weighbridgeTicket: ticket.ticketNumber,
    note: null,
    refusalReason: null,
    refusalNote: null,
    source: "integration",
  })
  return { unloadId: answered.id, projectId: answered.projectId }
}

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
  /** What the task's automation queues a message with. */
  send: Send
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
      links: { ...NO_TICKET_LINKS, routeId: input.routeId, driverId: input.driverId },
      alertId: null,
    },
    createdBy: input.recordedBy,
    automation: { send: input.send, by: input.recordedBy },
    sourceEventId: null,
    newId,
    now: input.now,
  })
}
