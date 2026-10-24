// Tickets on the prototype's records (Issue #182, slice 8 of #81, for #147):
// the cases of `operate.tickets` — the list, the office's create, the patch
// of a case's own fields, the seven commands and the comments. The wire
// shapes are the contracts' (`@waste/contracts/tickets`), imported as types
// so no zod reaches the bundle; the routes are apps/api/src/routes/tickets.ts.
//
// A ticket is `ticket-<uuid>` from the start: the fixtures' T-8831 is a
// fixture's number, never a server row's (the plan on #81, fixture ids (b)).
// Its label (`T-1001`) is the case's name in every sentence the API says, a
// fact of its own (`TICKET_NUMBER_FACT`), since the table's title column is
// already headed Ticket (#253); its subject is the row's name. The row's
// context is what the module's column heads it, Customer · property: the
// customer and the place the ticket names, each once, and nothing where it
// names neither; its other links are facts of their own, the route and the
// container among the table's columns.
//
// The status moves by command alone: `assign` moves the assignee and
// `start`, `wait`, `hold`, `complete`, `reject` and `reopen` the status
// (`ticketTransition`, @waste/domain/resolution/transitions, says which a
// status takes), so the adapter lists no `statuses` and a patch carries the
// case's own fields — subject, description, kind, priority, due — and never a
// status, the assignee, the source or the links the consumer set. A comment
// is appended to the history and changes nothing of the row: an action
// answering the event (`commentOnTicket`), not a command. A reply with the
// stop's record (M6 of #293) is a command, since it may complete the case:
// the API answers the ticket with its history, which replaces the row.
//
// Relations by web id through the store's resolver, the nine links each
// under its module's prefix: a route and a pickup (#179), a container (5b),
// a property and a shared point (9b), a customer, an agreement (9a), a
// driver (5a) and the parent ticket, by name once loaded and as an id chip
// until then; the assignee is a User Account of Users & roles. The assignee's
// server id rides beside its web id (`ASSIGNEE_ACCOUNT_KEY`), since what the
// list's "Mine" compares with is `/me`'s account, a server id.
import type { EvidenceProof, StopEvidence, Ticket, TicketDetail, TicketEvent, TicketEvidence, TicketLinks } from "@waste/contracts/tickets"
import { slaStateOf, type SlaState } from "@waste/domain/resolution/sla"
import { ticketTransition, TICKET_COMMANDS, type TicketCommand } from "@waste/domain/resolution/transitions"
import { isBillableResolution, OPEN_TICKET_STATUSES, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_VISIBILITIES, type TicketResolution, type TicketStatus } from "@waste/domain/resolution/vocabulary"

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
import { productAdapter } from "./pricing"
import { nameVia, referencedServerId, webIdVia } from "./references"
import { customerAdapter } from "./registry"
import { routeAdapter } from "./routes"
import type { ActionOutcome, SendAction } from "./server-records"

/** The workspace module the tickets are the rows of. */
export const TICKETS_MODULE: ModuleLocation = { workspaceId: "operate", moduleId: "tickets" }

export const TICKET_PREFIX = "ticket"

/** The fact a ticket record carries its label under (`T-1001`): never "Ticket", the table's title column's heading (#253). */
export const TICKET_NUMBER_FACT = "Number"

/** The fact a ticket record carries what its due date reads as under (O4 of #290), the list's SLA category. */
export const TICKET_SLA_FACT = "SLA"

/** What a due date reads as, in a person's words: an open case before its due date is on track. */
export const SLA_STATE_LABELS: Readonly<Record<SlaState, string>> = { overdue: "Overdue", due: "On track", met: "Met", breached: "Breached", none: "No due date" }

/** What opening a ticket is told, on the row the write left (#283): its number once the API has answered with it, as every other ticket toast names it; its subject only where that row is not known. A missed collection its stop's record answered (M6 of #293) comes back completed, and says so. */
export function ticketOpened(record: Pick<BusinessRecord, "name" | "facts" | "status">): { title: string; description: string } {
  const number = record.facts[TICKET_NUMBER_FACT]
  if (number !== undefined && statusToken(record.status) === "completed") return { title: "Ticket answered", description: `${number} was answered with the stop's record; the reply is on the customer's thread.` }
  return { title: "Ticket opened", description: number === undefined ? `${record.name} is open; its number follows from the API.` : `${number} is open.` }
}

/** The links the module's "Customer · property" column shows, in its order: whom and where a case is about. */
const CONTEXT_LINKS: ReadonlyArray<keyof TicketLinks> = ["customerId", "propertyId", "sharedCollectionPointId"]

/** The submitted value a ticket record carries its assignee's server id under, for the list's "Mine" (`/me`'s account). */
export const ASSIGNEE_ACCOUNT_KEY = "assigneeAccountId"

/** The ticket's commands, by the names the dialog sends: `assign` and the machine's six. */
export const ASSIGN_TICKET = "assign"
export type TicketCommandName = typeof ASSIGN_TICKET | TicketCommand

/** The comment, an action on the ticket answering its history row. */
export const COMMENT_ON_TICKET = "comment"

/** The reply quoting the stop's record, a command: with `complete` it closes the case `answered`. */
export const REPLY_WITH_EVIDENCE = "reply-with-evidence"

/** The sources an office opens a ticket from: every one but the consumer's two and a Service Provider's, which the API writes (`TicketCreate.source`). */
export const OFFICE_TICKET_SOURCES = TICKET_SOURCES.filter((source) => source !== "driver-app" && source !== "dispatch" && source !== "service-provider")

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

/** The links an office's form names, each by a picker: the stop among its route's (M6 of #293), and the parent set by nobody here. */
export const OFFICE_TICKET_LINKS = TICKET_LINKS.filter(([key]) => key !== "parentTicketId")

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
    [TICKET_NUMBER_FACT]: ticket.label,
    Kind: statusLabel(ticket.kind),
    Priority: statusLabel(ticket.priority),
    Assignee: assignee ?? "Unassigned",
    // The wire's source under a fact of its own: the fixtures' "Source" is another vocabulary.
    "Opened via": statusLabel(ticket.source),
    Occurred: shownOn(ticket.occurredAt, project.timezone),
    Due: ticket.dueAt === null ? "None" : shownOn(ticket.dueAt, project.timezone),
    // As the list was read: a ticket that falls due while the list is open reads overdue at the next read.
    [TICKET_SLA_FACT]: SLA_STATE_LABELS[slaStateOf(ticket, context.now ?? new Date())],
    Project: project.name ?? project.webId,
  }
  for (const link of links) facts[link.fact] = link.name
  if (ticket.resolution !== null) facts.Resolution = statusLabel(ticket.resolution)
  if (ticket.recollectionRouteId !== null) facts["Re-collection route"] = nameVia(context, "route", ticket.recollectionRouteId)
  if (ticket.recollectionPickupId !== null) facts["Re-collection stop"] = nameVia(context, "pickup", ticket.recollectionPickupId)
  // The stop the office booked to answer it (O3c of #290): the latest booking.
  if (ticket.bookedRouteId !== null) facts["Booked route"] = nameVia(context, "route", ticket.bookedRouteId)
  if (ticket.bookedPickupId !== null) facts["Booked stop"] = nameVia(context, "pickup", ticket.bookedPickupId)
  if (ticket.closedAt !== null) facts.Closed = shownOn(ticket.closedAt, project.timezone)
  const linked = Object.fromEntries(TICKET_LINKS.map(([key, prefix]) => [key, ticket.links[key] === null ? "" : webIdVia(context, prefix, ticket.links[key] as string)]))
  return {
    id: webIdOf(TICKET_PREFIX, ticket.id),
    name: ticket.subject,
    context: CONTEXT_LINKS.flatMap((key) => links.find((link) => link.key === key)?.name ?? []).join(" · "),
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
      recollectionPickupId: ticket.recollectionPickupId === null ? "" : webIdVia(context, "pickup", ticket.recollectionPickupId),
      bookedRouteId: ticket.bookedRouteId === null ? "" : webIdVia(context, "route", ticket.bookedRouteId),
      bookedPickupId: ticket.bookedPickupId === null ? "" : webIdVia(context, "pickup", ticket.bookedPickupId),
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

/** The server id of the route a loaded stop rides on; undefined where the stop's row, or its route's, is not loaded. */
function routeOfStop(stopServerId: string, context: MappingContext): string | undefined {
  const routeWebId = context.resolve.byServerId(stopServerId)?.submittedValues?.routeId
  return typeof routeWebId === "string" && routeWebId !== "" ? context.resolve.serverIdOf(routeWebId) : undefined
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
  // A stop is named with its route, and one picked before the route was changed is another route's: refused here as the contracts and the API would.
  if (links.pickupId !== undefined) {
    const stopRouteId = routeOfStop(links.pickupId, context)
    if (links.routeId === undefined || (stopRouteId !== undefined && stopRouteId !== links.routeId)) return refusal("pickupId", "Pick a stop on the ticket's route")
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
    // The API answers a missed collection its stop's record answers unless told not to (M6 of #293): only the opt-out goes out.
    ...(record.submittedValues?.answerFromRecord === false ? { answerFromRecord: false } : {}),
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

/** The product a completion names its work charged at (#291 C3), by server id: with a resolution Finance charges for alone, picked from the products module and never typed; nothing for None. */
function chargeOf(input: CommandInput, resolution: TicketResolution, context: MappingContext): { productId?: string } | LocalRefusal {
  const webId = said(input, "productId")
  if (!isBillableResolution(resolution) || webId === undefined || webId === NO_ONE) return {}
  const productId = referencedServerId(webId, "product", context, { owns: productAdapter.owns })
  return productId === undefined ? refusal("productId", "Pick a product the API holds") : { productId }
}

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
    // The product the work is charged at, with a re-collection or a service alone (#291 C3); None leaves the project's charge for the ticket's kind to stand in.
    const charge = chargeOf(input, resolution as TicketResolution, context)
    if (isLocalRefusal(charge)) return charge
    if (resolution !== "recollected") return { resolution, note, ...charge }
    // A re-collection rides on a real Route, picked from the Routes module: never a typed label (#126).
    const routeWebId = said(input, "recollectionRouteId")
    if (routeWebId === undefined) return refusal("recollectionRouteId", "Pick the route the re-collection rides on")
    const recollectionRouteId = referencedServerId(routeWebId, "route", context, { owns: routeAdapter.owns })
    if (recollectionRouteId === undefined) return refusal("recollectionRouteId", "Pick a route the API holds")
    // And, where the office added one for it, the stop of that route the re-collection is (#111); None names the route alone.
    const stopWebId = said(input, "recollectionPickupId")
    if (stopWebId === undefined || stopWebId === NO_ONE) return { resolution, note, recollectionRouteId, ...charge }
    const recollectionPickupId = referencedServerId(stopWebId, "pickup", context, { owns: pickupAdapter.owns })
    if (recollectionPickupId === undefined) return refusal("recollectionPickupId", "Pick a stop the API holds")
    // A stop picked before the route was changed is another route's, where its row is loaded to say so: refused here as the API would (400, Not a pickup of this route).
    const stopRouteId = routeOfStop(recollectionPickupId, context)
    if (stopRouteId !== undefined && stopRouteId !== recollectionRouteId) return refusal("recollectionPickupId", "Pick a stop on the re-collection route")
    return { resolution, note, recollectionRouteId, recollectionPickupId, ...charge }
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
    if (!(TICKET_VISIBILITIES as readonly string[]).includes(visibility)) return refusal("visibility", `A comment is ${TICKET_VISIBILITIES.slice(0, -1).join(", ")} or ${TICKET_VISIBILITIES.at(-1)}`)
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

/**
 * The reply quoting the stop's record (M6 of #293): the office's note after
 * it where one is said, and the case completed `answered` where asked. The
 * API answers the ticket with its history, a ticket still, which replaces
 * the row.
 */
const REPLY: RecordCommand<Ticket> = {
  toBody: (input) => {
    const note = said(input, "note")
    return { ...(note === undefined ? {} : { note }), complete: input.complete === true }
  },
  run: (client, serverId, body) => command<Ticket>(client, `/tickets/${serverId}/reply-with-evidence`, body),
  refused: (record) => `The reply on ${record.name} was not recorded`,
}

/** What the stop a ticket names recorded, and the reply that quotes it: null for a ticket about no stop. */
export async function ticketEvidence(client: Client, serverId: string): Promise<TicketEvidence["stop"]> {
  return (await get<TicketEvidence>(client, `/tickets/${serverId}/evidence`)).stop
}

/** The stop's outcome as the details read it: `Failed · Not presented`, and `· corrected by the office` where the office's correction set it. */
export const evidenceOutcome = (stop: Pick<StopEvidence, "outcome" | "reason" | "corrected">): string =>
  [statusLabel(stop.outcome), stop.reason === null ? undefined : statusLabel(stop.reason), stop.corrected ? "corrected by the office" : undefined].filter(Boolean).join(" · ")

/** One proof of the evidence as a line on the project's clock: when, what and by which door, then the outcome a correction moved the stop to or the reason it gave. */
export function evidenceProofLine(proof: EvidenceProof, timezone: string | undefined): string {
  return [shownOn(proof.occurredAt, timezone), statusLabel(proof.kind), statusLabel(proof.source), proof.outcome === null ? undefined : statusLabel(proof.outcome), proof.reason === null ? undefined : statusLabel(proof.reason)].filter(Boolean).join(" · ")
}

/** Where the device stood for the outcome, latitude first as a person reads a place: `55.67610, 12.56830`. */
export const evidencePlace = (location: StopEvidence["location"]): string => (location === null ? "Not recorded" : `${location.coordinates[1].toFixed(5)}, ${location.coordinates[0].toFixed(5)}`)

export const ticketAdapter: ResourceAdapter<Ticket> = {
  prefix: TICKET_PREFIX,
  owns: isTicketRecord,
  // Open, in progress, pending, on hold, completed and rejected move by the commands alone.
  statuses: undefined,
  list: (client) => listAll<Ticket>(client, "/tickets"),
  // One ticket read back, for a row a command elsewhere changed: a stop booked from it (O3c of #290).
  read: (client, serverId) => ticketDetail(client, serverId),
  toRecord: toTicketRecord,
  toCreateBody: toTicketCreateBody,
  toPatchBody: toTicketPatchBody,
  create: (client, body) => create<Ticket>(client, "/tickets", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Ticket>(client, `/tickets/${serverId}`, body),
  commands: { ...TICKET_COMMANDS_BY_NAME, [REPLY_WITH_EVIDENCE]: REPLY },
  actions: { [COMMENT_ON_TICKET]: COMMENT as RecordAction<unknown> },
}

/** Operate › Tickets: the cases the office and the consumer open, worked through their commands and their history. */
export const ticketsModule: ServerModule = {
  workspaceId: TICKETS_MODULE.workspaceId,
  moduleId: TICKETS_MODULE.moduleId,
  resources: [ticketAdapter],
}
