// Operate › Scale house on the API (M16a of #293): a ticket and a tare as
// records, the commands each one's details offer, and the bodies of Weigh
// in, Weigh out, Void and Register tare, with web ids mapped to server ids
// through the resolver and each refusal named before the API sees it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ScaleTicketComplete, ScaleTicketCreate, ScaleTicketVoid, VehicleTareCreate, type ScaleTicket, type VehicleTare } from "@waste/contracts/scale-house"

import { type BusinessRecord } from "../../data/business-modules"
import { SCALE_HOUSE_MODULE, SCALE_TICKET_RECORD_KIND } from "../../data/scale-house"
import { isLocalRefusal, type MappingContext } from "../records/adapter"
import { isServerBacked } from "../records/modules"
import {
  COMPLETE_TICKET,
  REACTIVATE_TARE,
  RETIRE_TARE,
  REWEIGH_TARE,
  SCALE_TICKET_COMMANDS,
  scaleTicketAdapter,
  tareCommandsOffered,
  ticketCommandsOffered,
  toCompleteBody,
  toScaleTicketCreateBody,
  toVehicleTareCreateBody,
  VOID_TICKET,
  vehicleTareAdapter,
} from "../records/scale-house"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"

const NOW = new Date("2026-10-29T10:00:00Z")
const PROJECT = "01a0d2a4-a280-7001-8000-000000000010"
const SITE = "01a0d2a4-a280-7020-8000-000000000009"
const CUSTOMER = "01a0d2a4-a280-7004-8000-000000000001"
const AGREEMENT = "01a0d2a4-a280-7006-8000-000000000001"
const RESIDUAL = "01a0d2a4-a280-7005-8000-000000000001"
const GARDEN = "01a0d2a4-a280-7005-8000-000000000002"
const UNLOAD = "01a0d2a4-a280-7096-8000-000000000001"
const WINDOW_PRODUCT = "01a0d2a4-a280-7007-8000-000000000009"

const plain = (id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord =>
  ({ id, name, context: "", status: "Active", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", recordKind: "", submittedValues: {}, ...extra }) as BusinessRecord
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([plain(`project-${PROJECT}`, "Copenhagen Central", { submittedValues: { timezone: "Europe/Copenhagen" } })], [PROJECT])],
  ["resources.depots", moduleOf([plain(`station-${SITE}`, "Nordhavn genbrugsplads")], [SITE])],
  ["customers.contacts", moduleOf([plain(`company-${CUSTOMER}`, "Anna Byg ApS")], [CUSTOMER])],
  ["customers.agreements", moduleOf([plain(`agreement-${AGREEMENT}`, "AGR-2408")], [AGREEMENT])],
  ["commercial.products", moduleOf([plain(`product-${WINDOW_PRODUCT}`, "Bulky at the window", { submittedValues: { priceUnit: "m3" } })], [WINDOW_PRODUCT])],
  [
    "configure.master",
    moduleOf(
      [plain(`fraction-${RESIDUAL}`, "Residual", { submittedValues: { kind: "waste-fraction" } }), plain(`fraction-${GARDEN}`, "Garden waste", { submittedValues: { kind: "waste-fraction" } })],
      [RESIDUAL, GARDEN],
    ),
  ],
])
const context: MappingContext = { resolve: resolverOver(state), now: NOW }

const ticket: ScaleTicket = {
  id: "01a0d2a4-a280-7099-8000-000000000101",
  createdAt: "2026-10-29T08:20:00.000Z",
  updatedAt: "2026-10-29T08:40:00.000Z",
  projectId: PROJECT,
  number: 1004,
  unloadingStationId: SITE,
  vehiclePlate: "AB 12 345",
  trailerPlate: null,
  containerRef: null,
  vehicleId: null,
  party: "account",
  customerId: CUSTOMER,
  agreementId: AGREEMENT,
  visitorName: null,
  grossKg: 3_400,
  weighedInAt: "2026-10-29T08:20:00.000Z",
  tareKg: 2_500,
  tareSource: "weighed",
  vehicleTareId: null,
  weighedOutAt: "2026-10-29T08:40:00.000Z",
  netKg: 900,
  status: "completed",
  lines: [
    { id: "01a0d2a4-a280-7099-8000-000000000201", position: 1, wasteFractionId: RESIDUAL, originMunicipality: "0101", netKg: 500, productId: null, volumeLitres: null },
    { id: "01a0d2a4-a280-7099-8000-000000000202", position: 2, wasteFractionId: GARDEN, originMunicipality: null, netKg: 400, productId: null, volumeLitres: null },
  ],
  routeId: null,
  unloadId: null,
  unmatchedReason: null,
  voidReason: null,
  voidNote: null,
  voidedAt: null,
  note: null,
  recordedBy: "01a0d2a4-a280-7003-8000-000000000003",
}

const tare: VehicleTare = {
  id: "01a0d2a4-a280-7099-8000-000000000301",
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  projectId: PROJECT,
  plate: "AB12345",
  trailerPlate: null,
  containerRef: "SK7",
  tareKg: 7_100,
  weighedOn: "2026-10-01",
  customerId: CUSTOMER,
  label: "Skip lorry",
  status: "active",
}

const draft = (values: Record<string, string>): BusinessRecord => plain("scale-house-scale-ticket-1", values.vehiclePlate ?? "", { recordKind: SCALE_TICKET_RECORD_KIND, submittedValues: values })

describe("Operate › Scale house", () => {
  test("is a module on the API, its tickets and its tares each owned by their kind", () => {
    assert.equal(isServerBacked(SCALE_HOUSE_MODULE.workspaceId, SCALE_HOUSE_MODULE.moduleId), true)
    const minted = draft({ vehiclePlate: "XY 1" })
    assert.equal(scaleTicketAdapter.owns(minted), true)
    assert.equal(vehicleTareAdapter.owns(minted), false)
  })

  test("reads a ticket with its number, its party, its weighings and its lines in the window's words", () => {
    const record = scaleTicketAdapter.toRecord(ticket, context)
    assert.equal(record.id, `scale-ticket-${ticket.id}`)
    assert.equal(record.name, "ST-1004 · AB 12 345")
    assert.equal(record.status, "Completed")
    assert.equal(record.value, "900 kg")
    assert.equal(record.facts.Customer, "Anna Byg ApS")
    assert.equal(record.facts["Line 1"], "Residual · 0101 · 500 kg")
    assert.equal(record.facts["Line 2"], "Garden waste · 400 kg")
    assert.equal(record.facts.Tare, "2,500 kg · second pass")
    assert.deepEqual(record.projectIds, [`project-${PROJECT}`])
  })

  test("offers Weigh out and Void while open, Void once completed, nothing once voided or written as a route's unload", () => {
    assert.deepEqual(ticketCommandsOffered({ submittedValues: { status: "open" } }), [COMPLETE_TICKET, VOID_TICKET])
    assert.deepEqual(ticketCommandsOffered(scaleTicketAdapter.toRecord(ticket, context)), [VOID_TICKET])
    assert.deepEqual(ticketCommandsOffered(scaleTicketAdapter.toRecord({ ...ticket, routeId: UNLOAD, unloadId: UNLOAD }, context)), [])
    assert.deepEqual(ticketCommandsOffered({ submittedValues: { status: "voided" } }), [])
    assert.deepEqual(tareCommandsOffered(vehicleTareAdapter.toRecord(tare, context)), [REWEIGH_TARE, RETIRE_TARE])
    assert.deepEqual(tareCommandsOffered(vehicleTareAdapter.toRecord({ ...tare, status: "retired" }, context)), [REACTIVATE_TARE])
  })

  test("weighs a walk-in in, and an account under its customer and agreement, by the server's ids", () => {
    const walkIn = toScaleTicketCreateBody(draft({ projectId: `project-${PROJECT}`, unloadingStationId: `station-${SITE}`, vehiclePlate: "XY 55 001", party: "cash", visitorName: "Lars", grossKg: "3400" }), context)
    assert.deepEqual(ScaleTicketCreate.parse(walkIn), { projectId: PROJECT, unloadingStationId: SITE, vehiclePlate: "XY 55 001", trailerPlate: null, containerRef: null, grossKg: 3_400, note: null, party: "cash", visitorName: "Lars" })
    const account = toScaleTicketCreateBody(
      draft({ projectId: `project-${PROJECT}`, unloadingStationId: `station-${SITE}`, vehiclePlate: "AB 12 345", party: "account", customerId: `company-${CUSTOMER}`, agreementId: `agreement-${AGREEMENT}`, grossKg: "18000" }),
      context,
    )
    assert.equal(ScaleTicketCreate.parse(account).agreementId, AGREEMENT)
  })

  test("refuses a weigh-in without its gross, its site, or an account's agreement, at the field", () => {
    const base = { projectId: `project-${PROJECT}`, unloadingStationId: `station-${SITE}`, vehiclePlate: "XY 1", party: "cash", grossKg: "1000" }
    const at = (values: Record<string, string>) => {
      const body = toScaleTicketCreateBody(draft(values), context)
      return isLocalRefusal(body) ? body.path : undefined
    }
    assert.equal(at({ ...base, grossKg: "12.5" }), "grossKg")
    assert.equal(at({ ...base, unloadingStationId: "" }), "unloadingStationId")
    assert.equal(at({ ...base, party: "account", customerId: `company-${CUSTOMER}` }), "agreementId")
  })

  test("weighs out at a second pass or the registered tare, each line the form filled, and refuses a bad origin or a missing line", () => {
    const body = toCompleteBody({ tareSource: "weighed", tareKg: "2500", fraction1: `fraction-${RESIDUAL}`, origin1: "0101", net1: "500", fraction2: `fraction-${GARDEN}`, net2: "400", fraction3: "", net3: "" }, context)
    assert.deepEqual(ScaleTicketComplete.parse(body), {
      tare: { source: "weighed", tareKg: 2_500 },
      lines: [
        { wasteFractionId: RESIDUAL, netKg: 500, originMunicipality: "0101" },
        { wasteFractionId: GARDEN, netKg: 400 },
      ],
    })
    assert.deepEqual(ScaleTicketComplete.parse(toCompleteBody({ tareSource: "registered", fraction1: `fraction-${RESIDUAL}`, net1: "900" }, context)).tare, { source: "registered" })
    const pathOf = (input: Record<string, string>) => {
      const refused = toCompleteBody(input, context)
      return isLocalRefusal(refused) ? refused.path : undefined
    }
    assert.equal(pathOf({ tareSource: "weighed", fraction1: `fraction-${RESIDUAL}`, net1: "900" }), "tareKg")
    assert.equal(pathOf({ tareSource: "registered", fraction1: `fraction-${RESIDUAL}`, origin1: "101", net1: "900" }), "origin1")
    assert.equal(pathOf({ tareSource: "registered" }), "fraction1")
  })

  test("names a line's product by the server's id and turns a volume in cubic metres into litres (M16b of #293)", () => {
    const body = toCompleteBody({ tareSource: "weighed", tareKg: "2500", fraction1: `fraction-${RESIDUAL}`, net1: "900", product1: `product-${WINDOW_PRODUCT}`, volume1: "1.5" }, context)
    assert.deepEqual(ScaleTicketComplete.parse(body).lines, [{ wasteFractionId: RESIDUAL, netKg: 900, productId: WINDOW_PRODUCT, volumeLitres: 1_500 }])
    const pathOf = (input: Record<string, string>) => {
      const refused = toCompleteBody(input, context)
      return isLocalRefusal(refused) ? refused.path : undefined
    }
    assert.equal(pathOf({ tareSource: "weighed", tareKg: "2500", fraction1: `fraction-${RESIDUAL}`, net1: "900", volume1: "0" }), "volume1")
    assert.equal(pathOf({ tareSource: "weighed", tareKg: "2500", fraction1: `fraction-${RESIDUAL}`, net1: "900", product1: "product-unknown" }), "product1")
  })

  test("voids with a reason, and another reason with its note", () => {
    const toBody = SCALE_TICKET_COMMANDS[VOID_TICKET]!.toBody!
    const record = scaleTicketAdapter.toRecord(ticket, context)
    assert.deepEqual(ScaleTicketVoid.parse(toBody({ reason: "duplicate" }, record, context)), { reason: "duplicate" })
    const refused = toBody({ reason: "other" }, record, context)
    assert.equal(isLocalRefusal(refused) ? refused.path : undefined, "note")
  })

  test("registers a tare by the server's project and haulier", () => {
    const body = toVehicleTareCreateBody(plain("scale-house-vehicle-tare-1", "AB 12 345", { submittedValues: { projectId: `project-${PROJECT}`, plate: "AB 12 345", containerRef: "SK-7", tareKg: "7100", weighedOn: "2026-10-01", customerId: `company-${CUSTOMER}` } }), context)
    assert.deepEqual(VehicleTareCreate.parse(body), { projectId: PROJECT, plate: "AB 12 345", trailerPlate: null, containerRef: "SK-7", tareKg: 7_100, weighedOn: "2026-10-01", customerId: CUSTOMER, label: null })
  })
})
