// The driver's unload of a fraction the station does not take (O9 of #290).
// Every door records an unload through `@waste/db/commands/unloads`; an
// accepted load's fraction is one the station takes (`stationTakes`), and
// where the office's capture is refused at `wasteFractionId` in the station's
// sentence (`notTaken`), the driver's `record-unload` is never refused for it
// — the load is tipped, and a refusal would lose the weighbridge's reading —
// so the driver door records it and opens the office an internal task in the
// same sentence (`tellOfficeNotTaken`), in the command's savepoint, once while
// it is open for a route, a station and a fraction.
import { routeLabel } from "@waste/contracts/execution"
import type { Tx } from "@waste/db/client"
import { BY_SLA, openTicket } from "@waste/db/commands/open-ticket"
import type { StationTakes } from "@waste/db/commands/unloads"
import { newId } from "@waste/db/ids"
import type { Send } from "@waste/db/jobs"
import { project } from "@waste/db/schema/organisation"
import { ticket } from "@waste/db/schema/resolution"
import { NO_TICKET_LINKS } from "@waste/db/shapes/tickets"
import { unloadNotAccepted } from "@waste/domain/execution/unloads"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import { whenOn } from "./ticket-evidence"

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
