// Alerts on the prototype's records (Issue #182, slice 8 of #81, for #147):
// the rows of `operate.exceptions`, Operate's queue of attention conditions —
// the list, the office's manual raise and the three commands. The wire
// shapes are the contracts' (`@waste/contracts/alerts`), imported as types;
// the routes are apps/api/src/routes/alerts.ts.
//
// An alert is raised, acknowledged, resolved and linked to one ticket, and
// nothing else changes it: there is no patch, so the adapter lists no
// `statuses` and refuses every edit, and its status moves by `acknowledge`
// and `resolve` alone. "Linked to ticket" is no status but a reading of the
// alert's ticket, which the row shows beside its status. An alert is
// `alert-<uuid>` from the start; the fixtures' ALERT-2201 is a fixture's.
//
// An alert names what it is about — a route, a vehicle, a driver, a
// container, at least one (`namesASubject`) — by web id through the store's
// resolver, by name once their modules are loaded and as an id chip until
// then, and the ticket it is linked to by the ticket's label. The tickets
// load first, so a linked ticket is named by its label from the start.
import type { Alert } from "@waste/contracts/alerts"
import { ALERT_KINDS, ALERT_SEVERITIES } from "@waste/domain/resolution/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { NO_ONE } from "@/lib/data/properties"

import { command, create, get, listAll } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, said, stampFacts, statusLabel, statusToken, typed, webIdOf, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { instantOn, shownOn, wallClockIn } from "./clock"
import { containerAdapter } from "./containers"
import { driverAdapter, vehicleAdapter } from "./fleet"
import { projectServerIdOf, referenced, refusal } from "./places"
import { nameVia, referencedServerId, webIdVia } from "./references"
import { callsignOf, routeAdapter } from "./routes"
import { isTicketRecord, TICKET_PREFIX } from "./tickets"

/** The workspace module the alerts are the rows of: Operate's Exceptions & Alerts. */
export const ALERTS_MODULE: ModuleLocation = { workspaceId: "operate", moduleId: "exceptions" }

export const ALERT_PREFIX = "alert"

/** The alert's commands, by the names its surface sends. */
export const ACKNOWLEDGE_ALERT = "acknowledge"
export const RESOLVE_ALERT = "resolve"
export const LINK_ALERT_TICKET = "link-ticket"

/** What an alert is about, subject by subject: the body's key, the id chip's prefix, the fact it is shown under, and the rule a loaded row is held to — its module adapter's own. */
export const ALERT_SUBJECTS: ReadonlyArray<readonly ["routeId" | "vehicleId" | "driverId" | "containerId", string, string, (record: BusinessRecord) => boolean]> = [
  ["routeId", "route", "Route", routeAdapter.owns],
  ["vehicleId", "vehicle", "Vehicle", vehicleAdapter.owns],
  ["driverId", "driver", "Driver", driverAdapter.owns],
  ["containerId", "asset", "Container", containerAdapter.owns],
]

/** What an alert about nothing is told (`@waste/contracts/alerts`, `NAMES_A_SUBJECT`); the test holds the two equal. */
export const NAMES_A_SUBJECT = "An alert names what it is about: a route, a vehicle, a driver or a container"

const CHANGED_BY_COMMANDS = "An alert is raised, acknowledged, resolved and linked to a ticket; nothing else changes it"

/** "2026-10-01 06:31 · Olivia Larsen": when and by whom, an account by name once Users & roles is loaded. */
const stamp = (at: string | null, by: string | null, context: MappingContext, timezone: string | undefined) =>
  at === null ? undefined : [shownOn(at, timezone), by === null ? undefined : nameVia(context, "user", by)].filter(Boolean).join(" · ")

export function toAlertRecord(alert: Alert, context: MappingContext): BusinessRecord {
  const projectRecord = context.resolve.byServerId(alert.projectId)
  const project = referenced(context, "project", alert.projectId)
  const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
  // A vehicle by its callsign, as the routes and the map name one.
  const nameOf = (prefix: string, serverId: string) => (prefix === "vehicle" ? callsignOf(nameVia(context, prefix, serverId)) : nameVia(context, prefix, serverId))
  const subjects = ALERT_SUBJECTS.flatMap(([key, prefix, fact]) => (alert[key] === null ? [] : [{ key, fact, webId: webIdVia(context, prefix, alert[key] as string), name: nameOf(prefix, alert[key] as string) }]))
  const ticket = alert.ticketId === null ? undefined : referenced(context, TICKET_PREFIX, alert.ticketId)
  const ticketName = ticket === undefined ? undefined : (context.resolve.byServerId(alert.ticketId as string)?.facts.Ticket ?? ticket.name ?? ticket.webId)
  const acknowledged = stamp(alert.acknowledgedAt, alert.acknowledgedBy, context, timezone)
  const resolved = stamp(alert.resolvedAt, alert.resolvedBy, context, timezone)
  const facts: Record<string, string> = {
    Severity: statusLabel(alert.severity),
    Kind: statusLabel(alert.kind),
    "Raised by": statusLabel(alert.source),
    Detected: shownOn(alert.detectedAt, timezone),
    Project: project.name ?? project.webId,
  }
  for (const subject of subjects) facts[subject.fact] = subject.name
  facts.Ticket = ticketName ?? "Not linked"
  facts.Acknowledged = acknowledged ?? "No"
  if (resolved !== undefined) facts.Resolved = resolved
  if (alert.resolutionNote !== null) facts["Resolution note"] = alert.resolutionNote
  return {
    id: webIdOf(ALERT_PREFIX, alert.id),
    name: alert.title,
    context: subjects.map((subject) => subject.name).join(" · "),
    status: statusLabel(alert.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(alert, context.now),
    owner: alert.acknowledgedBy === null ? "Unacknowledged" : nameVia(context, "user", alert.acknowledgedBy),
    value: statusLabel(alert.severity),
    description: alert.details,
    related: [...subjects.map((subject) => `${subject.fact} ${subject.name}`), ...(ticketName === undefined ? [] : [`Ticket ${ticketName}`])],
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    recordKind: "Alert",
    submittedValues: {
      projectId: project.webId,
      title: alert.title,
      details: alert.details,
      kind: alert.kind,
      severity: alert.severity,
      status: alert.status,
      detectedAt: wallClockIn(alert.detectedAt, timezone),
      ...Object.fromEntries(ALERT_SUBJECTS.map(([key, prefix]) => [key, alert[key] === null ? "" : webIdVia(context, prefix, alert[key] as string)])),
      ticketId: ticket?.webId ?? "",
    },
  }
}

/** The project's clock, from the organisation the store loaded. */
function timezoneOf(record: BusinessRecord, context: MappingContext): string | undefined {
  const webId = typed(record, "projectId") ?? record.projectIds?.[0]
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  const project = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  return project === undefined ? undefined : typed(project, "timezone")
}

/** A closed-list token a form typed under `key`, or a refusal naming the list. */
function required(record: BusinessRecord, key: string, tokens: readonly string[], noun: string): string | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return refusal(key, `Pick the alert's ${noun}`)
  const token = statusToken(text)
  return tokens.includes(token) ? token : refusal(key, `Pick a ${noun} the API knows: ${tokens.join(", ")}`)
}

/** The ticket a web id names, as a server id: a ticket the tickets module holds, or its id chip. */
const ticketServerIdOf = (webId: string, context: MappingContext) => referencedServerId(webId, TICKET_PREFIX, context, { owns: isTicketRecord })

/**
 * `POST /alerts` from the office's form: the project, the title and the
 * details, the kind and the severity, when it was seen on the project's
 * clock, and what it is about — at least one of the four, by server id.
 */
export function toAlertCreateBody(record: BusinessRecord, context: MappingContext): unknown | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const title = typed(record, "title") ?? (record.name.trim() === "" ? undefined : record.name.trim())
  if (title === undefined) return refusal("title", "An alert needs a title")
  const details = typed(record, "details")
  if (details === undefined) return refusal("details", "Say what was seen")
  const kind = required(record, "kind", ALERT_KINDS, "kind")
  if (isLocalRefusal(kind)) return kind
  const severity = required(record, "severity", ALERT_SEVERITIES, "severity")
  if (isLocalRefusal(severity)) return severity
  const seen = typed(record, "detectedAt")
  const detectedAt = seen === undefined ? undefined : instantOn(seen, timezoneOf(record, context))
  if (seen !== undefined && detectedAt === undefined) return refusal("detectedAt", "Give the time as a date and a time")
  const subjects: Record<string, string> = {}
  for (const [key, prefix, fact, owns] of ALERT_SUBJECTS) {
    const webId = typed(record, key)
    // Blank, or the picker's None: the alert is not about this one.
    if (webId === undefined || webId === NO_ONE) continue
    const serverId = referencedServerId(webId, prefix, context, { owns })
    if (serverId === undefined) return refusal(key, `Pick a ${fact.toLowerCase()} the API holds`)
    subjects[key] = serverId
  }
  if (Object.keys(subjects).length === 0) return refusal("routeId", NAMES_A_SUBJECT)
  return { projectId, title, details, kind, severity, ...(detectedAt === undefined ? {} : { detectedAt }), ...subjects }
}

const onAlert = (verb: string, past: string, toBody: NonNullable<RecordCommand<Alert>["toBody"]>, touches?: readonly string[]): RecordCommand<Alert> => ({
  toBody,
  run: (client, serverId, body) => command<Alert>(client, `/alerts/${serverId}/${verb}`, body),
  refused: (record) => `${record.name} was not ${past}`,
  ...(touches === undefined ? {} : { touches }),
})

export const ALERT_COMMANDS = {
  // The body is empty, and an empty object rather than none: the API reads it as JSON.
  [ACKNOWLEDGE_ALERT]: onAlert("acknowledge", "acknowledged", () => ({})),
  [RESOLVE_ALERT]: onAlert("resolve", "resolved", (input) => {
    const note = said(input, "note")
    return note === undefined ? {} : { note }
  }),
  [LINK_ALERT_TICKET]: onAlert("link-ticket", "linked to the ticket", (input, _record, context) => {
    const webId = said(input, "ticketId")
    if (webId === undefined) return refusal("ticketId", "Pick the ticket the alert belongs to")
    const ticketId = ticketServerIdOf(webId, context)
    return ticketId === undefined ? refusal("ticketId", "Pick a ticket the API holds") : { ticketId }
  }),
} satisfies Record<string, RecordCommand<Alert>>

export const alertAdapter: ResourceAdapter<Alert> = {
  prefix: ALERT_PREFIX,
  owns: ofKind(ALERT_PREFIX, ["Alert"]),
  // New, acknowledged and resolved move by the commands alone.
  statuses: undefined,
  list: (client) => listAll<Alert>(client, "/alerts"),
  toRecord: toAlertRecord,
  toCreateBody: toAlertCreateBody,
  toPatchBody: () => refusal("", CHANGED_BY_COMMANDS),
  create: (client, body) => create<Alert>(client, "/alerts", body).then((created) => created.body),
  update: () => Promise.reject(new Error(CHANGED_BY_COMMANDS)),
  // A ticket opened from the alert links it on the server's account: the alert is read back.
  read: (client, serverId) => get<Alert>(client, `/alerts/${serverId}`),
  commands: ALERT_COMMANDS,
}

/** Operate › Exceptions & Alerts: the conditions the office raises by hand, acknowledges, resolves and hands to a ticket. */
export const alertsModule: ServerModule = {
  workspaceId: ALERTS_MODULE.workspaceId,
  moduleId: ALERTS_MODULE.moduleId,
  resources: [alertAdapter],
}
