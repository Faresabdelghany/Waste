// Alerts on the adapter (#182, slice 8 of #81, for #147): the rows of
// `operate.exceptions` as the queue and the details read them; the office's
// manual raise; acknowledge, resolve and the link to a ticket — every body
// held against the contracts' own zod schemas, sent through the store's seam
// over a scripted `fetch`. An alert has no patch: nothing but its commands
// changes it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Alert, AlertAcknowledge, AlertCreate, AlertLinkTicket, AlertResolve, NAMES_A_SUBJECT as CONTRACT_NAMES_A_SUBJECT } from "@waste/contracts/alerts"
import type { Project } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { ACKNOWLEDGE_ALERT, alertAdapter, ALERTS_MODULE, alertsModule, LINK_ALERT_TICKET, NAMES_A_SUBJECT, RESOLVE_ALERT } from "../records/alerts"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { isServerBacked } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { commandRecord, loaded, loadModule, rereadRecord, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { TICKET_NUMBER_FACT } from "../records/tickets"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T10:00:00Z")
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }
const fixturesOf = (workspaceId: "configure" | "operate", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("operate", "exceptions")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, paymentTermsDays: 30, paymentReferenceScheme: "none" }
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: fixturesOf("configure", "organization"), resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const vehicleId = "01a0d2a4-a280-7013-8000-000000000001"
const oliviaId = "01a0d2a4-a280-7004-8000-000000000001"
const ticketId = "01a0d2a4-a280-7040-8000-000000000001"

const row = (id: string, name: string, recordKind: string, facts: Record<string, string> = {}): BusinessRecord => ({ ...projectRecord, id, name, recordKind, facts, submittedValues: {} })
const wh24 = row(`vehicle-${vehicleId}`, "WH-24 · CN 42 018", "Vehicle")
const olivia = row(`user-${oliviaId}`, "Olivia Larsen", "User")
const t1001 = row(`ticket-${ticketId}`, "Stale position on WH-24", "Ticket", { [TICKET_NUMBER_FACT]: "T-1001" })
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: serverIdsOf([projectRecord], [copenhagen.id]) }, 1)],
  ["configure.access", loaded({ records: [olivia], serverIds: serverIdsOf([olivia], [oliviaId]) }, 1)],
  ["fleet.vehicles", loaded({ records: [wh24], serverIds: serverIdsOf([wh24], [vehicleId]) }, 1)],
  ["operate.tickets", loaded({ records: [t1001], serverIds: serverIdsOf([t1001], [ticketId]) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const options = { fixtures, state, now: NOW }

const stale: Alert = {
  id: "01a0d2a4-a280-7041-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  kind: "resource",
  severity: "critical",
  source: "manual",
  status: "new",
  title: "Vehicle position is stale",
  details: "No position from WH-24 for 14 minutes",
  detectedAt: "2026-10-01T07:45:00.000Z",
  routeId: null,
  vehicleId,
  driverId: null,
  containerId: null,
  ticketId: null,
  raisedBy: oliviaId,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  rule: null,
}
const record = alertAdapter.toRecord(stale, context())
const current = loaded({ records: [record], serverIds: new Map([[record.id, stale.id]]) }, 1)

describe("the alerts module", () => {
  test("is switched", () => {
    assert.ok(isServerBacked(ALERTS_MODULE.workspaceId, ALERTS_MODULE.moduleId))
  })

  test("reads every alert, each `alert-<uuid>`", async () => {
    const { fetch, calls } = scripted([() => json({ items: [stale], nextCursor: null })])
    const result = await loadModule(clientOver(fetch), alertsModule, options)
    assert.equal(calls[0].url, "http://api.test/alerts?limit=200")
    assert.deepEqual(result.records.map((alert) => alert.id), [`alert-${stale.id}`])
  })
})

describe("an alert", () => {
  test("the wire fixture is the contracts' shape, and the adapter's sentence is the contracts'", () => {
    assert.ok(Alert.safeParse(stale).success)
    assert.equal(NAMES_A_SUBJECT, CONTRACT_NAMES_A_SUBJECT)
  })

  test("is the record the queue and the details read: its title, what it is about, its severity, the ticket it is linked to", () => {
    assert.equal(record.id, `alert-${stale.id}`)
    assert.equal(record.name, "Vehicle position is stale")
    assert.equal(record.context, "WH-24", "a vehicle by its callsign, as the routes name one")
    assert.equal(record.status, "New")
    assert.equal(record.owner, "Unacknowledged")
    assert.equal(record.value, "Critical")
    assert.equal(record.recordKind, "Alert")
    assert.deepEqual(record.facts, {
      Severity: "Critical",
      Kind: "Resource",
      "Raised by": "Manual",
      Detected: "2026-10-01 09:45",
      Project: "Copenhagen Central",
      Vehicle: "WH-24",
      Ticket: "Not linked",
      Acknowledged: "No",
    })
    assert.equal(record.submittedValues?.vehicleId, wh24.id)
    assert.equal(record.submittedValues?.ticketId, "")
  })

  test("one a worker's rule raised names its rule, and one about a ticket alone is about that ticket; the worker's resolve names nobody (O4 of #290)", () => {
    const overdue = alertAdapter.toRecord(
      { ...stale, source: "rule", rule: "ticket-overdue", kind: "service-risk", title: "T-1001 is overdue", vehicleId: null, ticketId, raisedBy: null, status: "resolved", resolvedAt: "2026-10-01T08:00:00.000Z", resolutionNote: "Cleared: the ticket was closed, or given a later due date." },
      context(),
    )
    assert.equal(overdue.facts["Raised by"], "Rule")
    assert.equal(overdue.facts.Rule, "Ticket overdue")
    assert.equal(overdue.context, "T-1001", "about the ticket alone")
    assert.equal(overdue.facts.Resolved, "2026-10-01 10:00", "the worker resolved it: a time and no one")
    assert.equal(record.facts.Rule, undefined, "a person's alert names no rule")
  })

  test("once acknowledged, resolved and linked, says by whom and when, and names its ticket by label", () => {
    const done = alertAdapter.toRecord({ ...stale, status: "resolved", ticketId, acknowledgedAt: "2026-10-01T08:00:00.000Z", acknowledgedBy: oliviaId, resolvedAt: "2026-10-01T09:00:00.000Z", resolvedBy: oliviaId, resolutionNote: "Modem restarted" }, context())
    assert.equal(done.status, "Resolved")
    assert.equal(done.owner, "Olivia Larsen")
    assert.equal(done.facts.Ticket, "T-1001")
    assert.equal(done.facts.Acknowledged, "2026-10-01 10:00 · Olivia Larsen")
    assert.equal(done.facts.Resolved, "2026-10-01 11:00 · Olivia Larsen")
    assert.equal(done.facts["Resolution note"], "Modem restarted")
    assert.equal(done.submittedValues?.ticketId, t1001.id)
    const unloaded = alertAdapter.toRecord({ ...stale, ticketId }, context(NOTHING_RESOLVED))
    assert.equal(unloaded.facts.Ticket, `ticket-${ticketId}`, "an id chip until the tickets load")
  })

  test("is never edited: nothing but its commands changes it", async () => {
    const { fetch, calls } = scripted([])
    const edited = await writeRecord(clientOver(fetch), alertsModule, current, { ...record, submittedValues: { ...record.submittedValues, title: "Another" } }, options)
    assert.equal(edited.kind, "refused")
    const moved = await writeRecord(clientOver(fetch), alertsModule, current, { ...record, status: "Resolved" }, options)
    assert.equal(moved.kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("the office's raise", () => {
  const minted = (values: Record<string, string>): BusinessRecord => ({ ...record, id: "operate-alert-1700000000000", name: values.title ?? "", recordKind: "Alert", projectIds: [projectRecord.id], submittedValues: { projectId: projectRecord.id, ...values } })
  const typedValues = { title: "Vehicle position is stale", details: "No position for 14 minutes", kind: "resource", severity: "high", detectedAt: "2026-10-01T09:45", vehicleId: wh24.id }

  test("is the contracts' AlertCreate, what it is about by server id, when it was seen on the project's clock", () => {
    const body = alertAdapter.toCreateBody?.(minted(typedValues), context())
    assert.deepEqual(body, { projectId: copenhagen.id, title: "Vehicle position is stale", details: "No position for 14 minutes", kind: "resource", severity: "high", detectedAt: "2026-10-01T07:45:00.000Z", vehicleId })
    assert.ok(AlertCreate.safeParse(body).success)
  })

  test("names what it is about, or is refused here in the contracts' words", () => {
    const create = alertAdapter.toCreateBody
    assert.deepEqual(create?.(minted({ ...typedValues, vehicleId: "" }), context()), { path: "routeId", message: NAMES_A_SUBJECT })
    assert.deepEqual(create?.(minted({ ...typedValues, vehicleId: "none", driverId: "none" }), context()), { path: "routeId", message: NAMES_A_SUBJECT }, "a picker's None names nothing")
    assert.deepEqual(create?.(minted({ ...typedValues, vehicleId: "vehicle-wh-24" }), context()), { path: "vehicleId", message: "Pick a vehicle the API holds" })
    assert.deepEqual(create?.(minted({ ...typedValues, severity: "" }), context()), { path: "severity", message: "Pick the alert's severity" })
    assert.deepEqual(create?.(minted({ ...typedValues, kind: "telemetry" }), context()), { path: "kind", message: "Pick a kind the API knows: route-exception, resource, service-risk, asset, weight, other" })
  })
})

describe("the alert's commands", () => {
  const body = (name: string, input: Record<string, unknown>) => alertAdapter.commands?.[name]?.toBody?.(input, record, context())

  test("acknowledge says nothing, as an empty object; resolve may carry a note; link-ticket names the ticket by server id", () => {
    assert.deepEqual(body(ACKNOWLEDGE_ALERT, {}), {})
    assert.ok(AlertAcknowledge.safeParse(body(ACKNOWLEDGE_ALERT, {})).success)
    assert.deepEqual(body(RESOLVE_ALERT, { note: "Modem restarted" }), { note: "Modem restarted" })
    assert.ok(AlertResolve.safeParse(body(RESOLVE_ALERT, { note: "Modem restarted" })).success)
    assert.deepEqual(body(RESOLVE_ALERT, {}), {})
    assert.deepEqual(body(LINK_ALERT_TICKET, { ticketId: t1001.id }), { ticketId })
    assert.ok(AlertLinkTicket.safeParse(body(LINK_ALERT_TICKET, { ticketId: t1001.id })).success)
    assert.deepEqual(body(LINK_ALERT_TICKET, {}), { path: "ticketId", message: "Pick the ticket the alert belongs to" })
    assert.deepEqual(body(LINK_ALERT_TICKET, { ticketId: "ticket-8831" }), { path: "ticketId", message: "Pick a ticket the API holds" })
  })

  test("post to their paths, and the alert the API answers replaces the row", async () => {
    const { fetch, calls } = scripted([() => json({ ...stale, status: "acknowledged", acknowledgedAt: "2026-10-01T08:00:00.000Z", acknowledgedBy: oliviaId })])
    const outcome = await commandRecord(clientOver(fetch), alertsModule, current, record, ACKNOWLEDGE_ALERT, undefined, options)
    assert.equal(calls[0].url, `http://api.test/alerts/${stale.id}/acknowledge`)
    assert.deepEqual(bodyOf(calls[0]), {})
    assert.equal(outcome.kind, "done")
    if (outcome.kind === "done") assert.equal(outcome.record.status, "Acknowledged")
  })

  test("a resolved alert's refusal is the API's sentence", async () => {
    const { fetch } = scripted([() => problem(409, "This alert is resolved and does not change")])
    const outcome = await commandRecord(clientOver(fetch), alertsModule, current, record, LINK_ALERT_TICKET, { ticketId: t1001.id }, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "Vehicle position is stale was not linked to the ticket")
    assert.equal(problemSentence(outcome.problem), "This alert is resolved and does not change")
  })

  test("is read back on its own once a ticket opened from it has linked it", async () => {
    const { fetch, calls } = scripted([() => json({ ...stale, ticketId })])
    const outcome = await rereadRecord(clientOver(fetch), alertsModule, current, record, options)
    assert.equal(calls[0].url, `http://api.test/alerts/${stale.id}`)
    assert.equal(outcome.kind, "done")
    if (outcome.kind === "done") assert.equal(outcome.record.facts.Ticket, "T-1001")
  })
})
