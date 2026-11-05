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
import { automationNote, AUTOMATION_ACTIONS_MAX, AUTOMATION_DEPTH_MAX, AUTOMATION_SPENT, AUTOMATION_STOPPED, triggerOf, type TicketActionParameters } from "@waste/domain/resolution/automation"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { ticketTransition } from "@waste/domain/resolution/transitions"
import type { PropertyPartyRole } from "@waste/domain/registry/vocabulary"
import { isClosedTicketStatus, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketKind, type TicketMessageRecipient, type TicketPriority, type TicketResolution, type TicketSource, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { QueueMissing, type Send } from "../jobs"
import { projectAccess, userAccount } from "../schema/access"
import { propertyParty } from "../schema/customers"
import { messageTemplate } from "../schema/messaging"
import { team, ticket, ticketType, ticketTypeAction } from "../schema/resolution"
import { queueMessage } from "./messaging"
import { appendTicketEvent, BY_SLA, openTicket } from "./open-ticket"
import { emit } from "./outbox"
import { projectToday } from "./project-clock"
import { labelOf, linksOf, ticketColumns, ticketOf, type TicketRow } from "./resolution-rows"
import { Refused } from "./shared"

/** How many more actions one change's chain may run: one count every level of it shares. */
export type AutomationBudget = { left: number }

/** What a change hands the automation it may set going: the job sender a message is queued through, the account whose command set it going or null for the system's own, and, inside a chain, how deep it is and what is left of its budget. */
export type AutomationCause = { send: Send; by: string | null; depth?: number; budget?: AutomationBudget }

/** A run: the company, the cause, and the clock and the id minter the change writes with. */
export type AutomationRun = AutomationCause & { companyId: string; newId: IdMinter; now: () => Date }

type Action = { id: string; kind: TicketActionKind } & TicketActionParameters

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
