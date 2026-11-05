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
// ahead at the earliest, written as the office's Add stop writes it and the
// worker's fill-driven emptying does (commands/fill-emptying.ts), and booked
// to the ticket through `bookTicket` (commands/ticket-stops.ts).
import { routeLabel } from "@waste/contracts/execution"
import { SERVICE_NOUNS } from "@waste/domain/execution/services"
import { stopMismatch } from "@waste/domain/execution/ticket-stops"
import type { OfficeStopService } from "@waste/domain/execution/vocabulary"
import { automationNote, AUTOMATION_ACTIONS_MAX, AUTOMATION_DEPTH_MAX, AUTOMATION_SPENT, AUTOMATION_STOPPED, notPlannable, plannedService, triggerOf, type TicketActionParameters } from "@waste/domain/resolution/automation"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { ticketTransition } from "@waste/domain/resolution/transitions"
import type { PropertyPartyRole } from "@waste/domain/registry/vocabulary"
import { isClosedTicketStatus, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketKind, type TicketMessageRecipient, type TicketPriority, type TicketResolution, type TicketSource, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, gte, inArray, isNull, lte, max, or, sql } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { QueueMissing, type Send } from "../jobs"
import { projectAccess, userAccount } from "../schema/access"
import { container } from "../schema/containers"
import { propertyParty } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { vehicle } from "../schema/fleet"
import { messageTemplate } from "../schema/messaging"
import { team, ticket, ticketType, ticketTypeAction } from "../schema/resolution"
import { queueMessage } from "./messaging"
import { placementStopOn } from "./fill-emptying"
import { misfitOf, pickupFitStops, vehicleLabel } from "./fleet-fit"
import { appendTicketEvent, BY_SLA, openTicket } from "./open-ticket"
import { emit } from "./outbox"
import { projectToday } from "./project-clock"
import { labelOf, linksOf, ticketColumns, ticketOf, type TicketRow } from "./resolution-rows"
import { lockRow, Refused } from "./shared"
import { bookTicket } from "./ticket-stops"

/** How many more actions one change's chain may run: one count every level of it shares. */
export type AutomationBudget = { left: number }

/** What a change hands the automation it may set going: the job sender a message is queued through, the account whose command set it going or null for the system's own, and, inside a chain, how deep it is and what is left of its budget. */
export type AutomationCause = { send: Send; by: string | null; depth?: number; budget?: AutomationBudget }

/** A run: the company, the cause, and the clock and the id minter the change writes with. */
export type AutomationRun = AutomationCause & { companyId: string; newId: IdMinter; now: () => Date }

type Action = { id: string; kind: TicketActionKind; vehicleProjectId: string | null } & TicketActionParameters

/** What an action did: its line, and whether it wrote its own history row carrying the line, as a move and an assignment do. */
type Done = { said: string; recorded: boolean }

/** The ticket as it stands in this transaction. */
async function ticketRow(tx: Tx, companyId: string, id: string): Promise<TicketRow> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, id)))
    .limit(1)
  if (row === undefined) throw new Error(`ticket ${id} of company ${companyId} is not there for its automation`)
  return row
}

const refOf = (companyId: string, row: TicketRow) => ({ companyId, projectId: row.projectId, id: row.id })

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
  const first = await ticketRow(tx, run.companyId, ticketId)
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
    await appendTicketEvent(tx, refOf(run.companyId, first), commentOf(first, AUTOMATION_STOPPED), run.newId)
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
      await appendTicketEvent(tx, refOf(run.companyId, first), commentOf(await ticketRow(tx, run.companyId, ticketId), AUTOMATION_SPENT), run.newId)
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
      const now = await ticketRow(tx, run.companyId, ticketId)
      await appendTicketEvent(tx, refOf(run.companyId, now), commentOf(now, line(done.said)), run.newId)
    }
  }

  /** One action on the ticket as it now stands. */
  async function perform(tx: Tx, run: AutomationRun, depth: number, action: Action, line: (said: string) => string): Promise<Done> {
    const row = await ticketRow(tx, run.companyId, ticketId)
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

/** Hands the ticket to an active team of the company. */
async function assignTeam(tx: Tx, run: AutomationRun, row: TicketRow, teamId: string): Promise<Done> {
  const [found] = await tx
    .select({ name: team.name, status: team.status })
    .from(team)
    .where(and(eq(team.companyId, run.companyId), eq(team.id, teamId)))
    .limit(1)
  if (found === undefined || found.status !== "active") throw new Refused(409, `not handed to team ${JSON.stringify(found?.name ?? teamId)}, which is retired.`)
  if (isClosedTicketStatus(row.status as TicketStatus)) throw new Refused(409, `not handed to team ${found.name}: the ticket is ${row.status} and keeps its team.`)
  if (row.teamId === teamId) return { said: `already with team ${found.name}.`, recorded: false }
  await tx
    .update(ticket)
    .set({ teamId })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
  return { said: `handed to team ${found.name}.`, recorded: false }
}

/** Assigns the ticket to an active account working in its project: the `assigned` row with the line as its note, and `ticket-assigned` as the office's assign writes it. */
async function assignPerson(tx: Tx, run: AutomationRun, row: TicketRow, userAccountId: string, line: (said: string) => string): Promise<Done> {
  const [found] = await tx
    .select({ name: userAccount.fullName, allProjects: userAccount.allProjects, deactivatedAt: userAccount.deactivatedAt, serviceProviderId: userAccount.serviceProviderId })
    .from(userAccount)
    .where(and(eq(userAccount.companyId, run.companyId), eq(userAccount.id, userAccountId)))
    .limit(1)
  if (found === undefined || found.deactivatedAt !== null || found.serviceProviderId !== null) throw new Refused(409, `not assigned to ${found?.name ?? "the person named"}, who no longer works tickets here.`)
  if (!found.allProjects) {
    const [access] = await tx
      .select({ id: projectAccess.id })
      .from(projectAccess)
      .where(and(eq(projectAccess.companyId, run.companyId), eq(projectAccess.userAccountId, userAccountId), eq(projectAccess.projectId, row.projectId)))
      .limit(1)
    if (access === undefined) throw new Refused(409, `not assigned to ${found.name}, who does not work in this ticket's project.`)
  }
  if (isClosedTicketStatus(row.status as TicketStatus)) throw new Refused(409, `not assigned to ${found.name}: the ticket is ${row.status} and keeps its assignee.`)
  if (row.assigneeUserAccountId === userAccountId) return { said: `already assigned to ${found.name}.`, recorded: false }
  const [assigned] = await tx
    .update(ticket)
    .set({ assigneeUserAccountId: userAccountId })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
    .returning(ticketColumns)
  const said = `assigned to ${found.name}.`
  await appendTicketEvent(tx, refOf(run.companyId, assigned), { kind: "assigned", status: assigned.status as TicketStatus, assigneeUserAccountId: userAccountId, resolution: null, body: line(said), visibility: "internal", objectKey: null, recordedBy: null, sourceEventId: null }, run.newId)
  await emit(tx, run, { aggregate: "ticket", aggregateId: assigned.id, kind: "ticket-assigned", payload: ticketOf(assigned), projectId: assigned.projectId, occurredAt: run.now() })
  return { said, recorded: true }
}

/** Sets the ticket's priority. */
async function setPriority(tx: Tx, run: AutomationRun, row: TicketRow, priority: TicketPriority): Promise<Done> {
  const words = priority.replaceAll("-", " ")
  if (isClosedTicketStatus(row.status as TicketStatus)) throw new Refused(409, `priority not set to ${words}: the ticket is ${row.status} and keeps its priority.`)
  if (row.priority === priority) return { said: `priority already ${words}.`, recorded: false }
  await tx
    .update(ticket)
    .set({ priority })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
  return { said: `priority set to ${words}.`, recorded: false }
}

/**
 * Moves the ticket by the command, as the office's command writes it — the
 * status, a completion's resolution and its instant, a rejection's instant,
 * the `status-changed` row with the line as its note, `ticket-completed` or
 * `ticket-rejected` — and runs the trigger it reaches one level deeper. A
 * move the machine refuses is the line; one already made is too.
 */
async function setStatus(tx: Tx, run: AutomationRun, depth: number, row: TicketRow, command: TicketActionCommand, resolution: string | null, line: (said: string) => string): Promise<Done> {
  const transition = ticketTransition(row.status as TicketStatus, command, labelOf(row))
  if (transition.kind === "refuse") throw new Refused(409, `${transition.sentence}.`)
  const words = (status: string) => status.replaceAll("-", " ")
  if (transition.kind === "stay") return { said: `already ${words(row.status)}.`, recorded: false }
  const at = run.now()
  const closing = transition.to === "completed" ? { resolution, closedAt: at } : transition.to === "rejected" ? { closedAt: at } : {}
  const [moved] = await tx
    .update(ticket)
    .set({ status: transition.to, ...closing })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, row.id)))
    .returning(ticketColumns)
  const said = transition.to === "completed" ? `completed, ${words(resolution as string)}.` : `moved to ${words(transition.to)}.`
  await appendTicketEvent(
    tx,
    refOf(run.companyId, moved),
    { kind: "status-changed", status: transition.to, assigneeUserAccountId: moved.assigneeUserAccountId, resolution: transition.to === "completed" ? (resolution as TicketResolution) : null, body: line(said), visibility: "internal", objectKey: null, recordedBy: null, sourceEventId: null },
    run.newId,
  )
  if (transition.to === "completed" || transition.to === "rejected") {
    await emit(tx, run, { aggregate: "ticket", aggregateId: moved.id, kind: transition.to === "completed" ? "ticket-completed" : "ticket-rejected", payload: ticketOf(moved), projectId: moved.projectId, occurredAt: at })
  }
  const reached = triggerOf(transition.to)
  if (reached !== undefined) await runTicketAutomation(tx, { ...run, depth: depth + 1 }, moved.id, reached)
  return { said, recorded: true }
}

/** The customer a message goes to: the ticket's own, or the one in the role at its property on the project's day. */
async function recipientOf(tx: Tx, run: AutomationRun, row: TicketRow, recipient: TicketMessageRecipient): Promise<string> {
  if (recipient === "ticket-customer") {
    if (row.customerId === null) throw new Refused(409, "not sent: the ticket names no customer.")
    return row.customerId
  }
  const role: PropertyPartyRole = recipient
  if (row.propertyId === null) throw new Refused(409, `not sent: the ticket names no property to find its ${role.replaceAll("-", " ")} at.`)
  const day = await projectToday(tx, { companyId: run.companyId, projectId: row.projectId }, run.now)()
  const [party] = await tx
    .select({ customerId: propertyParty.customerId })
    .from(propertyParty)
    .where(and(eq(propertyParty.companyId, run.companyId), eq(propertyParty.propertyId, row.propertyId), eq(propertyParty.role, role), lte(propertyParty.validFrom, day), or(isNull(propertyParty.validTo), gt(propertyParty.validTo, day))))
    .orderBy(asc(propertyParty.id))
    .limit(1)
  if (party === undefined) throw new Refused(409, `not sent: the property has no ${role.replaceAll("-", " ")} today.`)
  return party.customerId
}

/** Queues the ticket's project's active template of the name to the recipient, with the ticket's number to fill. */
async function sendMessage(tx: Tx, run: AutomationRun, row: TicketRow, name: string, recipient: TicketMessageRecipient): Promise<Done> {
  const [template] = await tx
    .select({ id: messageTemplate.id })
    .from(messageTemplate)
    .where(and(eq(messageTemplate.companyId, run.companyId), eq(messageTemplate.projectId, row.projectId), eq(messageTemplate.name, name), eq(messageTemplate.status, "active")))
    .limit(1)
  if (template === undefined) throw new Refused(409, `not sent: this ticket's project has no active message template ${JSON.stringify(name)}.`)
  const customerId = await recipientOf(tx, run, row, recipient)
  try {
    const queued = await queueMessage(tx, run.send, { id: run.newId(), companyId: run.companyId, templateId: template.id, customerId, contactId: null, values: { ticketNumber: labelOf(row) } })
    return { said: `message ${JSON.stringify(name)} queued to ${queued.recipient}.`, recorded: false }
  } catch (error) {
    if (error instanceof Refused) throw new Refused(409, `message ${JSON.stringify(name)} not sent: ${error.message}`)
    if (error instanceof QueueMissing) throw new Refused(409, `message ${JSON.stringify(name)} not sent: the worker has not made its queues yet.`)
    throw error
  }
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
  if (type === undefined || type.status !== "active") throw new Refused(409, `no follow-up opened: the ticket type ${JSON.stringify(type?.name ?? typeId)} is retired.`)
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

/** The routes a stop may still be added to: not started. */
const NOT_STARTED = ["planned", "ready"] as const

/** A service as a line names it, with its article. */
const serviceWords = (service: OfficeStopService): string => `${/^[aeiou]/.test(SERVICE_NOUNS[service]) ? "an" : "a"} ${SERVICE_NOUNS[service]}`

/**
 * Plans the ticket in a route: the stop its kind is answered by that names
 * nothing but its container — an overflow's emptying, a defect's repair — on
 * the vehicle's next route that has not started, running no sooner than the
 * days ahead after its project's today. The stop is the office's, `planned`,
 * after the route's last position, at the container's placement in force on
 * the route's service date, never the same work twice while it is planned,
 * and only where the vehicle takes it; the route's `updatedAt` moves and no
 * event is written, as Add stop's. The ticket is booked to it as Add stop
 * books one, the booking's line the automation's. A ticket open, about a
 * container, and answered by no stop still planned is what it takes.
 */
async function planInRoute(tx: Tx, run: AutomationRun, row: TicketRow, planned: { projectId: string; id: string }, daysAhead: number, line: (said: string) => string): Promise<Done> {
  const kind = row.kind as TicketKind
  const service = plannedService(kind)
  if (service === undefined) throw new Refused(409, `not planned: ${notPlannable(kind).replace(/^A/, "a")}.`)
  const [truck] = await tx
    .select({ registration: vehicle.registration, callsign: vehicle.callsign })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, run.companyId), eq(vehicle.id, planned.id)))
    .limit(1)
  const truckLabel = truck === undefined ? planned.id : vehicleLabel(truck)
  if (planned.projectId !== row.projectId) throw new Refused(409, `not planned: vehicle ${truckLabel} works in another project.`)
  if (isClosedTicketStatus(row.status as TicketStatus)) throw new Refused(409, `not planned: the ticket is ${row.status}, and a stop answers an open ticket.`)
  if (row.containerId === null) throw new Refused(409, `not planned: the ticket names no container for ${serviceWords(service)}.`)
  const containerId = row.containerId
  if (row.bookedPickupId !== null) {
    const [booked] = await tx
      .select({ status: pickup.status, position: pickup.position, number: route.number })
      .from(pickup)
      .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
      .where(and(eq(pickup.companyId, run.companyId), eq(pickup.id, row.bookedPickupId)))
      .limit(1)
    if (booked?.status === "planned") throw new Refused(409, `not planned: stop ${booked.position} of route ${routeLabel(booked.number)} answers it already.`)
  }

  const scope = { companyId: run.companyId, projectId: row.projectId }
  const from = addDays(await projectToday(tx, scope, run.now)(), daysAhead)
  const [next] = await tx
    .select({ id: route.id })
    .from(route)
    .where(and(eq(route.companyId, run.companyId), eq(route.projectId, row.projectId), eq(route.plannedVehicleId, planned.id), inArray(route.status, [...NOT_STARTED]), gte(route.operatingDate, from)))
    .orderBy(asc(route.operatingDate), asc(route.id))
    .limit(1)
  if (next === undefined) throw new Refused(409, `not planned: vehicle ${truckLabel} has no route from ${from} that has not started.`)
  await lockRow(tx, route, { companyId: run.companyId, id: next.id })
  const [chosen] = await tx
    .select({ status: route.status, number: route.number, serviceDate: route.serviceDate, operatingDate: route.operatingDate })
    .from(route)
    .where(and(eq(route.companyId, run.companyId), eq(route.id, next.id)))
    .limit(1)
  const label = routeLabel(chosen.number)
  if (!(NOT_STARTED as readonly string[]).includes(chosen.status)) throw new Refused(409, `not planned: route ${label} has started.`)

  const [bin] = await tx
    .select({ label: container.label })
    .from(container)
    .where(and(eq(container.companyId, run.companyId), eq(container.id, containerId)))
    .limit(1)
  const place = await placementStopOn(tx, scope, containerId, chosen.serviceDate)
  if (place === undefined) throw new Refused(409, `not planned: container ${bin?.label ?? containerId} is placed nowhere on ${chosen.serviceDate}, route ${label}'s service date.`)
  if (stopMismatch({ containerId, propertyId: row.propertyId, sharedCollectionPointId: row.sharedCollectionPointId }, { service, containerId, ...place }) !== undefined) {
    throw new Refused(409, `not planned: on ${chosen.serviceDate} container ${bin?.label ?? containerId} stands at another place than the ticket's.`)
  }
  // The same work booked once: an office stop of the container for the service, planned on the route, is someone's already.
  const [booked] = await tx
    .select({ id: pickup.id })
    .from(pickup)
    .where(and(eq(pickup.companyId, run.companyId), eq(pickup.routeId, next.id), eq(pickup.containerId, containerId), eq(pickup.origin, "office"), eq(pickup.service, service), eq(pickup.status, "planned")))
    .limit(1)
  if (booked !== undefined) throw new Refused(409, `not planned: route ${label} has a planned ${SERVICE_NOUNS[service]} of container ${bin?.label ?? containerId} the office added already.`)

  const [last] = await tx
    .select({ position: max(pickup.position) })
    .from(pickup)
    .where(and(eq(pickup.companyId, run.companyId), eq(pickup.routeId, next.id)))
  const [stop] = await tx
    .insert(pickup)
    .values({ id: run.newId(), ...scope, routeId: next.id, position: (last?.position ?? 0) + 1, origin: "office", service, status: "planned", containerId, ...place, note: null })
    .returning({ id: pickup.id, position: pickup.position })
  // The action's savepoint takes the stop back where the vehicle cannot take it.
  const misfit = await misfitOf(tx, run.companyId, planned.id, await pickupFitStops(tx, run.companyId, [stop.id]))
  if (misfit !== undefined) throw new Refused(409, `not planned: ${misfit.replace(/^[A-Z]/, (first) => first.toLowerCase())}${misfit.endsWith(".") ? "" : "."}`)
  await tx
    .update(route)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(route.companyId, run.companyId), eq(route.id, next.id)))
  const said = `planned as stop ${stop.position} of route ${label}, ${serviceWords(service)} on ${chosen.operatingDate}.`
  await bookTicket(tx, run.companyId, row, { pickupId: stop.id, routeId: next.id }, { body: line(said), recordedBy: null }, run.newId)
  return { said, recorded: true }
}
