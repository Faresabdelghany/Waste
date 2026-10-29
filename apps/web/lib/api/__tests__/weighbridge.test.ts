// Route Studio › Weighbridge on the API (O27 of #290): a ticket as a record —
// its status and the reason it waits in the office's words, the route and
// unload once matched — the commands its details offer, and Match's and
// Dismiss's bodies, web ids to server ids through the resolver.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WeighbridgeTicketDismiss, WeighbridgeTicketMatch, type WeighbridgeTicket } from "@waste/contracts/weighbridge"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { UNMATCHED_LABELS, WEIGHBRIDGE_MODULE } from "../../data/weighbridge"
import { isLocalRefusal, NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { isServerBacked } from "../records/modules"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"
import { DISMISS_TICKET, MATCH_TICKET, ticketCommandsOffered, weighbridgeTicketAdapter } from "../records/weighbridge"
import { clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-05T13:00:00Z")
const STATION = "01a0d2a4-a280-7020-8000-000000000002"
const ROUTE = "01a0d2a4-a280-7030-8000-000000000001"
const RESIDUAL = "01a0d2a4-a280-7005-8000-000000000001"
const UNLOAD = "01a0d2a4-a280-7096-8000-000000000001"

const ticket: WeighbridgeTicket = {
  id: "01a0d2a4-a280-7099-8000-000000000001",
  createdAt: "2026-10-05T10:41:00.000Z",
  updatedAt: "2026-10-05T10:41:00.000Z",
  projectId: null,
  unloadingStationId: STATION,
  ticketNumber: "WB-2026-3901",
  vehicleRegistration: "ZZ 99 999",
  vehicleId: null,
  weighedAt: "2026-10-05T10:40:00.000Z",
  grossKg: 18_540,
  tareKg: 10_000,
  netKg: 8540,
  fractionKey: "residual",
  wasteCode: null,
  status: "unmatched",
  unmatchedReason: "unknown-vehicle",
  routeId: null,
  unloadId: null,
  dismissedNote: null,
  receivedBy: "01a0d2a4-a280-7003-8000-000000000003",
}

const plain = (id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord =>
  ({ id, name, context: "", status: "Active", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", recordKind: "", submittedValues: {}, ...extra }) as BusinessRecord
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const state: ServerRecordsState = new Map([
  ["route-studio.routes", moduleOf([plain(`route-${ROUTE}`, "RC-1042 · 2026-10-05")], [ROUTE])],
  ["resources.depots", moduleOf([plain(`station-${STATION}`, "ARC Amager")], [STATION])],
  ["configure.master", moduleOf([plain(`fraction-${RESIDUAL}`, "Residual", { submittedValues: { kind: "waste-fraction" } })], [RESIDUAL])],
])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

describe("Route Studio › Weighbridge", () => {
  test("is a module on the API", () => {
    assert.equal(isServerBacked(WEIGHBRIDGE_MODULE.workspaceId, WEIGHBRIDGE_MODULE.moduleId), true)
  })

  test("an unmatched ticket says what it waits for, offers Match and Dismiss, and has no project where its plate is nobody's", () => {
    const record = weighbridgeTicketAdapter.toRecord(ticket, context)
    assert.equal(record.id, `weighbridge-ticket-${ticket.id}`)
    assert.equal(record.name, "WB-2026-3901 · ZZ 99 999")
    assert.equal(record.status, "Unmatched")
    assert.equal(record.facts["Waited for"], UNMATCHED_LABELS["unknown-vehicle"])
    assert.equal(record.facts.Station, "ARC Amager")
    assert.equal(record.facts.Net, "8,540 kg")
    assert.deepEqual(record.projectIds, [])
    assert.deepEqual(ticketCommandsOffered(record), [MATCH_TICKET, DISMISS_TICKET])
  })

  test("a matched ticket names its route and unload and offers nothing", () => {
    const record = weighbridgeTicketAdapter.toRecord({ ...ticket, status: "matched", routeId: ROUTE, unloadId: UNLOAD, projectId: null }, context)
    assert.equal(record.status, "Matched")
    assert.equal(record.facts.Route, "RC-1042 · 2026-10-05")
    assert.equal(record.facts.Unload, `unload-${UNLOAD}`)
    assert.deepEqual(ticketCommandsOffered(record), [])
  })

  test("Match sends the route and the fraction by their server ids, refusing either the API does not hold; Dismiss sends why", () => {
    const record = weighbridgeTicketAdapter.toRecord(ticket, context)
    const match = weighbridgeTicketAdapter.commands?.[MATCH_TICKET]
    const body = match?.toBody?.({ routeId: `route-${ROUTE}`, wasteFractionId: `fraction-${RESIDUAL}` }, record, context)
    assert.deepEqual(body, { routeId: ROUTE, wasteFractionId: RESIDUAL })
    assert.ok(WeighbridgeTicketMatch.safeParse(body).success)
    const refused = match?.toBody?.({ routeId: "route-fixture", wasteFractionId: `fraction-${RESIDUAL}` }, record, { ...context, resolve: NOTHING_RESOLVED })
    assert.ok(isLocalRefusal(refused) && refused.path === "routeId")
    const dismiss = weighbridgeTicketAdapter.commands?.[DISMISS_TICKET]
    assert.deepEqual(dismiss?.toBody?.({ note: "A visitor's trailer" }, record, context), { note: "A visitor's trailer" })
    assert.ok(WeighbridgeTicketDismiss.safeParse({ note: "A visitor's trailer" }).success)
    const silent = dismiss?.toBody?.({}, record, context)
    assert.ok(isLocalRefusal(silent) && silent.path === "note")
  })

  test("is never patched, and Match posts to the ticket's own path", async () => {
    const record = weighbridgeTicketAdapter.toRecord(ticket, context)
    assert.ok(isLocalRefusal(weighbridgeTicketAdapter.toPatchBody(record, { ...record, name: "x" }, context)))
    const { fetch, calls } = scripted([() => json({ ...ticket, status: "matched", routeId: ROUTE, unloadId: UNLOAD, projectId: null })])
    const answered = await weighbridgeTicketAdapter.commands?.[MATCH_TICKET].run(clientOver(fetch), ticket.id, { routeId: ROUTE, wasteFractionId: RESIDUAL })
    assert.equal(calls[0].url, `http://api.test/weighbridge-tickets/${ticket.id}/match`)
    assert.equal(answered?.status, "matched")
  })
})
