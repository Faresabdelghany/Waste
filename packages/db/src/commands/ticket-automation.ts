// A Ticket Type's automation run (#546 of #544): the type's actions of one
// trigger, in order, on one ticket, in the transaction of the change that
// fired them — a ticket opened (`openTicket`, the API's openers and the
// worker's consumer alike), a person's status command (apps/api's
// routes/tickets.ts), a stop servicing its ticket (commands/ticket-stops.ts).
// The rules are @waste/domain/resolution/automation's.
//
// Each action runs in a savepoint of its own and leaves one line in the
// ticket's history, recorded by nobody — the system's work: a move or an
// assignment as the row its command writes, with the line as its note, and
// anything else as an internal comment. An action that cannot run — a team
// retired, a person who left, no active template of that name in the
// ticket's project, no customer to write to, a move the machine refuses —
// throws `Refused` inside its savepoint, which is rolled back, and leaves a
// line saying why; the actions after it still run, and the change that fired
// them stands. Anything else is a bug and fails the change.
//
// A move fires the trigger of the status it reaches, and a follow-up runs its
// own type's opened actions, each one level deeper (`depth`); past the
// domain's last level the chain leaves a line and stops, and so it does past
// the domain's last action, counted over the whole chain one change set
// going (`AutomationBudget`), so follow-ups opening follow-ups never multiply
// past it. A closed ticket keeps its team, assignee and priority, as the
// office's commands keep them. The type's roles and required fields bind
// people, never this.
//
// A plan in a route (#546, part 2) books the stop its kind is answered by on
// the chosen vehicle's next route that has not started, the given days
// ahead at the earliest, written as every office stop is
// (commands/office-stops.ts), and booked to the ticket through `bookTicket`
// (commands/ticket-stops.ts).
import { routeLabel } from "@waste/contracts/execution"
import { SERVICE_NOUNS } from "@waste/domain/execution/services"
import { stopMismatch } from "@waste/domain/execution/ticket-stops"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import type { OfficeStopService, RouteStatus } from "@waste/domain/execution/vocabulary"
import { automationNote, AUTOMATION_ACTIONS_MAX, AUTOMATION_DEPTH_MAX, AUTOMATION_SPENT, AUTOMATION_STOPPED, notPlannable, plannedService, triggerOf, type TicketActionParameters } from "@waste/domain/resolution/automation"
import { addDays } from "@waste/domain/days"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { ticketTransition } from "@waste/domain/resolution/transitions"
import type { PropertyPartyRole } from "@waste/domain/registry/vocabulary"
import { Refused } from "@waste/domain/refusal"
import { isClosedTicketStatus, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketKind, type TicketMessageRecipient, type TicketPriority, type TicketResolution, type TicketSource, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { QueueMissing, type Send } from "../jobs"
import { container } from "../schema/containers"
import { propertyParty } from "../schema/customers"
import { route } from "../schema/execution"
import { vehicle } from "../schema/fleet"
import { messageTemplate } from "../schema/messaging"
import { team, ticket, ticketType, ticketTypeAction } from "../schema/resolution"
import { LOCK_NOT_AVAILABLE, sqlstate } from "../sqlstate"
import { queueMessage, type Queued } from "./messaging"
import { placementInForce } from "../query/placement-in-force"
import { vehicleLabel } from "./fleet-fit"
import { addOfficeStop, ORDER_OPEN_STATUSES } from "./office-stops"
import { appendTicketEvent, BY_SLA, dueWithin, openTicket, slaHoursOf, ticketRefOf } from "./open-ticket"
import { emit } from "./outbox"
import { projectToday } from "./project-clock"
import { assigneeOf, assignTicket, currentTicket } from "./ticket-assignment"
import { bookTicket, plannedStopAnswering } from "./ticket-stops"
import { labelOf, linksOf, ticketColumns, ticketOf, type TicketRow } from "../shapes/tickets"

/** How many more actions one change's chain may run: one count every level of it shares. */
export type AutomationBudget = { left: number }

/** What a change hands the automation it may set going: the job sender a message is queued through, the account whose command set it going or null for the system's own, and, inside a chain, how deep it is and what is left of its budget. */
export type AutomationCause = { send: Send; by: string | null; depth?: number; budget?: AutomationBudget }

/** A run: the company, the cause, and the clock and the id minter the change writes with; `dueBySla` where the ticket is opening with its SLA's due date, which a priority set then judges again. */
export type AutomationRun = AutomationCause & { companyId: string; newId: IdMinter; now: () => Date; dueBySla?: boolean }

type Action = { id: string; kind: TicketActionKind; vehicleProjectId: string | null } & TicketActionParameters

/** What an action did: its line, and whether it wrote its own history row carrying the line, as a move and an assignment do. */
type Done = { said: string; recorded: boolean }

/** An internal comment of the system's, the ticket as it stands. */
const commentOf = (row: TicketRow, body: string) => ({
  kind: "comment" as const,
  status: row.status as TicketStatus,
  assigneeUserAccountId: row.assigneeUserAccountId,
  resolution: null,
  body,
  visibility: "internal" as const,
  objectKey: null,
  recordedBy: null,
  sourceEventId: null,
})

/**
 * Runs the ticket's type's actions of the trigger, in order, each in a
 * savepoint, each leaving its line; a chain past its last level leaves the
 * line that says so instead. A trigger the type names no action for writes
 * nothing.
 */
export async function runTicketAutomation(tx: Tx, run: AutomationRun, ticketId: string, trigger: TicketActionTrigger): Promise<void> {
  const depth = run.depth ?? 0
  const chain: AutomationRun = { ...run, budget: run.budget ?? { left: AUTOMATION_ACTIONS_MAX } }
  const budget = chain.budget as AutomationBudget
  const first = await currentTicket(tx, run.companyId, ticketId)
  const actions = await tx
    .select({
      id: ticketTypeAction.id,
      kind: ticketTypeAction.kind,
      teamId: ticketTypeAction.teamId,
      userAccountId: ticketTypeAction.userAccountId,
      priority: ticketTypeAction.priority,
      command: ticketTypeAction.command,
      resolution: ticketTypeAction.resolution,
      messageTemplateName: ticketTypeAction.messageTemplateName,
      recipient: ticketTypeAction.recipient,
      followUpTypeId: ticketTypeAction.followUpTypeId,
      vehicleProjectId: ticketTypeAction.vehicleProjectId,
      vehicleId: ticketTypeAction.vehicleId,
      daysAhead: ticketTypeAction.daysAhead,
    })
    .from(ticketTypeAction)
    .where(and(eq(ticketTypeAction.companyId, run.companyId), eq(ticketTypeAction.ticketTypeId, first.ticketTypeId), eq(ticketTypeAction.trigger, trigger)))
    .orderBy(asc(ticketTypeAction.position))
  if (actions.length === 0) return
  if (depth >= AUTOMATION_DEPTH_MAX) {
    await appendTicketEvent(tx, ticketRefOf(run.companyId, first), commentOf(first, AUTOMATION_STOPPED), run.newId)
    return
  }
  const [named] = await tx
    .select({ name: ticketType.name })
    .from(ticketType)
    .where(and(eq(ticketType.companyId, run.companyId), eq(ticketType.id, first.ticketTypeId)))
    .limit(1)
  const typeName = named?.name ?? DEFAULT_TICKET_TYPE_NAMES[first.kind as TicketKind]
  for (const action of actions as Action[]) {
    if (budget.left === 0) {
      await appendTicketEvent(tx, ticketRefOf(run.companyId, first), commentOf(await currentTicket(tx, run.companyId, ticketId), AUTOMATION_SPENT), run.newId)
      return
    }
    budget.left -= 1
    const line = (said: string) => automationNote(typeName, trigger, said)
    let done: Done
    try {
      done = await tx.transaction((savepoint) => perform(savepoint, chain, depth, action, line))
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      done = { said: error.message, recorded: false }
    }
    if (!done.recorded) {
      const now = await currentTicket(tx, run.companyId, ticketId)
      await appendTicketEvent(tx, ticketRefOf(run.companyId, now), commentOf(now, line(done.said)), run.newId)
    }
  }

  /** One action on the ticket as it now stands. */
  async function perform(tx: Tx, run: AutomationRun, depth: number, action: Action, line: (said: string) => string): Promise<Done> {
    const row = await currentTicket(tx, run.companyId, ticketId)
    switch (action.kind) {
      case "assign-team":
        return await assignTeam(tx, run, row, action.teamId as string)
      case "assign-person":
        return await assignPerson(tx, run, row, action.userAccountId as string, line)
      case "set-priority":
        return await setPriority(tx, run, row, action.priority as TicketPriority)
      case "set-status":
        return await setStatus(tx, run, depth, row, action.command as TicketActionCommand, action.resolution, line)
      case "send-message":
        return await sendMessage(tx, run, row, action.messageTemplateName as string, action.recipient as TicketMessageRecipient)
      case "open-follow-up":
        return await openFollowUp(tx, run, depth, row, action.followUpTypeId as string)
      case "plan-in-route":
        return await planInRoute(tx, run, row, { projectId: action.vehicleProjectId as string, id: action.vehicleId as string }, action.daysAhead as number, line)
    }
  }
}

/** What a door sets beside the status: a completion's resolution and what it arranged, a duplicate's parent, the stop that serviced it. */
export type TicketMoveColumns = {
  resolution?: TicketResolution
  recollectionRouteId?: string | null
  recollectionPickupId?: string | null
  chargeProductId?: string | null
  parentTicketId?: string
  bookedRouteId?: string
  bookedPickupId?: string
}

/** A move the machine allowed: the status it reaches, what the door sets beside it, the history row's note and who recorded it — a person, or null for the system's own — and the instant a close carries. */
export type TicketMove = { to: TicketStatus; set?: TicketMoveColumns; note: string | null; recordedBy: string | null; at: Date }

/** A reopened ticket is open: what a close set is cleared, the close standing in the history. */
const REOPENED = { resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null }

const closingOf = (to: TicketStatus, at: Date) => (to === "completed" || to === "rejected" ? { closedAt: at } : to === "open" ? REOPENED : {})

const closes = (to: TicketStatus): to is "completed" | "rejected" => to === "completed" || to === "rejected"

/**
 * Moves the ticket the caller holds under its row lock to the status the
 * machine allowed, as every door moves one — the office's commands
 * (apps/api's routes/tickets.ts), the `set-status` action below, a stop
 * servicing its ticket (commands/ticket-stops.ts), the consumer completing a
 * superseded problem (apps/worker's open-tickets.ts), each judging the move
 * by the machine and answering a refusal in its own words: the status with
 * the columns a close carries — `closedAt` on completed and rejected, every
 * closing column cleared on a reopen — and what the door sets beside them,
 * one `status-changed` row, `ticket-completed` or `ticket-rejected` on a
 * close, then the type's actions on the status reached, with the run,
 * `depth` deep. A move runs the actions and an action moves, so the two live
 * here together. Answers the ticket as the actions leave it.
 */
export async function moveTicket(tx: Tx, run: AutomationRun, current: TicketRow, move: TicketMove): Promise<TicketRow> {
  const [row] = await tx
    .update(ticket)
    .set({ status: move.to, ...closingOf(move.to, move.at), ...move.set })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, current.id)))
    .returning(ticketColumns)
  if (row === undefined) throw new Error(`ticket ${current.id} of company ${run.companyId} moved and then not there`)
  await appendTicketEvent(
    tx,
    ticketRefOf(run.companyId, row),
    {
      kind: "status-changed",
      status: move.to,
      assigneeUserAccountId: row.assigneeUserAccountId,
      resolution: move.to === "completed" ? (row.resolution as TicketResolution) : null,
      body: move.note,
      visibility: "internal",
      objectKey: null,
      recordedBy: move.recordedBy,
      sourceEventId: null,
    },
    run.newId,
  )
  if (closes(move.to)) await emit(tx, run, { aggregateId: row.id, kind: move.to === "completed" ? "ticket-completed" : "ticket-rejected", payload: ticketOf(row), projectId: row.projectId, occurredAt: move.at })
  const reached = triggerOf(move.to)
  if (reached === undefined) return row
  await runTicketAutomation(tx, run, row.id, reached)
  return await currentTicket(tx, run.companyId, row.id)
}

/** Hands the ticket to an active team of the company. */
async function assignTeam(tx: Tx, run: AutomationRun, row: TicketRow, teamId: string): Promise<Done> {
  const [found] = await tx
    .select({ name: team.name, status: team.status })
    .from(team)
    .where(and(eq(team.companyId, run.companyId), eq(team.id, teamId)))
    .limit(1)
  if (found === undefined || found.status !== "active") throw Refused.conflict(`not handed to team ${JSON.stringify(found?.name ?? teamId)}, which is retired.`)
  if (isClosedTicketStatus(row.status as TicketStatus)) throw Refused.conflict(`not handed to team ${found.name}: the ticket is ${row.status} and keeps its team.`)
  if (row.teamId === teamId) return { said: `already with team ${found.name}.`, recorded: false }
  await tx
    .update(ticket)
    .set({ teamId })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
  return { said: `handed to team ${found.name}.`, recorded: false }
}

/** Assigns the ticket to an active account working in its project, judged as the office's assign judges it (`assigneeOf`): the `assigned` row with the line as its note, and `ticket-assigned`. */
async function assignPerson(tx: Tx, run: AutomationRun, row: TicketRow, userAccountId: string, line: (said: string) => string): Promise<Done> {
  const found = await assigneeOf(tx, { companyId: run.companyId, projectId: row.projectId }, userAccountId)
  if (found === undefined || found.serviceProvider) throw Refused.conflict(`not assigned to ${found?.name ?? "the person named"}, who no longer works tickets here.`)
  if (!found.worksInProject) throw Refused.conflict(`not assigned to ${found.name}, who does not work in this ticket's project.`)
  if (isClosedTicketStatus(row.status as TicketStatus)) throw Refused.conflict(`not assigned to ${found.name}: the ticket is ${row.status} and keeps its assignee.`)
  if (row.assigneeUserAccountId === userAccountId) return { said: `already assigned to ${found.name}.`, recorded: false }
  const said = `assigned to ${found.name}.`
  await assignTicket(tx, row, userAccountId, { companyId: run.companyId, by: null, note: line(said), at: run.now(), newId: run.newId })
  return { said, recorded: true }
}

/** Sets the ticket's priority; as it opens with its SLA's due date, the due date by the new priority's target too. */
async function setPriority(tx: Tx, run: AutomationRun, row: TicketRow, priority: TicketPriority): Promise<Done> {
  const words = priority.replaceAll("-", " ")
  if (isClosedTicketStatus(row.status as TicketStatus)) throw Refused.conflict(`priority not set to ${words}: the ticket is ${row.status} and keeps its priority.`)
  if (row.priority === priority) return { said: `priority already ${words}.`, recorded: false }
  const hours = run.dueBySla === true ? await slaHoursOf(tx, run.companyId, { projectId: row.projectId, kind: row.kind as TicketKind, ticketTypeId: row.ticketTypeId, priority }) : undefined
  const dueAt = hours === undefined ? row.dueAt : dueWithin(row.occurredAt, hours)
  await tx
    .update(ticket)
    .set({ priority, dueAt })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
  // The due date is told only where it moved.
  if (dueAt?.getTime() === row.dueAt?.getTime()) return { said: `priority set to ${words}.`, recorded: false }
  if (hours === null || hours === undefined) return { said: `priority set to ${words}; the SLA sets no target at ${words}, so it has no due date.`, recorded: false }
  return { said: `priority set to ${words}, due within the SLA's ${hours} ${hours === 1 ? "hour" : "hours"}.`, recorded: false }
}

/**
 * Moves the ticket by the command, as the office's command moves it
 * (`moveTicket`), the line as the `status-changed` row's note and a
 * completion's resolution the action's, and runs the trigger it reaches one
 * level deeper. A move the machine refuses is the line; one already made is
 * too.
 */
async function setStatus(tx: Tx, run: AutomationRun, depth: number, row: TicketRow, command: TicketActionCommand, resolution: string | null, line: (said: string) => string): Promise<Done> {
  const transition = ticketTransition(row.status as TicketStatus, command, labelOf(row))
  if (transition.kind === "refuse") throw Refused.conflict(`${transition.sentence}.`)
  const words = (status: string) => status.replaceAll("-", " ")
  if (transition.kind === "stay") return { said: `already ${words(row.status)}.`, recorded: false }
  const said = transition.to === "completed" ? `completed, ${words(resolution as string)}.` : `moved to ${words(transition.to)}.`
  await moveTicket(tx, { ...run, depth: depth + 1 }, row, { to: transition.to, set: transition.to === "completed" ? { resolution: resolution as TicketResolution } : {}, note: line(said), recordedBy: null, at: run.now() })
  return { said, recorded: true }
}

/** The customer a message goes to: the ticket's own, or the one in the role at its property on the project's day. */
async function recipientOf(tx: Tx, run: AutomationRun, row: TicketRow, recipient: TicketMessageRecipient): Promise<string> {
  if (recipient === "ticket-customer") {
    if (row.customerId === null) throw Refused.conflict("not sent: the ticket names no customer.")
    return row.customerId
  }
  const role: PropertyPartyRole = recipient
  if (row.propertyId === null) throw Refused.conflict(`not sent: the ticket names no property to find its ${role.replaceAll("-", " ")} at.`)
  const day = await projectToday(tx, { companyId: run.companyId, projectId: row.projectId }, run.now)()
  const [party] = await tx
    .select({ customerId: propertyParty.customerId })
    .from(propertyParty)
    .where(and(eq(propertyParty.companyId, run.companyId), eq(propertyParty.propertyId, row.propertyId), eq(propertyParty.role, role), lte(propertyParty.validFrom, day), or(isNull(propertyParty.validTo), gt(propertyParty.validTo, day))))
    .orderBy(asc(propertyParty.id))
    .limit(1)
  if (party === undefined) throw Refused.conflict(`not sent: the property has no ${role.replaceAll("-", " ")} today.`)
  return party.customerId
}

/** Queues the ticket's project's active template of the name to the recipient, with the ticket's number to fill. */
async function sendMessage(tx: Tx, run: AutomationRun, row: TicketRow, name: string, recipient: TicketMessageRecipient): Promise<Done> {
  const [template] = await tx
    .select({ id: messageTemplate.id })
    .from(messageTemplate)
    .where(and(eq(messageTemplate.companyId, run.companyId), eq(messageTemplate.projectId, row.projectId), eq(messageTemplate.name, name), eq(messageTemplate.status, "active")))
    .limit(1)
  if (template === undefined) throw Refused.conflict(`not sent: this ticket's project has no active message template ${JSON.stringify(name)}.`)
  const customerId = await recipientOf(tx, run, row, recipient)
  let queued: Queued
  try {
    queued = await queueMessage(tx, run.send, { id: run.newId(), companyId: run.companyId, templateId: template.id, customerId, contactId: null, values: { ticketNumber: labelOf(row) } })
  } catch (error) {
    if (error instanceof QueueMissing) throw Refused.conflict(`message ${JSON.stringify(name)} not sent: the worker has not made its queues yet.`)
    throw error
  }
  if (queued.kind === "refused") throw Refused.conflict(`message ${JSON.stringify(name)} not sent: ${queued.refusal.sentence}`)
  return { said: `message ${JSON.stringify(name)} queued to ${queued.message.recipient}.`, recorded: false }
}

/** The longest subject a follow-up's own words leave room for. */
const SUBJECT_MAX = 200

/**
 * Opens a ticket of an active type of the company as the ticket's child,
 * about the same things in the same project at its priority, which runs its
 * own type's opened actions one level deeper. A person's change makes it
 * theirs; the system's change makes it the system's, under an id of its own
 * as its source event, the consumer's replay meeting its parent's key first.
 */
async function openFollowUp(tx: Tx, run: AutomationRun, depth: number, row: TicketRow, typeId: string): Promise<Done> {
  const [type] = await tx
    .select({ name: ticketType.name, kind: ticketType.kind, status: ticketType.status })
    .from(ticketType)
    .where(and(eq(ticketType.companyId, run.companyId), eq(ticketType.id, typeId)))
    .limit(1)
  if (type === undefined || type.status !== "active") throw Refused.conflict(`no follow-up opened: the ticket type ${JSON.stringify(type?.name ?? typeId)} is retired.`)
  const subject = `Follow-up of ${labelOf(row)}: ${row.subject}`
  const { row: opened } = await openTicket(tx, {
    companyId: run.companyId,
    draft: {
      projectId: row.projectId,
      kind: type.kind as TicketKind,
      ticketTypeId: typeId,
      priority: row.priority as TicketPriority,
      source: row.source as TicketSource,
      subject: subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject,
      description: row.description,
      occurredAt: run.now(),
      dueAt: BY_SLA,
      assigneeUserAccountId: null,
      links: { ...linksOf(row), parentTicketId: row.id },
      alertId: null,
    },
    createdBy: run.by,
    sourceEventId: run.by === null ? run.newId() : null,
    newId: run.newId,
    now: run.now,
    automation: { send: run.send, by: run.by, depth: depth + 1, budget: run.budget },
  })
  return { said: `follow-up ${labelOf(opened)} (${type.name}) opened.`, recorded: false }
}

/** A service as a line names it, with its article. */
const serviceWords = (service: OfficeStopService): string => `${/^[aeiou]/.test(SERVICE_NOUNS[service]) ? "an" : "a"} ${SERVICE_NOUNS[service]}`

/**
 * Plans the ticket in a route: the stop its kind is answered by that names
 * nothing but its container — an overflow's emptying, a defect's repair — on
 * the vehicle's next route that has not started, running no sooner than the
 * days ahead after its project's today as the action runs. The route is
 * locked without waiting — the office's Add stop locks a route before the
 * ticket it books, and this runs under the ticket's lock, so a route someone
 * holds is a line, never a deadlock — and judged again under the lock: still
 * the vehicle's, still that late, not started. The stop is the office's,
 * added as every door adds one (`addOfficeStop`), at the container's
 * placement in force on the route's service date. The ticket is booked to it as Add stop
 * books one, the booking's line the automation's. A ticket open, about a
 * container, and answered by no stop still planned is what it takes.
 */
async function planInRoute(tx: Tx, run: AutomationRun, row: TicketRow, planned: { projectId: string; id: string }, daysAhead: number, line: (said: string) => string): Promise<Done> {
  const kind = row.kind as TicketKind
  const service = plannedService(kind)
  if (service === undefined) throw Refused.conflict(`not planned: ${notPlannable(kind).replace(/^A/, "a")}.`)
  const [truck] = await tx
    .select({ registration: vehicle.registration, callsign: vehicle.callsign })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, run.companyId), eq(vehicle.id, planned.id)))
    .limit(1)
  const truckLabel = truck === undefined ? planned.id : vehicleLabel(truck)
  if (planned.projectId !== row.projectId) throw Refused.conflict(`not planned: vehicle ${truckLabel} works in another project.`)
  if (isClosedTicketStatus(row.status as TicketStatus)) throw Refused.conflict(`not planned: the ticket is ${row.status}, and a stop answers an open ticket.`)
  if (row.containerId === null) throw Refused.conflict(`not planned: the ticket names no container for ${serviceWords(service)}.`)
  const containerId = row.containerId
  const answering = await plannedStopAnswering(tx, run.companyId, row)
  if (answering !== undefined) throw Refused.conflict(`not planned: stop ${answering.position} of route ${answering.route} answers it already.`)

  const scope = { companyId: run.companyId, projectId: row.projectId }
  const from = addDays(await projectToday(tx, scope, run.now)(), daysAhead)
  const [next] = await tx
    .select({ id: route.id })
    .from(route)
    .where(and(eq(route.companyId, run.companyId), eq(route.projectId, row.projectId), eq(route.plannedVehicleId, planned.id), inArray(route.status, ORDER_OPEN_STATUSES), gte(route.operatingDate, from)))
    .orderBy(asc(route.operatingDate), asc(route.id))
    .limit(1)
  if (next === undefined) throw Refused.conflict(`not planned: vehicle ${truckLabel} has no route from ${from} that has not started.`)
  let chosen: { status: string; number: number; serviceDate: string; operatingDate: string; plannedVehicleId: string | null }
  try {
    ;[chosen] = await tx
      .select({ status: route.status, number: route.number, serviceDate: route.serviceDate, operatingDate: route.operatingDate, plannedVehicleId: route.plannedVehicleId })
      .from(route)
      .where(and(eq(route.companyId, run.companyId), eq(route.id, next.id)))
      .limit(1)
      .for("no key update", { noWait: true })
  } catch (error) {
    if (sqlstate(error)?.code !== LOCK_NOT_AVAILABLE) throw error
    throw Refused.conflict("not planned: the vehicle's next route is being changed by someone else; plan it by hand.")
  }
  const label = routeLabel(chosen.number)
  if (!orderIsOpen(chosen.status as RouteStatus)) throw Refused.conflict(`not planned: route ${label} has started.`)
  // Judged again under the lock: a route given another vehicle or moved earlier meanwhile is not this vehicle's next one any more.
  if (chosen.plannedVehicleId !== planned.id || chosen.operatingDate < from) throw Refused.conflict(`not planned: route ${label} changed while it was chosen; plan it by hand.`)

  const [bin] = await tx
    .select({ label: container.label })
    .from(container)
    .where(and(eq(container.companyId, run.companyId), eq(container.id, containerId)))
    .limit(1)
  const place = await placementInForce(tx, scope, containerId, chosen.serviceDate)
  if (place === undefined) throw Refused.conflict(`not planned: container ${bin?.label ?? containerId} is placed nowhere on ${chosen.serviceDate}, route ${label}'s service date.`)
  if (stopMismatch({ containerId, propertyId: row.propertyId, sharedCollectionPointId: row.sharedCollectionPointId }, { service, containerId, ...place }) !== undefined) {
    throw Refused.conflict(`not planned: on ${chosen.serviceDate} container ${bin?.label ?? containerId} stands at another place than the ticket's.`)
  }
  const stop = await addOfficeStop(tx, run.companyId, { id: next.id, projectId: row.projectId, plannedVehicleId: chosen.plannedVehicleId }, { id: run.newId(), service, containerId, ...place, note: null })
  // The same work booked once: an office stop of the container for the service, planned on the route, is someone's already.
  if (stop.kind === "booked-already") throw Refused.conflict(`not planned: route ${label} has a planned ${SERVICE_NOUNS[service]} of container ${bin?.label ?? containerId} the office added already.`)
  // The sentence opens with the vehicle's label, kept as written.
  if (stop.kind === "misfit") throw Refused.conflict(`not planned: ${stop.sentence}${stop.sentence.endsWith(".") ? "" : "."}`)
  const said = `planned as stop ${stop.position} of route ${label}, ${serviceWords(service)} on ${chosen.operatingDate}.`
  await bookTicket(tx, run.companyId, row, { pickupId: stop.id, routeId: next.id }, { body: line(said), recordedBy: null }, run.newId)
  return { said, recorded: true }
}
