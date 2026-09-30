// Containers on the adapter (#181, slice 5b of #81): the Registry's Container
// with the placement it serves at filed under it, as the records of
// `resources.containers`; the records the workspace writes become the bodies
// the API's contracts accept, held here against the contracts' own zod
// schemas; and the writes go out through the store's seam over a scripted
// `fetch`, the API's refusals coming back as its sentences. A command's
// movement is the ledger's too, so the ledger is read again after it (#198).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerCreate, ContainerPatch, ContainerServicePlacementCreate, ContainerServicePlacementPatch, type Container, type ContainerServicePlacement } from "@waste/contracts/containers"
import type { Project } from "@waste/contracts/organisation"
import { Adjust, Decommission, Receive, Return, Transfer, WAREHOUSE_WITH_A_STOCK_PLACE, type StockMovement } from "@waste/contracts/stock"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createExternalStore } from "../../external-store"
import { problemSentence } from "../problem"
import { moduleKeyOf, NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { CONTAINERS_MODULE, containerAdapter, containerMovements, containersModule, INVENTORY_MODULE, inventoryModule, ledgerRow, stockMovementAdapter, WAREHOUSE_WITH_A_STOCK_PLACE as LOCAL_WAREHOUSE_WITH_A_STOCK_PLACE } from "../records/containers"
import { containerTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS, SERVER_MODULES } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { commandRecord, loaded, loadModule, readModuleInto, rereadsOf, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixtures = getModuleDefinition(CONTAINERS_MODULE)?.records ?? []
const inventoryFixtures = getModuleDefinition(INVENTORY_MODULE)?.records ?? []
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const masterFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "master" })?.records ?? []

// The seeded rows as the API answers them (packages/db/src/seed/registry.ts).
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const harbor: Project = { ...copenhagen, id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const organic: WasteFraction = { ...residual, id: "01a0d2a4-a280-7007-8000-000000000002", key: "organic", name: "Organic" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const bin660: ContainerType = { ...bin240, id: "01a0d2a4-a280-7008-8000-000000000003", name: "Four-wheel bin · 660 L", volumeLitres: 660 }
const warehouseId = "01a0d2a4-a280-7021-8000-000000000001"
const subscriptionId = "01a0d2a4-a280-7013-8000-000000000001"

const bin91007: Container = {
  id: "01a0d2a4-a280-7014-8000-000000000007",
  ...STAMPS,
  projectId: copenhagen.id,
  label: "BIN-91007",
  containerTypeId: bin240.id,
  barcode: "WH91007",
  rfid: null,
  serialNumber: "OTTO-26-91007",
  ownership: "company",
  notes: null,
  assetState: null,
}
const placed: ContainerServicePlacement = {
  id: "01a0d2a4-a280-7015-8000-000000000007",
  ...STAMPS,
  projectId: copenhagen.id,
  containerId: bin91007.id,
  subscriptionId,
  wasteFractionId: residual.id,
  serviceFrequencyId: null,
  effectiveServiceFrequencyId: null,
  validFrom: "2026-01-01",
  validTo: null,
}
const inStock: Container = {
  ...bin91007,
  id: "01a0d2a4-a280-7014-8000-000000000099",
  label: "BIN-99017",
  containerTypeId: bin660.id,
  barcode: null,
  serialNumber: null,
  ownership: "customer",
  notes: "Dented lid",
  assetState: { status: "in-warehouse", warehouseId, placementId: null, since: "2026-09-29T08:00:00.000Z", movementId: "01a0d2a4-a280-7022-8000-000000000001" },
}
const retiredPlacement: ContainerServicePlacement = { ...placed, id: "01a0d2a4-a280-7015-8000-000000000099", containerId: inStock.id, validFrom: "2026-01-01", validTo: "2026-09-01" }

// What the store has loaded when containers load: the organisation, then master data.
const projectRecords = [copenhagen, harbor].map((project) => projectAdapter.toRecord(project, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW }))
const masterContext: MappingContext = { fixtures: masterFixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const masterRecords = [
  wasteFractionAdapter.toRecord(residual, masterContext),
  wasteFractionAdapter.toRecord(organic, masterContext),
  containerTypeAdapter.toRecord(bin240, masterContext),
  containerTypeAdapter.toRecord(bin660, masterContext),
]
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: projectRecords, serverIds: serverIdsOf(projectRecords, [copenhagen.id, harbor.id]) }, 1)],
  ["configure.master", loaded({ records: masterRecords, serverIds: serverIdsOf(masterRecords, [residual.id, organic.id, bin240.id, bin660.id]) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })
const copenhagenWebId = projectRecords[0].id
const bin240WebId = masterRecords[2].id
const bin660WebId = masterRecords[3].id
const organicWebId = masterRecords[1].id

/** A record the Add container form makes: the generic create path's id and kind, its values by field id. */
const formRecord = (values: Record<string, string>): BusinessRecord => ({
  id: "resources-container-1759230000000",
  name: values.containerId ?? "",
  context: "",
  status: "Available",
  owner: "",
  value: "",
  updated: "Just now",
  description: "",
  facts: {},
  related: [],
  source: "Waste",
  freshness: "Live",
  companyId: FIXTURE_COMPANY_ID,
  projectIds: values.projectId ? [values.projectId] : [],
  recordKind: "Container",
  submittedValues: values,
})

describe("the containers module", () => {
  test("is switched, after the organisation, the master data and the warehouses its rows name", () => {
    assert.ok(isServerBacked("resources", "containers"))
    for (const named of ["configure.organization", "configure.master", "resources.warehouses"]) {
      assert.ok(SERVER_MODULE_KEYS.indexOf("resources.containers") > SERVER_MODULE_KEYS.indexOf(named), `after ${named}`)
    }
  })

  test("reads the containers and the placements together and files every placement under its container", async () => {
    const { fetch, calls } = scripted([() => pageOf([bin91007, inStock]), () => pageOf([placed, retiredPlacement])])
    const result = await loadModule(clientOver(fetch), containersModule, { fixtures, state, now: NOW })
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/containers?limit=200", "http://api.test/placements?limit=200"],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`asset-${bin91007.id}`, `asset-${inStock.id}`],
      "no fixture lends its id: a server container is asset-<uuid>, the API's id the handle the schemes name it by",
    )
    assert.equal(result.serverIds.get(`asset-${bin91007.id}`), bin91007.id)
    assert.equal(result.records[0].submittedValues?.placementId, placed.id)
    assert.equal(result.records[1].submittedValues?.placementId, retiredPlacement.id)
  })
})

describe("a container", () => {
  const withPlacements = (container: Container, placements: ContainerServicePlacement[]) => ({ ...container, placements })
  const record = containerAdapter.toRecord(withPlacements(bin91007, [placed]), context())
  const stocked = containerAdapter.toRecord(withPlacements(inStock, [retiredPlacement]), context())

  test("is its label, its type and project by name, and the ledger's reading as its status", () => {
    assert.equal(record.name, "BIN-91007")
    assert.equal(record.context, "Two-wheel bin · 240 L · Copenhagen Central")
    assert.equal(record.status, "No stock record", "a container with no movement has no asset state")
    assert.equal(stocked.status, "In warehouse")
    assert.equal(record.recordKind, "Container")
    assert.deepEqual(record.projectIds, [copenhagenWebId])
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.equal(record.source, "Waste API")
    assert.equal(containerAdapter.statuses, undefined, "the asset state moves only by command")
    assert.ok(containerAdapter.owns(record))
  })

  test("shows the identity a person reads off the bin, the placement it serves at and where the ledger has it", () => {
    assert.equal(record.facts["Container ID"], "BIN-91007")
    assert.equal(record.facts.Barcode, "WH91007")
    assert.equal(record.facts.RFID, "Not recorded")
    assert.equal(record.facts["Container type"], "Two-wheel bin · 240 L")
    assert.equal(record.facts.Ownership, "Company owned")
    assert.equal(record.facts.Project, "Copenhagen Central")
    assert.equal(record.facts["Waste fractions"], "Residual")
    assert.equal(record.facts.Placement, "From 2026-01-01, open")
    assert.equal(record.facts.Subscription, `subscription-${subscriptionId}`, "an id chip until the subscriptions' module is switched (9a)")
    assert.equal(stocked.facts.Warehouse, `warehouse-${warehouseId}`, "an id chip until the warehouses' module is switched (5a)")
    assert.equal(stocked.facts.Placement, "From 2026-01-01 to 2026-08-31", "the last day in, as every period in the web reads")
    assert.equal(stocked.facts.Notes, "Dented lid")
  })

  test("carries its values by the Add container form's field ids, relations by web id", () => {
    assert.deepEqual(record.submittedValues, {
      projectId: copenhagenWebId,
      containerId: "BIN-91007",
      barcode: "WH91007",
      rfid: "",
      serialNumber: "OTTO-26-91007",
      containerType: bin240WebId,
      ownership: "company",
      description: "",
      assetStatus: "",
      warehouseId: "",
      placementId: placed.id,
      subscriptionId: `subscription-${subscriptionId}`,
      wasteFraction: masterRecords[0].id,
      serviceFrequencyId: "",
      placementFrom: "2026-01-01",
      placementTo: "",
    })
    assert.equal(stocked.submittedValues?.assetStatus, "in-warehouse")
    assert.equal(stocked.submittedValues?.warehouseId, `warehouse-${warehouseId}`)
  })

  test("the record the Add container form makes becomes the create body the contract accepts", () => {
    const made = formRecord({ projectId: copenhagenWebId, containerId: "BIN-95001", barcode: "WH95001", rfid: "", serialNumber: "", containerType: bin240WebId, ownership: "customer", description: "Delivered with the lid taped", wasteFraction: organicWebId, status: "in_storage" })
    assert.ok(containerAdapter.owns(made), "a row the form minted is owned by its kind")
    const body = containerAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, { projectId: copenhagen.id, label: "BIN-95001", containerTypeId: bin240.id, barcode: "WH95001", ownership: "customer", notes: "Delivered with the lid taped" })
    assert.ok(ContainerCreate.safeParse(body).success)
  })

  test("a create is refused here, naming the field, without a project, a Container ID or a type the API holds", () => {
    assert.deepEqual(containerAdapter.toCreateBody?.(formRecord({ containerId: "BIN-1", containerType: bin240WebId }), context()), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(containerAdapter.toCreateBody?.(formRecord({ projectId: copenhagenWebId, containerId: "", containerType: bin240WebId }), context()), { path: "containerId", message: "A container needs its Container ID" })
    assert.deepEqual(containerAdapter.toCreateBody?.(formRecord({ projectId: copenhagenWebId, containerId: "BIN-1", containerType: "two-wheel-240" }), context()), { path: "containerType", message: "Pick a container type the API holds" })
    assert.deepEqual(containerAdapter.toCreateBody?.(formRecord({ projectId: copenhagenWebId, containerId: "BIN-1", containerType: bin240WebId, ownership: "leased" }), context()), { path: "ownership", message: "Ownership is company, customer or unrecorded" })
  })

  test("an edit patches what moved of the identity; the project is set once", () => {
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, containerId: "BIN-91007A", rfid: "E2091007", containerType: bin660WebId, barcode: "", description: "Relabelled" } }
    const body = containerAdapter.toPatchBody(record, edited, context())
    assert.deepEqual(body, { container: { label: "BIN-91007A", containerTypeId: bin660.id, barcode: null, rfid: "E2091007", notes: "Relabelled" } })
    assert.ok(ContainerPatch.safeParse((body as { container: unknown }).container).success)
    assert.equal(containerAdapter.toPatchBody(record, record, context()), null)
    const moved: BusinessRecord = { ...record, projectIds: [projectRecords[1].id], submittedValues: { ...record.submittedValues, projectId: projectRecords[1].id } }
    assert.deepEqual(containerAdapter.toPatchBody(record, moved, context()), { path: "projectId", message: "A container stays in its project" })
  })

  test("an edit corrects the placement's fraction, its cadence and an end the ledger has set; it never ends an open one", () => {
    const refractioned: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, wasteFraction: organicWebId } }
    const body = containerAdapter.toPatchBody(record, refractioned, context())
    assert.deepEqual(body, { placement: { id: placed.id, patch: { wasteFractionId: organic.id } } })
    assert.ok(ContainerServicePlacementPatch.safeParse((body as { placement: { patch: unknown } }).placement.patch).success)

    const corrected: BusinessRecord = { ...stocked, submittedValues: { ...stocked.submittedValues, placementTo: "2026-09-14" } }
    assert.deepEqual(containerAdapter.toPatchBody(stocked, corrected, context()), { placement: { id: retiredPlacement.id, patch: { validTo: "2026-09-15" } } }, "the form's last day in is the wire's first day out")

    const ended: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, placementTo: "2026-10-31" } }
    assert.deepEqual(containerAdapter.toPatchBody(record, ended, context()), { path: "placementTo", message: "A placement ends when its container is returned or decommissioned" })
  })

  test("a move of the asset state through an edit is refused before the API: it is the ledger's", async () => {
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, bin91007.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), containersModule, current, { ...record, status: "In service" }, { fixtures, state, now: NOW })
    assert.equal(outcome.kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("writing a container", () => {
  test("a create posts the body and the answer, read back with its placements, replaces the row", async () => {
    const created: Container = { ...bin91007, id: "01a0d2a4-a280-7014-8000-000000000123", label: "BIN-95001", barcode: null, serialNumber: null }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/containers/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const made = formRecord({ projectId: copenhagenWebId, containerId: "BIN-95001", containerType: bin240WebId })
    const outcome = await writeRecord(clientOver(fetch), containersModule, current, made, { fixtures, state, now: NOW })
    assert.equal(calls[0].url, "http://api.test/containers")
    assert.equal(calls[0].init.method, "POST")
    assert.ok(ContainerCreate.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, created.id)
    assert.equal(outcome.record.status, "No stock record")
    assert.equal(outcome.record.submittedValues?.placementId, "", "a container just registered serves nowhere")
  })

  test("an edit of the identity and the placement is two patches, then the row read back", async () => {
    const record = containerAdapter.toRecord({ ...bin91007, placements: [placed] }, context())
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, rfid: "E2091007", wasteFraction: organicWebId } }
    const { fetch, calls } = scripted([
      () => json({ ...bin91007, rfid: "E2091007" }),
      () => json({ ...placed, wasteFractionId: organic.id }),
      () => pageOf([{ ...placed, wasteFractionId: organic.id }]),
    ])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, bin91007.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), containersModule, current, edited, { fixtures, state, now: NOW })
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      [`PATCH http://api.test/containers/${bin91007.id}`, `PATCH http://api.test/placements/${placed.id}`, `GET http://api.test/placements?limit=200&containerId=${bin91007.id}`],
    )
    assert.deepEqual(bodyOf(calls[0]), { rfid: "E2091007" })
    assert.deepEqual(bodyOf(calls[1]), { wasteFractionId: organic.id })
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.id, record.id)
    assert.equal(outcome.record.facts.RFID, "E2091007")
    assert.equal(outcome.record.facts["Waste fractions"], "Organic")
  })

  test("the API's refusal comes back as its own sentence", async () => {
    const { fetch } = scripted([() => problem(409, "A container labelled BIN-91007 is already registered")])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const made = formRecord({ projectId: copenhagenWebId, containerId: "BIN-91007", containerType: bin240WebId })
    const outcome = await writeRecord(clientOver(fetch), containersModule, current, made, { fixtures, state, now: NOW })
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(problemSentence(outcome.problem), "A container labelled BIN-91007 is already registered")
  })
})

describe("the container's commands", () => {
  const nordhavn = { id: warehouseId, webId: `warehouse-${warehouseId}` }
  const record = containerAdapter.toRecord({ ...bin91007, placements: [] }, context())
  const stocked = containerAdapter.toRecord({ ...inStock, placements: [retiredPlacement] }, context())
  const current = loaded({ records: [record, stocked], serverIds: new Map([[record.id, bin91007.id], [stocked.id, inStock.id]]) }, 1)
  const options = { fixtures, state, now: NOW }
  const movement = { id: "01a0d2a4-a280-7022-8000-000000000002", recordedAt: "2026-09-30T11:59:00.000Z", projectId: copenhagen.id, containerId: bin91007.id, kind: "receipt", fromKind: "supplier", fromWarehouseId: null, toKind: "warehouse", toWarehouseId: warehouseId, placementId: null, occurredAt: "2026-09-30T11:59:00.000Z", recordedBy: "01a0d2a4-a280-7005-8000-000000000001", reason: null, reference: null, correctsMovementId: null }
  const received: Container = { ...bin91007, assetState: { status: "in-warehouse", warehouseId, placementId: null, since: movement.occurredAt, movementId: movement.id } }

  /** The body a command's dialog input becomes, or its refusal, for a row. */
  const bodyFor = (name: string, input: Record<string, unknown>, row: BusinessRecord = record) => containerAdapter.commands?.[name]?.toBody?.(input, row, context())

  test("the container has the ledger's five commands and the one door into service", () => {
    assert.deepEqual(Object.keys(containerAdapter.commands ?? {}).sort(), ["adjust", "decommission", "issue", "receive", "return", "transfer"])
  })

  test("the adjustment's warehouse rule is refused in the contract's own words, quoted since the web imports no zod", () => {
    assert.equal(LOCAL_WAREHOUSE_WITH_A_STOCK_PLACE, WAREHOUSE_WITH_A_STOCK_PLACE)
  })

  test("receive posts the warehouse to the container's command path, then the row is read back with the ledger's reading", async () => {
    const { fetch, calls } = scripted([() => json(movement, 201), () => json(received), () => pageOf([])])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, record, "receive", { warehouseId: nordhavn.webId, reference: "DN-4471" }, options)
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      [`POST http://api.test/containers/${bin91007.id}/receive`, `GET http://api.test/containers/${bin91007.id}`, `GET http://api.test/placements?limit=200&containerId=${bin91007.id}`],
    )
    assert.deepEqual(bodyOf(calls[0]), { warehouseId, reference: "DN-4471" })
    assert.ok(Receive.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, record.id)
    assert.equal(outcome.record.status, "In warehouse")
  })

  test("every command names the ledger it appends to, and a done command hands it to the store to read again (#198)", async () => {
    const ledger = moduleKeyOf(INVENTORY_MODULE.workspaceId, INVENTORY_MODULE.moduleId)
    for (const [name, command] of Object.entries(containerAdapter.commands ?? {})) assert.deepEqual(command.touches, [ledger], name)
    const { fetch } = scripted([() => json(movement, 201), () => json(received), () => pageOf([])])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, record, "receive", { warehouseId: nordhavn.webId }, options)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.deepEqual(outcome.touches, [ledger])
    const withLedger: ServerRecordsState = new Map([...state, ["resources.containers", current], [ledger, loaded({ records: [], serverIds: new Map() }, 1)]])
    assert.deepEqual(rereadsOf(withLedger, outcome.touches, SERVER_MODULES), [inventoryModule], "the switched ledger, which the store holds ready")
  })

  test("every command's body is the one its contract accepts", () => {
    const cases: Array<[string, Record<string, unknown>, { safeParse: (value: unknown) => { success: boolean } }, unknown]> = [
      ["receive", { warehouseId: nordhavn.webId, occurredAt: "2026-09-30T09:00:00.000Z" }, Receive, { warehouseId, occurredAt: "2026-09-30T09:00:00.000Z" }],
      ["return", { warehouseId: nordhavn.webId, toKind: "maintenance", lastDay: "2026-09-29", reason: "Cracked lid" }, Return, { warehouseId, toKind: "maintenance", validTo: "2026-09-30", reason: "Cracked lid" }],
      ["transfer", { warehouseId: nordhavn.webId, toKind: "warehouse", reference: "TR-12" }, Transfer, { warehouseId, toKind: "warehouse", reference: "TR-12" }],
      ["decommission", { reason: "Burnt out", lastDay: "2026-09-29" }, Decommission, { reason: "Burnt out", validTo: "2026-09-30" }],
      ["decommission", { reason: "Burnt out" }, Decommission, { reason: "Burnt out" }],
      ["adjust", { toKind: "scrap", reason: "Counted twice at import" }, Adjust, { toKind: "scrap", warehouseId: null, reason: "Counted twice at import" }],
      ["adjust", { toKind: "warehouse", warehouseId: nordhavn.webId, reason: "Imported without its receipt" }, Adjust, { toKind: "warehouse", warehouseId, reason: "Imported without its receipt" }],
      // The movement it corrects by the web id Inventory shows it under, and when it happened on the project's clock (Copenhagen, summer time).
      ["adjust", { toKind: "scrap", reason: "Wrong receipt", correctsMovementId: `movement-${movement.id}`, occurredAt: "2026-09-30T10:00" }, Adjust, { toKind: "scrap", warehouseId: null, reason: "Wrong receipt", correctsMovementId: movement.id, occurredAt: "2026-09-30T08:00:00.000Z" }],
      ["issue", { subscriptionId: `subscription-${subscriptionId}`, wasteFractionId: organicWebId, validFrom: "2026-10-01" }, ContainerServicePlacementCreate, { subscriptionId, wasteFractionId: organic.id, validFrom: "2026-10-01" }],
    ]
    for (const [name, input, schema, expected] of cases) {
      const body = bodyFor(name, input)
      assert.deepEqual(body, expected, name)
      assert.ok(schema.safeParse(body).success, `${name}'s body is refused by its contract`)
    }
  })

  test("a command's body is refused here, naming the field, when it names nothing the API holds or leaves out what it needs", () => {
    assert.deepEqual(bodyFor("receive", {}), { path: "warehouseId", message: "Pick a warehouse the API holds" })
    assert.deepEqual(bodyFor("receive", { warehouseId: "warehouse-west" }), { path: "warehouseId", message: "Pick a warehouse the API holds" }, "a fixture warehouse is no row of the API's")
    assert.deepEqual(bodyFor("receive", { warehouseId: organicWebId }), { path: "warehouseId", message: "Pick a warehouse the API holds" }, "a row the store holds, of another kind")
    assert.deepEqual(bodyFor("issue", { subscriptionId, wasteFractionId: bin240WebId, validFrom: "2026-10-01" }), { path: "wasteFractionId", message: "Pick a waste fraction the API holds" }, "a container type is no fraction")
    assert.deepEqual(bodyFor("return", { warehouseId: nordhavn.webId }), { path: "lastDay", message: "Give the last day it serves" })
    assert.deepEqual(bodyFor("transfer", { warehouseId: nordhavn.webId, toKind: "service" }), { path: "toKind", message: "It arrives in a warehouse or in maintenance at one" })
    assert.deepEqual(bodyFor("decommission", { reason: " " }), { path: "reason", message: "Say why" })
    assert.deepEqual(bodyFor("adjust", { toKind: "scrap", warehouseId: nordhavn.webId, reason: "x" }), { path: "warehouseId", message: "Name the warehouse with warehouse or maintenance and not with scrap" }, "the contract's own sentence")
    assert.deepEqual(bodyFor("adjust", { toKind: "maintenance", reason: "x" }), { path: "warehouseId", message: "Name the warehouse with warehouse or maintenance and not with scrap" })
    assert.deepEqual(bodyFor("issue", { wasteFractionId: organicWebId, validFrom: "2026-10-01" }), { path: "subscriptionId", message: "Give the subscription's id" })
    assert.deepEqual(bodyFor("issue", { subscriptionId, wasteFractionId: "organic", validFrom: "2026-10-01" }), { path: "wasteFractionId", message: "Pick a waste fraction the API holds" })
    assert.deepEqual(bodyFor("issue", { subscriptionId, wasteFractionId: organicWebId, validFrom: "1 Oct" }), { path: "validFrom", message: "Give the first day it serves" })
  })

  test("the issue opens the placement through the Registry's door, and the row is read back in service", async () => {
    const opened: ContainerServicePlacement = { ...placed, id: "01a0d2a4-a280-7015-8000-000000000200", containerId: inStock.id, wasteFractionId: organic.id, validFrom: "2026-10-01" }
    const inService: Container = { ...inStock, assetState: { status: "in-service", warehouseId: null, placementId: opened.id, since: "2026-09-30T12:00:00.000Z", movementId: "01a0d2a4-a280-7022-8000-000000000003" } }
    const { fetch, calls } = scripted([() => json(opened, 201, { location: `/placements/${opened.id}` }), () => json(inService), () => pageOf([retiredPlacement, opened])])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, stocked, "issue", { subscriptionId, wasteFractionId: organicWebId, validFrom: "2026-10-01" }, options)
    assert.equal(calls[0].url, `http://api.test/containers/${inStock.id}/placements`)
    assert.equal(calls[0].init.method, "POST")
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "In service")
    assert.equal(outcome.record.submittedValues?.placementId, opened.id, "the placement the ledger has it in service at")
    assert.equal(outcome.record.facts["Waste fractions"], "Organic")
  })

  test("the API's 409 comes back as its own sentence under a heading naming the container", async () => {
    const detail = "BIN-99017 is already in stock at Nordhavn warehouse"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, stocked, "receive", { warehouseId: nordhavn.webId }, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(problemSentence(outcome.problem), detail)
    assert.equal(outcome.what, "BIN-99017 was not received")
    assert.deepEqual(outcome.touches, ["resources.inventory"], "the API had the command, so the ledger is read again: one read, the price of never missing a movement")
  })

  test("a movement that landed before the row's read back failed is still the ledger's: the refusal names the ledger to read again (#198)", async () => {
    const { fetch, calls } = scripted([() => json(movement, 201), () => problem(503, "The API is restarting"), () => pageOf([])])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, record, "receive", { warehouseId: nordhavn.webId }, options)
    assert.deepEqual(calls.map((call) => call.init.method), ["POST", "GET", "GET"], "the POST, then the read back, which failed")
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(problemSentence(outcome.problem), "The API is restarting")
    assert.deepEqual(outcome.touches, ["resources.inventory"])
  })

  test("a command refused before it is sent touches nothing: nothing reached the API", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), containersModule, current, record, "receive", {}, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(calls.length, 0)
    assert.deepEqual(outcome.touches, [])
  })

  test("a container's own ledger is its movements read, oldest first", async () => {
    const { fetch, calls } = scripted([() => pageOf([movement])])
    const movements = await containerMovements(clientOver(fetch), bin91007.id)
    assert.equal(calls[0].url, `http://api.test/containers/${bin91007.id}/movements?limit=200`)
    assert.deepEqual(movements, [movement])
  })
})

describe("the inventory module", () => {
  const receipt: StockMovement = {
    id: "01a0d2a4-a280-7022-8000-000000000010",
    recordedAt: "2026-09-29T08:01:00.000Z",
    projectId: copenhagen.id,
    containerId: inStock.id,
    kind: "receipt",
    fromKind: "supplier",
    fromWarehouseId: null,
    toKind: "warehouse",
    toWarehouseId: warehouseId,
    placementId: null,
    occurredAt: "2026-09-29T08:00:00.000Z",
    recordedBy: "01a0d2a4-a280-7005-8000-000000000001",
    reason: null,
    reference: "DN-4471",
    correctsMovementId: null,
  }
  const toMaintenance: StockMovement = { ...receipt, id: "01a0d2a4-a280-7022-8000-000000000011", kind: "transfer", fromKind: "warehouse", fromWarehouseId: warehouseId, toKind: "maintenance", reference: null, reason: "Cracked lid" }
  const containerRecord = containerAdapter.toRecord({ ...inStock, placements: [] }, context())
  const withContainers: ServerRecordsState = new Map([...state, ["resources.containers", loaded({ records: [containerRecord], serverIds: new Map([[containerRecord.id, inStock.id]]) }, 1)]])

  test("is switched after the containers its movements name", () => {
    assert.ok(isServerBacked("resources", "inventory"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("resources.inventory") > SERVER_MODULE_KEYS.indexOf("resources.containers"))
  })

  test("lists the ledger across containers, oldest first, each movement a row naming its container by label", async () => {
    const { fetch, calls } = scripted([() => pageOf([receipt, toMaintenance])])
    const result = await loadModule(clientOver(fetch), inventoryModule, { fixtures: inventoryFixtures, state: withContainers, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/stock-movements?limit=200"])
    assert.deepEqual(result.records.map((record) => record.name), ["Receipt · BIN-99017", "Transfer · BIN-99017"])
    const [first, second] = result.records
    assert.equal(first.id, `movement-${receipt.id}`)
    assert.equal(first.status, "Receipt")
    assert.equal(first.context, `Supplier → warehouse-${warehouseId}`, "the warehouse an id chip until 5a")
    assert.equal(second.context, `warehouse-${warehouseId} → Maintenance at warehouse-${warehouseId}`)
    assert.equal(first.facts.Container, "BIN-99017")
    assert.equal(first.facts.Reference, "DN-4471")
    assert.equal(second.facts.Reason, "Cracked lid")
    assert.equal(first.submittedValues?.containerId, containerRecord.id, "the container by its web id")
    assert.deepEqual(first.projectIds, [copenhagenWebId])
    assert.equal(first.recordKind, "Stock movement")
  })

  test("read again after a container's command, it stays ready with its rows while the read is out, then holds the movement the command appended (#198)", async () => {
    const before = await loadModule(clientOver(scripted([() => pageOf([receipt])]).fetch), inventoryModule, { fixtures: inventoryFixtures, state: withContainers, now: NOW })
    const store = createExternalStore<ServerRecordsState>(new Map([...withContainers, ["resources.inventory", loaded(before, 1)]]))
    let whileOut: string[] | undefined
    const { fetch, calls } = scripted([
      () => {
        const held = store.getSnapshot().get("resources.inventory")
        whileOut = held?.status === "ready" ? held.records.map((candidate) => candidate.name) : []
        return pageOf([receipt, toMaintenance])
      },
    ])
    const problem = await readModuleInto(store, clientOver(fetch), inventoryModule, { fixtures: inventoryFixtures, alive: () => true, now: () => 9 })
    assert.equal(problem, null)
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/stock-movements?limit=200"])
    assert.deepEqual(whileOut, ["Receipt · BIN-99017"])
    const ledger = store.getSnapshot().get("resources.inventory")
    assert.deepEqual(ledger?.records.map((candidate) => candidate.name), ["Receipt · BIN-99017", "Transfer · BIN-99017"])
    assert.equal(ledger?.loadedAt, 9)
    assert.equal(store.getSnapshot().get("resources.containers"), withContainers.get("resources.containers"), "the containers are left as they stand")
  })

  test("is append-only: nothing is created or edited here, and a correction is the container's adjustment", async () => {
    const movement = stockMovementAdapter.toRecord(ledgerRow(receipt), context(resolverOver(withContainers)))
    assert.equal(stockMovementAdapter.toCreateBody, undefined)
    assert.deepEqual(stockMovementAdapter.toPatchBody(movement, { ...movement, name: "Edited" }, context()), { path: "kind", message: "The ledger is append-only: a wrong movement is corrected by adjusting its container" })
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [movement], serverIds: new Map([[movement.id, receipt.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), inventoryModule, current, { ...movement, id: "resources-stock-movement-1", recordKind: "Stock movement" }, { fixtures: inventoryFixtures, state, now: NOW })
    assert.equal(outcome.kind, "refused")
    assert.equal(calls.length, 0)
  })
})
