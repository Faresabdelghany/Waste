// Tickets on the prototype's records (Issue #182, slice 8 of #81, for #147):
// the cases of `operate.tickets` — the list, the office's create, the patch
// of a case's own fields, the seven commands and the comments. The wire
// shapes are the contracts' (`@waste/contracts/tickets`), imported as types
// so no zod reaches the bundle; the routes are apps/api/src/routes/tickets.ts.
//
// A ticket is `ticket-<uuid>` from the start: the fixtures' T-8831 is a
// fixture's number, never a server row's (the plan on #81, fixture ids (b)).
// Its label (`T-1001`) is the case's name in every sentence the API says, so
// it leads the row's context; its subject is the row's name.
//
// The status moves by command alone: `assign` moves the assignee and
// `start`, `wait`, `hold`, `complete`, `reject` and `reopen` the status
// (`ticketTransition`, @waste/domain/resolution/transitions, says which a
// status takes), so the adapter lists no `statuses` and a patch carries the
// case's own fields — subject, description, kind, priority, due — and never a
// status, the assignee, the source or the links the consumer set. A comment
// is appended to the history and changes nothing of the row: an action
// answering the event (`commentOnTicket`), not a command.
//
// Relations by web id through the store's resolver, the nine links each
// under its module's prefix: a route and a pickup (#179), a container (5b),
// a property and a shared point (9b), a customer, an agreement (9a), a
// driver (5a) and the parent ticket, by name once loaded and as an id chip
// until then; the assignee is a User Account of Users & roles. The assignee's
// server id rides beside its web id (`ASSIGNEE_ACCOUNT_KEY`), since what the
// list's "Mine" compares with is `/me`'s account, a server id.
import type { Ticket, TicketDetail, TicketEvent, TicketLinks } from "@waste/contracts/tickets"
import { ticketTransition, TICKET_COMMANDS, type TicketCommand } from "@waste/domain/resolution/transitions"
import { OPEN_TICKET_STATUSES, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_VISIBILITIES, type TicketStatus } from "@waste/domain/resolution/vocabulary"

import { isAgreementRecord } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { isPropertyRecord, isSharedPointRecord, NO_ONE } from "@/lib/data/properties"

import { command, create, get, listAll, patch } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, patchOf, said, stampFacts, statusLabel, statusToken, typed, webIdOf, type Client, type CommandInput, type LocalRefusal, type MappingContext, type RecordAction, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { instantOn, projectTimezoneOf, shownOn, wallClockIn } from "./clock"
import { containerAdapter } from "./containers"
import { driverAdapter } from "./fleet"
import { isCompanyRecord, userAdapter } from "./organisation"
import { pickupAdapter } from "./pickups"
import { projectServerIdOf, referenced, refusal } from "./places"
import { nameVia, referencedServerId, webIdVia } from "./references"
import { customerAdapter } from "./registry"
import { routeAdapter } from "./routes"
import type { ActionOutcome, SendAction } from "./server-records"

/** The workspace module the tickets are the rows of. */
export const TICKETS_MODULE: ModuleLocation = { workspaceId: "operate", moduleId: "tickets" }

export const TICKET_PREFIX = "ticket"

/** The submitted value a ticket record carries its assignee's server id under, for the list's "Mine" (`/me`'s account). */
export const ASSIGNEE_ACCOUNT_KEY = "assigneeAccountId"

/** The ticket's commands, by the names the dialog sends: `assign` and the machine's six. */
export const ASSIGN_TICKET = "assign"
export type TicketCommandName = typeof ASSIGN_TICKET | TicketCommand

/** The comment, an action on the ticket answering its history row. */
export const COMMENT_ON_TICKET = "comment"

/** The sources an office opens a ticket from: every one but the consumer's two (`TicketCreate.source`). */
export const OFFICE_TICKET_SOURCES = TICKET_SOURCES.filter((source) => source !== "driver-app" && source !== "dispatch")

/** Whether a loaded row is a ticket: its id, or — a row made this session, under its minted id — its kind. */
export const isTicketRecord = ofKind(TICKET_PREFIX, ["Ticket"])

/** A customer of the contacts module, a person or an organisation, never the tenant's own company. */
const isCustomer = (record: BusinessRecord) => customerAdapter.owns(record) && !isCompanyRecord(record)

/** What a ticket is about, link by link: the body's key, the id chip's prefix, the fact it is shown under, and the rule a loaded row is held to — its module adapter's own. */
export const TICKET_LINKS: ReadonlyArray<readonly [keyof TicketLinks, string, string, (record: BusinessRecord) => boolean]> = [
  ["routeId", "route", "Route", routeAdapter.owns],
  ["pickupId", "pickup", "Pickup", pickupAdapter.owns],
  ["containerId", "asset", "Container", containerAdapter.owns],
  ["propertyId", "property", "Property", isPropertyRecord],
  ["sharedCollectionPointId", "shared-point", "Shared point", isSharedPointRecord],
  ["customerId", "customer", "Customer", isCustomer],
  ["agreementId", "agreement", "Agreement", isAgreementRecord],
  ["driverId", "driver", "Driver", driverAdapter.owns],
  ["parentTicketId", TICKET_PREFIX, "Parent ticket", isTicketRecord],
]

/** The links an office's form names, each by a picker: the pickup comes with its route from the consumer alone, and the parent is set by nobody here. */
export const OFFICE_TICKET_LINKS = TICKET_LINKS.filter(([key]) => key !== "pickupId" && key !== "parentTicketId")

/** Whether a status is one of the four open ones: what the list opens on and the sidebar counts. */
export const isOpenTicketStatus = (status: string): boolean => (OPEN_TICKET_STATUSES as readonly string[]).includes(status)

/** The project a ticket is in: its web id, its name, its clock. */
function projectOf(projectId: string, context: MappingContext): { webId: string; name?: string; timezone?: string } {
  const record = context.resolve.byServerId(projectId)
  const { webId, name } = referenced(context, "project", projectId)
  return { webId, name, timezone: record === undefined ? undefined : typed(record, "timezone") }
}

export function toTicketRecord(ticket: Ticket, context: MappingContext): BusinessRecord {
  const project = projectOf(ticket.projectId, context)
  const assignee = ticket.assigneeUserAccountId === null ? undefined : nameVia(context, "user", ticket.assigneeUserAccountId)
  const links = TICKET_LINKS.flatMap(([key, prefix, fact]) => {
    const serverId = ticket.links[key]
    return serverId === null ? [] : [{ key, fact, webId: webIdVia(context, prefix, serverId), name: nameVia(context, prefix, serverId) }]
  })
  const facts: Record<string, string> = {
    Ticket: ticket.label,
    Kind: statusLabel(ticket.kind),
    Priority: statusLabel(ticket.priority),
    Assignee: assignee ?? "Unassigned",
    // The wire's source under a fact of its own: the fixtures' "Source" is another vocabulary.
    "Opened via": statusLabel(ticket.source),
    Occurred: shownOn(ticket.occurredAt, project.timezone),
    Due: ticket.dueAt === null ? "None" : shownOn(ticket.dueAt, project.timezone),
    Project: project.name ?? project.webId,
  }
  for (const link of links) facts[link.fact] = link.name
  if (ticket.resolution !== null) facts.Resolution = statusLabel(ticket.resolution)
  if (ticket.recollectionRouteId !== null) facts["Re-collection route"] = nameVia(context, "route", ticket.recollectionRouteId)
  if (ticket.closedAt !== null) facts.Closed = shownOn(ticket.closedAt, project.timezone)
  const linked = Object.fromEntries(TICKET_LINKS.map(([key, prefix]) => [key, ticket.links[key] === null ? "" : webIdVia(context, prefix, ticket.links[key] as string)]))
  return {
    id: webIdOf(TICKET_PREFIX, ticket.id),
    name: ticket.subject,
    context: [ticket.label, ...links.map((link) => link.name)].join(" · "),
    status: statusLabel(ticket.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(ticket, context.now),
    owner: assignee ?? "Unassigned",
    value: ticket.dueAt === null ? "No due date" : `Due ${shownOn(ticket.dueAt, project.timezone)}`,
    description: ticket.description,
    related: links.map((link) => `${link.fact} ${link.name}`),
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    recordKind: "Ticket",
    submittedValues: {
      projectId: project.webId,
      label: ticket.label,
      subject: ticket.subject,
      description: ticket.description,
      kind: ticket.kind,
      priority: ticket.priority,
      source: ticket.source,
      status: ticket.status,
      occurredAt: wallClockIn(ticket.occurredAt, project.timezone),
      dueAt: ticket.dueAt === null ? "" : wallClockIn(ticket.dueAt, project.timezone),
      assigneeUserAccountId: ticket.assigneeUserAccountId === null ? "" : webIdVia(context, "user", ticket.assigneeUserAccountId),
      [ASSIGNEE_ACCOUNT_KEY]: ticket.assigneeUserAccountId ?? "",
      ...linked,
      resolution: ticket.resolution ?? "",
      recollectionRouteId: ticket.recollectionRouteId === null ? "" : webIdVia(context, "route", ticket.recollectionRouteId),
    },
  }
}

// ---------------------------------------------------------------------------
// The office's writes
// ---------------------------------------------------------------------------

/** A closed-list token a form typed, held to the list; undefined for blank. */
function tokenIn(record: BusinessRecord, key: string, tokens: readonly string[], sentence: string): string | undefined | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return undefined
  const token = statusToken(text)
  return tokens.includes(token) ? token : refusal(key, sentence)
}

/** An instant a form spelled on the project's clock; undefined for blank; a refusal for text that is no time. */
function instantIn(record: BusinessRecord, key: string, timezone: string | undefined, sentence: string): string | undefined | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return undefined
  return instantOn(text, timezone) ?? refusal(key, sentence)
}


/** The link a form names under `key`, as a server id held to its module's kind; undefined for blank or the picker's None; a refusal for a row the API does not hold. */
function linkOf(record: BusinessRecord, key: string, prefix: string, fact: string, owns: (record: BusinessRecord) => boolean, context: MappingContext): string | undefined | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined || webId === NO_ONE) return undefined
  const noun = fact.toLowerCase()
  return referencedServerId(webId, prefix, context, { owns }) ?? refusal(key, `Pick ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun} the API holds`)
}

/** Whether a loaded row is an alert — the alerts' own rule, spelled here since their adapter is built on this one's. */
const isAlertRecord = ofKind("alert", ["Alert"])

/** The assignee a form names, as a User Account's server id; null for nobody — blank, or the picker's None; a refusal for anyone the API does not hold. */
function assigneeOf(webId: string | undefined, key: string, context: MappingContext): string | null | LocalRefusal {
  if (webId === undefined || webId === NO_ONE) return null
  return referencedServerId(webId, "user", context, { owns: userAdapter.owns }) ?? refusal(key, "Pick an account the API holds")
}

const KIND_SENTENCE = `Pick a kind the API knows: ${TICKET_KINDS.join(", ")}`
const PRIORITY_SENTENCE = `Pick a priority the API knows: ${TICKET_PRIORITIES.join(", ")}`
const SOURCE_SENTENCE = `Pick where the case came from: ${OFFICE_TICKET_SOURCES.join(", ")}`
const A_TIME = "Give the time as a date and a time"

/**
 * `POST /tickets` from the office's form: the project, the case's words, its
 * kind and priority, where it came from among the office's six, when it
 * happened and when it is due on the project's clock, who works it, what it
 * is about, and the alert it answers (`alertId`, the alert's Open ticket).
 */
export function toTicketCreateBody(record: BusinessRecord, context: MappingContext): unknown | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const subject = typed(record, "subject") ?? (record.name.trim() === "" ? undefined : record.name.trim())
  if (subject === undefined) return refusal("subject", "A ticket needs a subject")
  const description = typed(record, "description")
  if (description === undefined) return refusal("description", "Say what the case is about")
  const kind = tokenIn(record, "kind", TICKET_KINDS, KIND_SENTENCE)
  if (kind === undefined) return refusal("kind", "Pick the kind of case")
  if (isLocalRefusal(kind)) return kind
  const priority = tokenIn(record, "priority", TICKET_PRIORITIES, PRIORITY_SENTENCE)
  if (isLocalRefusal(priority)) return priority
  const source = tokenIn(record, "source", OFFICE_TICKET_SOURCES, SOURCE_SENTENCE)
  if (isLocalRefusal(source)) return source
  const timezone = projectTimezoneOf(record, context)
  const occurredAt = instantIn(record, "occurredAt", timezone, A_TIME)
  if (isLocalRefusal(occurredAt)) return occurredAt
  const dueAt = instantIn(record, "dueAt", timezone, A_TIME)
  if (isLocalRefusal(dueAt)) return dueAt
  const assignee = assigneeOf(typed(record, "assigneeUserAccountId"), "assigneeUserAccountId", context)
  if (isLocalRefusal(assignee)) return assignee
  const links: Record<string, string> = {}
  for (const [key, prefix, fact, owns] of OFFICE_TICKET_LINKS) {
    const serverId = linkOf(record, key, prefix, fact, owns, context)
    if (isLocalRefusal(serverId)) return serverId
    if (serverId !== undefined) links[key] = serverId
  }
  const alertId = linkOf(record, "alertId", "alert", "Alert", isAlertRecord, context)
  if (isLocalRefusal(alertId)) return alertId
  return {
    projectId,
    subject,
    description,
    kind,
    ...(priority === undefined ? {} : { priority }),
    ...(source === undefined ? {} : { source }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(assignee === null ? {} : { assigneeUserAccountId: assignee }),
    ...(Object.keys(links).length === 0 ? {} : { links }),
    ...(alertId === undefined ? {} : { alertId }),
  }
}

/** `PATCH /tickets/:id`: what moved of the case's own fields — never the status, the assignee, the source or the links. */
export function toTicketPatchBody(before: BusinessRecord, after: BusinessRecord, context: MappingContext): unknown | null | LocalRefusal {
  for (const [key, tokens, sentence] of [
    ["kind", TICKET_KINDS, KIND_SENTENCE],
    ["priority", TICKET_PRIORITIES, PRIORITY_SENTENCE],
  ] as const) {
    const token = tokenIn(after, key, tokens, sentence)
    if (isLocalRefusal(token)) return token
  }
  if (typed(after, "subject") === undefined) return refusal("subject", "A ticket needs a subject")
  if (typed(after, "description") === undefined) return refusal("description", "Say what the case is about")
  const timezone = projectTimezoneOf(after, context)
  const due = instantIn(after, "dueAt", timezone, A_TIME)
  if (isLocalRefusal(due)) return due
  return patchOf(before, after, (record) => ({
    subject: typed(record, "subject"),
    description: typed(record, "description"),
    kind: typed(record, "kind") === undefined ? undefined : statusToken(typed(record, "kind") as string),
    priority: typed(record, "priority") === undefined ? undefined : statusToken(typed(record, "priority") as string),
    // A cleared due is null, which clears it; the instant is compared, not the spelling.
    dueAt: typed(record, "dueAt") === undefined ? null : instantOn(typed(record, "dueAt") as string, timezone),
  }))
}

// ---------------------------------------------------------------------------
// The seven commands and the comment
// ---------------------------------------------------------------------------
//
// Each command answers the ticket as it now stands, which replaces the row;
// each body is the contracts' (`TicketAssign` … `TicketReopen`), always an
// object, since the API reads every one as JSON. A note the command needs is
// refused here before the API sees a blank.

const RESOLUTION_SENTENCE = `Pick what the ticket ended in: ${TICKET_RESOLUTIONS.join(", ")}`

/** A note the input says, or the refusal in the command's words where the command needs one. */
const needed = (input: CommandInput, key: string, sentence: string): string | LocalRefusal => said(input, key) ?? refusal(key, sentence)

const onTicket = (verb: string, past: string, toBody: NonNullable<RecordCommand<Ticket>["toBody"]>): RecordCommand<Ticket> => ({
  toBody,
  run: (client, serverId, body) => command<Ticket>(client, `/tickets/${serverId}/${verb}`, body),
  refused: (record) => `${record.name} was not ${past}`,
})

const withNote = (note: string | LocalRefusal, field = "note") => (isLocalRefusal(note) ? note : { [field]: note })

export const TICKET_COMMANDS_BY_NAME = {
  [ASSIGN_TICKET]: onTicket("assign", "assigned", (input, _record, context) => {
    const assignee = assigneeOf(said(input, "assigneeUserAccountId"), "assigneeUserAccountId", context)
    if (isLocalRefusal(assignee)) return assignee
    const note = said(input, "note")
    return { assigneeUserAccountId: assignee, ...(note === undefined ? {} : { note }) }
  }),
  start: onTicket("start", "started", (input) => {
    const note = said(input, "note")
    return note === undefined ? {} : { note }
  }),
  wait: onTicket("wait", "set waiting for the customer", (input) => withNote(needed(input, "note", "Say what the ticket waits for from the customer"))),
  hold: onTicket("hold", "put on hold", (input) => withNote(needed(input, "note", "Say what the ticket is held for"))),
  complete: onTicket("complete", "completed", (input, _record, context) => {
    const text = said(input, "resolution")
    if (text === undefined) return refusal("resolution", "Pick what the ticket ended in")
    const resolution = statusToken(text)
    if (!(TICKET_RESOLUTIONS as readonly string[]).includes(resolution)) return refusal("resolution", RESOLUTION_SENTENCE)
    const note = needed(input, "note", "Say how the case was resolved")
    if (isLocalRefusal(note)) return note
    if (resolution !== "recollected") return { resolution, note }
    // A re-collection rides on a real Route, picked from the Routes module: never a typed label (#126).
    const routeWebId = said(input, "recollectionRouteId")
    if (routeWebId === undefined) return refusal("recollectionRouteId", "Pick the route the re-collection rides on")
    const recollectionRouteId = referencedServerId(routeWebId, "route", context, { owns: routeAdapter.owns })
    if (recollectionRouteId === undefined) return refusal("recollectionRouteId", "Pick a route the API holds")
    return { resolution, note, recollectionRouteId }
  }),
  reject: onTicket("reject", "rejected", (input) => withNote(needed(input, "reason", "Say why the ticket is rejected"), "reason")),
  reopen: onTicket("reopen", "reopened", (input) => withNote(needed(input, "note", "Say why the ticket is reopened"))),
} satisfies Record<TicketCommandName, RecordCommand<Ticket>>

/**
 * Whether the dialog offers a machine command on a ticket in this status:
 * where the domain's machine moves it, and nowhere else — not where it
 * refuses (a closed ticket takes `reopen` alone), nor where it stays: a
 * `stay` is the API's idempotent answer to a retry, which writes nothing and
 * would drop the note a person was asked for (coordinator's decision on
 * #182). `assign` moves no status and is offered while the ticket is open,
 * as the API takes it.
 */
export function offersTicketCommand(status: TicketStatus, name: TicketCommandName, label: string): boolean {
  if (name === ASSIGN_TICKET) return isOpenTicketStatus(status)
  return ticketTransition(status, name, label).kind === "move"
}

/** The machine's six, in the order the dialog offers them. */
export const TICKET_MACHINE_COMMANDS: readonly TicketCommand[] = TICKET_COMMANDS

const COMMENT: RecordAction<TicketEvent> = {
  toBody: (input) => {
    const body = said(input, "body")
    if (body === undefined) return refusal("body", "Write the comment")
    const visibility = said(input, "visibility") ?? "internal"
    if (!(TICKET_VISIBILITIES as readonly string[]).includes(visibility)) return refusal("visibility", `A comment is ${TICKET_VISIBILITIES.join(" or ")}`)
    return { body, visibility }
  },
  run: (client, serverId, body) => command<TicketEvent>(client, `/tickets/${serverId}/comments`, body),
  refused: (record) => `The comment on ${record.name} was not added`,
}

/** Appends a comment to a ticket's history — internal unless said to be the customer's — through the store's `sendAction`; the row stays as it is. */
export function commentOnTicket(sendAction: SendAction, recordId: string, input: { body: string; visibility: string }, options?: { report?: boolean }): Promise<ActionOutcome<TicketEvent>> {
  return sendAction(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId, recordId, COMMENT_ON_TICKET, input, options) as Promise<ActionOutcome<TicketEvent>>
}

/** The ticket as its own read gives it: its history in recording order and the alerts naming it. */
export function ticketDetail(client: Client, serverId: string): Promise<TicketDetail> {
  return get<TicketDetail>(client, `/tickets/${serverId}`)
}

export const ticketAdapter: ResourceAdapter<Ticket> = {
  prefix: TICKET_PREFIX,
  owns: isTicketRecord,
  // Open, in progress, pending, on hold, completed and rejected move by the commands alone.
  statuses: undefined,
  list: (client) => listAll<Ticket>(client, "/tickets"),
  toRecord: toTicketRecord,
  toCreateBody: toTicketCreateBody,
  toPatchBody: toTicketPatchBody,
  create: (client, body) => create<Ticket>(client, "/tickets", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Ticket>(client, `/tickets/${serverId}`, body),
  commands: TICKET_COMMANDS_BY_NAME,
  actions: { [COMMENT_ON_TICKET]: COMMENT as RecordAction<unknown> },
}

/** Operate › Tickets: the cases the office and the consumer open, worked through their commands and their history. */
export const ticketsModule: ServerModule = {
  workspaceId: TICKETS_MODULE.workspaceId,
  moduleId: TICKETS_MODULE.moduleId,
  resources: [ticketAdapter],
}
