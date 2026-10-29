// Master data on the adapter (#176, slice 2 of #81): the four catalogue
// resources — waste fractions, container types, service frequencies, vehicle
// types — become the records of one module, `configure.master`, which the
// Settings › Master data pane reads and writes and the fixture pickers point
// at; the records the pane writes become the bodies the API's contracts
// accept, held here against the contracts' own zod schemas; and the writes
// go out through the store's seam over a scripted `fetch`, the API's
// refusals coming back as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  ContainerTypeCreate,
  ContainerTypePatch,
  ONE_CADENCE,
  ServiceFrequencyCreate,
  ServiceFrequencyPatch,
  WasteCode,
  WasteFractionCreate,
  WasteFractionPatch,
  type ContainerType,
  type ServiceFrequency,
  type WasteFraction,
} from "@waste/contracts/catalogue"
import type { Project } from "@waste/contracts/organisation"
import type { ContaminantCode } from "@waste/contracts/pickup-exceptions"
import type { DecommissionReason } from "@waste/contracts/stock"
import { VehicleTypeContainerTypesSet, VehicleTypeCreate, VehicleTypePatch, type VehicleType } from "@waste/contracts/vehicle-types"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createMasterDataRecord, KEY_REFUSAL, MASTER_DATA_MODULE, masterDataKindOf, NO_TREATMENT, WASTE_CODE_REFUSAL } from "../../data/master-data"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { VehicleTypeConsumptionSet } from "@waste/contracts/emissions"
import { CONSUMPTION_REFUSAL } from "@/lib/data/fleet-emissions"
import { containerTypeAdapter, contaminantCodeAdapter, decommissionReasonAdapter, masterDataModule, ONE_CADENCE as LOCAL_ONE_CADENCE, serviceFrequencyAdapter, vehicleTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const module = getModuleDefinition(MASTER_DATA_MODULE)
if (!module) throw new Error("no module configure.master")
const masterFixtures = module.records
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

const context = (resolve: Resolver = NOTHING_RESOLVED): MappingContext => ({ fixtures: masterFixtures, resolve, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

// The seeded rows as the API answers them (packages/db/src/seed/registry.ts, resources.ts).
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null } }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual", wasteCode: null, treatment: null, densityKgPerCubicMetre: null, hazardous: false }
const glass: WasteFraction = { ...residual, id: "01a0d2a4-a280-7005-8000-000000000005", key: "glass", name: "Glass" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7006-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240, serviceSeconds: null }
const igloo: ContainerType = { ...bin240, id: "01a0d2a4-a280-7006-8000-000000000005", name: "Igloo · 2,500 L", volumeLitres: 2500 }
const unmeasured: ContainerType = { ...bin240, id: "01a0d2a4-a280-7006-8000-000000000009", name: "Skip", volumeLitres: null }
const weekly: ServiceFrequency = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Every week", description: "One collection per week on the serviced weekday.", collectionsPerWeek: 1, weeksBetween: 1, daysBetween: null }
const monthly: ServiceFrequency = { ...weekly, id: "01a0d2a4-a280-7007-8000-000000000003", name: "Once a month", description: null, collectionsPerWeek: 1, weeksBetween: null, daysBetween: null }
const onDemand: ServiceFrequency = { ...weekly, id: "01a0d2a4-a280-7007-8000-000000000004", name: "On demand", description: null, collectionsPerWeek: null, weeksBetween: null, daysBetween: null }
const twiceWeekly: ServiceFrequency = { ...weekly, id: "01a0d2a4-a280-7007-8000-000000000005", name: "Twice a week", description: null, collectionsPerWeek: 2, weeksBetween: null, daysBetween: 3 }
const rearLoader: VehicleType = { id: "01a0d2a4-a280-7008-8000-000000000001", ...STAMPS, key: "rear-loader", name: "Rear loader", description: null, containerTypeIds: [bin240.id], consumption: [], checklist: [] }
const foodInGlass: ContaminantCode = { id: "01a0d2a4-a280-702a-8000-000000000001", ...STAMPS, code: "food-in-glass", name: "Food in glass", status: "active", wasteFractionIds: [glass.id] }
const hazardous: ContaminantCode = { ...foodInGlass, id: "01a0d2a4-a280-702a-8000-000000000002", code: "hazardous", name: "Hazardous waste", status: "inactive", wasteFractionIds: [] }
const wornOut: DecommissionReason = { id: "01a0d2a4-a280-702e-8000-000000000001", createdAt: foodInGlass.createdAt, updatedAt: foodInGlass.updatedAt, code: "worn-out", name: "Worn out", status: "active" }
const stolen: DecommissionReason = { ...wornOut, id: "01a0d2a4-a280-702e-8000-000000000002", code: "stolen", name: "Stolen", status: "inactive" }
const glassCrane: VehicleType = { ...rearLoader, id: "01a0d2a4-a280-7008-8000-000000000004", key: "glass-crane", name: "Glass crane", description: "Crane over the igloo", containerTypeIds: [igloo.id] }
const trailer: VehicleType = { ...rearLoader, id: "01a0d2a4-a280-7008-8000-000000000006", key: "closed-trailer", name: "Closed trailer", description: null, containerTypeIds: [] }

// The organisation module as the store has it when master data loads.
const copenhagenRecord = projectAdapter.toRecord(copenhagen, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW })
const state: ServerRecordsState = new Map([["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id]]) }, 1)]])
const resolve = resolverOver(state)

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** The module loaded over the four seeded lists, in the module's own order. */
async function loadedMaster() {
  const { fetch, calls } = scripted([() => pageOf([residual, glass]), () => pageOf([bin240, igloo, unmeasured]), () => pageOf([weekly, monthly, onDemand, twiceWeekly]), () => pageOf([rearLoader, glassCrane, trailer]), () => pageOf([foodInGlass, hazardous]), () => pageOf([wornOut, stolen])])
  const result = await loadModule(clientOver(fetch), masterDataModule, { fixtures: masterFixtures, state, now: NOW })
  return { result, calls }
}

describe("the master data module", () => {
  test("is switched, after the organisation its frequencies name their project in", () => {
    assert.ok(isServerBacked("configure", "master"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("configure.master") > SERVER_MODULE_KEYS.indexOf("configure.organization"))
  })

  test("loads the six lists in one order — container types before the vehicle types that name them, the fractions before the contaminant codes, the decommission reasons last — and files every row under its own prefix", async () => {
    const { result, calls } = await loadedMaster()
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/waste-fractions?limit=200", "http://api.test/container-types?limit=200", "http://api.test/service-frequencies?limit=200", "http://api.test/vehicle-types?limit=200", "http://api.test/contaminant-codes?limit=200", "http://api.test/decommission-reasons?limit=200"],
    )
    assert.deepEqual(result.records.map((record) => masterDataKindOf(record)), [
      "waste-fraction",
      "waste-fraction",
      "container-type",
      "container-type",
      "container-type",
      "service-frequency",
      "service-frequency",
      "service-frequency",
      "service-frequency",
      "vehicle-type",
      "vehicle-type",
      "vehicle-type",
      "contaminant-code",
      "contaminant-code",
      "decommission-reason",
      "decommission-reason",
    ])
    assert.equal(result.records.length, 16, "the fixture master-data sets lend nothing: no row is one of them")
    assert.equal(result.serverIds.get(`fraction-${residual.id}`), residual.id)
    const crane = result.records.find((record) => record.name === "Glass crane")
    assert.equal(crane?.facts["Container types"], "Igloo · 2,500 L", "a vehicle type names its container types by the rows loaded before it")
    const food = result.records.find((record) => record.name === "Food in glass")
    assert.deepEqual([food?.facts.Code, food?.facts.Fractions, food?.facts.Status], ["food-in-glass", "Glass", "Active"], "a code names its fractions by the rows loaded before it")
    const retired = result.records.find((record) => record.name === "Hazardous waste")
    assert.deepEqual([retired?.facts.Fractions, retired?.facts.Status, retired?.value], ["Every fraction", "Retired", "Retired"])
    // A decommission reason (O30 of #290): its code and whether it is still offered.
    const scrap = result.records.find((record) => record.name === "Stolen")
    assert.deepEqual([scrap?.id, scrap?.facts.Code, scrap?.facts.Status], [`decommission-reason-${stolen.id}`, "stolen", "Retired"])
  })
})

describe("a contaminant code (M5 of #293)", () => {
  const withFractions: ServerRecordsState = new Map([
    ["configure.master", loaded({ records: [wasteFractionAdapter.toRecord(residual, context()), wasteFractionAdapter.toRecord(glass, context())], serverIds: new Map([[`fraction-${residual.id}`, residual.id], [`fraction-${glass.id}`, glass.id]]) }, 1)],
  ])
  const over = () => context(resolverOver(withFractions))
  const record = contaminantCodeAdapter.toRecord(foodInGlass, over())

  test("is a record under its own prefix, its code the key, its status and its fractions by web id", () => {
    assert.equal(record.id, `contaminant-code-${foodInGlass.id}`)
    assert.deepEqual(record.submittedValues, { kind: "contaminant-code", name: "Food in glass", key: "food-in-glass", status: "active", wasteFractionIds: `fraction-${glass.id}` })
  })

  test("is created with its code, name, status and fractions by server id; a code that is no slug is refused here", () => {
    const made = { ...record, id: "contaminant-code-1700000000000", submittedValues: { kind: "contaminant-code", name: "Plastic in organic", key: "plastic-in-organic", status: "active", wasteFractionIds: `fraction-${residual.id}` } }
    assert.deepEqual(contaminantCodeAdapter.toCreateBody?.(made, over()), { code: "plastic-in-organic", name: "Plastic in organic", status: "active", wasteFractionIds: [residual.id] })
    assert.deepEqual(contaminantCodeAdapter.toCreateBody?.({ ...made, submittedValues: { ...made.submittedValues, key: "Plastic In Organic" } }, over()), { path: "key", message: KEY_REFUSAL })
  })

  test("a patch moves the name or the status and puts the fractions whole when they moved; the code never moves", async () => {
    const retired = { ...record, submittedValues: { ...record.submittedValues, status: "inactive", wasteFractionIds: `fraction-${glass.id},fraction-${residual.id}` } }
    const body = contaminantCodeAdapter.toPatchBody(record, retired, over())
    assert.deepEqual(body, { code: { status: "inactive" }, wasteFractionIds: [glass.id, residual.id] })
    assert.equal(contaminantCodeAdapter.toPatchBody(record, { ...record }, over()), null, "nothing moved")
    assert.deepEqual(contaminantCodeAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, key: "glass-food" } }, over()), { path: "key", message: "The code is set once: a contaminant code that needs another code is another contaminant code" })
    const { fetch, calls } = scripted([() => json({ ...foodInGlass, status: "inactive" }), () => json({ ...foodInGlass, status: "inactive", wasteFractionIds: [glass.id, residual.id] })])
    const answered = await contaminantCodeAdapter.update(clientOver(fetch), foodInGlass.id, body)
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [["PATCH", `http://api.test/contaminant-codes/${foodInGlass.id}`], ["PUT", `http://api.test/contaminant-codes/${foodInGlass.id}/fractions`]])
    assert.deepEqual(answered.wasteFractionIds, [glass.id, residual.id])
  })
})

describe("a decommission reason (O30 of #290, row 9.6)", () => {
  const record = decommissionReasonAdapter.toRecord(wornOut, context())

  test("is a record under its own prefix, its code the key and its status", () => {
    assert.equal(record.id, `decommission-reason-${wornOut.id}`)
    assert.deepEqual(record.submittedValues, { kind: "decommission-reason", name: "Worn out", key: "worn-out", status: "active" })
  })

  test("is created with its code, name and status; a code that is no slug is refused here", () => {
    const made = { ...record, id: "decommission-reason-1700000000000", submittedValues: { kind: "decommission-reason", name: "Fire", key: "fire", status: "active" } }
    assert.deepEqual(decommissionReasonAdapter.toCreateBody?.(made, context()), { code: "fire", name: "Fire", status: "active" })
    assert.deepEqual(decommissionReasonAdapter.toCreateBody?.({ ...made, submittedValues: { ...made.submittedValues, key: "Fire" } }, context()), { path: "key", message: KEY_REFUSAL })
  })

  test("a patch moves the name or the status, one PATCH; the code never moves", async () => {
    const retired = { ...record, submittedValues: { ...record.submittedValues, status: "inactive" } }
    const body = decommissionReasonAdapter.toPatchBody(record, retired, context())
    assert.deepEqual(body, { status: "inactive" })
    assert.equal(decommissionReasonAdapter.toPatchBody(record, { ...record }, context()), null, "nothing moved")
    assert.deepEqual(decommissionReasonAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, key: "worn" } }, context()), { path: "key", message: "The code is set once: a decommission reason that needs another code is another reason" })
    const { fetch, calls } = scripted([() => json({ ...wornOut, status: "inactive" })])
    await decommissionReasonAdapter.update(clientOver(fetch), wornOut.id, body)
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [["PATCH", `http://api.test/decommission-reasons/${wornOut.id}`]])
  })
})

describe("a waste fraction", () => {
  const record = wasteFractionAdapter.toRecord(residual, context())

  test("is a record under its own prefix, its key beside its name, with nothing to move: the status is the module's word for a row in force", () => {
    assert.equal(record.id, `fraction-${residual.id}`)
    assert.equal(record.name, "Residual")
    assert.equal(record.context, "Waste fraction · residual")
    assert.equal(record.status, "Effective")
    assert.equal(record.recordKind, "Waste fraction")
    assert.equal(record.facts.Kind, "Waste fraction")
    assert.equal(record.facts.Key, "residual")
    assert.deepEqual(record.projectIds, [], "the company's, so every scope shows it")
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.deepEqual(record.submittedValues, { kind: "waste-fraction", name: "Residual", key: "residual" })
    assert.equal(wasteFractionAdapter.statuses, undefined)
    assert.ok(wasteFractionAdapter.owns(record))
    assert.ok(!containerTypeAdapter.owns(record))
  })

  test("the record the pane writes becomes the create body the contract accepts", () => {
    const made = createMasterDataRecord("waste-fraction", { name: "Hard plastic", key: "hard-plastic" }, { now: 1, actorName: "Olivia Larsen", lookups: { projectName: () => undefined, containerTypeName: () => undefined } })
    assert.ok(wasteFractionAdapter.owns(made), "a row minted by the pane is owned by its kind's adapter")
    const body = wasteFractionAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, { key: "hard-plastic", name: "Hard plastic" })
    assert.ok(WasteFractionCreate.safeParse(body).success)
  })

  test("is refused here, naming the field, without a name or with a key that is no slug", () => {
    const made = (values: Record<string, string>) => createMasterDataRecord("waste-fraction", values, { now: 1, actorName: "Olivia Larsen", lookups: { projectName: () => undefined, containerTypeName: () => undefined } })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(made({ name: "", key: "x" }), context()), { path: "name", message: "A waste fraction needs a name" })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(made({ name: "Plast", key: "Hard Plastic" }), context()), { path: "key", message: "A key is a lowercase slug of letters, digits and single hyphens, such as hard-plastic" })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(made({ name: "Plast", key: "" }), context()), { path: "key", message: "A key is a lowercase slug of letters, digits and single hyphens, such as hard-plastic" })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(made({ name: "Plast", key: "plast", wasteCode: "15 01" }), context()), { path: "wasteCode", message: WASTE_CODE_REFUSAL })
  })

  test("carries its waste code (#291 slice 29): read into the record, sent compact on a create, and patched — a cleared one as null", () => {
    const coded = wasteFractionAdapter.toRecord({ ...residual, wasteCode: "200301" }, context())
    assert.equal(coded.facts["Waste code"], "200301")
    assert.deepEqual(coded.submittedValues, { kind: "waste-fraction", name: "Residual", key: "residual", wasteCode: "200301" })
    assert.equal(record.facts["Waste code"], undefined, "a fraction nobody has coded shows none")
    const made = createMasterDataRecord("waste-fraction", { name: "Glass packaging", key: "glass-packaging", wasteCode: "15 01 07" }, { now: 1, actorName: "Olivia Larsen", lookups: { projectName: () => undefined, containerTypeName: () => undefined } })
    const body = wasteFractionAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, { key: "glass-packaging", name: "Glass packaging", wasteCode: "150107" })
    assert.ok(WasteFractionCreate.safeParse(body).success)
    const typed = (wasteCode: string): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, wasteCode } })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, typed("20 03 01"), context()), { wasteCode: "200301" })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(coded, typed(""), context()), { wasteCode: null })
    assert.ok(WasteFractionPatch.safeParse({ wasteCode: null }).success)
    assert.equal(wasteFractionAdapter.toPatchBody(coded, { ...coded, submittedValues: { ...coded.submittedValues, wasteCode: "20 03 01" } }, context()), null, "the same code spelled as printed is no change")
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, typed("2003"), context()), { path: "wasteCode", message: WASTE_CODE_REFUSAL })
    assert.equal(WasteCode.safeParse("2003").error?.issues[0]?.message, WASTE_CODE_REFUSAL, "the pane refuses in the contract's words")
  })

  test("carries its hazardous flag (O18 of #290): read into the record as a ticked box and a fact, sent only when ticked on a create, and patched both ways", () => {
    const flagged = wasteFractionAdapter.toRecord({ ...residual, wasteCode: "200133*", hazardous: true }, context())
    assert.equal(flagged.facts.Hazardous, "Yes")
    assert.equal(flagged.submittedValues?.hazardous, true)
    assert.equal(record.facts.Hazardous, undefined, "a fraction that is not hazardous says nothing of it")
    assert.equal(record.submittedValues?.hazardous, undefined)
    const lookups = { projectName: () => undefined, containerTypeName: () => undefined }
    const ticked = createMasterDataRecord("waste-fraction", { name: "Asbestos", key: "asbestos", hazardous: true }, { now: 1, actorName: "Olivia Larsen", lookups })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(ticked, context()), { key: "asbestos", name: "Asbestos", hazardous: true })
    const starred = createMasterDataRecord("waste-fraction", { name: "Batteries", key: "batteries", wasteCode: "20 01 33*", hazardous: false }, { now: 1, actorName: "Olivia Larsen", lookups })
    assert.deepEqual(wasteFractionAdapter.toCreateBody?.(starred, context()), { key: "batteries", name: "Batteries", wasteCode: "200133*" }, "left to the API, which reads the asterisk")
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, hazardous: true } }, context()), { hazardous: true })
    const unticked = Object.fromEntries(Object.entries(flagged.submittedValues ?? {}).filter(([key]) => key !== "hazardous"))
    assert.deepEqual(wasteFractionAdapter.toPatchBody(flagged, { ...flagged, submittedValues: unticked }, context()), { hazardous: false })
    assert.ok(WasteFractionPatch.safeParse({ hazardous: false }).success)
  })

  test("carries its density (O10 of #290): read into the record, sent on a create, and patched, blank as null", () => {
    const dense = wasteFractionAdapter.toRecord({ ...residual, densityKgPerCubicMetre: 150 }, context())
    assert.deepEqual([dense.facts.Density, dense.submittedValues?.densityKgPerCubicMetre], ["150 kg/m³", "150"])
    const made = createMasterDataRecord("waste-fraction", { name: "Garden waste", key: "garden", densityKgPerCubicMetre: "250" }, { now: 1, actorName: "Olivia Larsen", lookups: { projectName: () => undefined, containerTypeName: () => undefined } })
    const body = wasteFractionAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, { key: "garden", name: "Garden waste", densityKgPerCubicMetre: 250 })
    assert.ok(WasteFractionCreate.safeParse(body).success)
    const typed = (density: string): BusinessRecord => ({ ...dense, submittedValues: { ...dense.submittedValues, densityKgPerCubicMetre: density } })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(dense, typed("180"), context()), { densityKgPerCubicMetre: 180 })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(dense, typed(""), context()), { densityKgPerCubicMetre: null })
    assert.ok(WasteFractionPatch.safeParse({ densityKgPerCubicMetre: null }).success)
  })

  test("carries its treatment (M13 of #293): read into the record, sent on a create, and patched — not recorded as null", () => {
    const treated = wasteFractionAdapter.toRecord({ ...residual, treatment: "recycling" }, context())
    assert.equal(treated.facts.Treatment, "Recycling")
    assert.equal(treated.submittedValues?.treatment, "recycling")
    assert.equal(record.facts.Treatment, undefined, "a fraction nobody has treated shows none")
    assert.equal(record.submittedValues?.treatment, undefined)
    const made = createMasterDataRecord("waste-fraction", { name: "Garden waste", key: "garden", treatment: "recycling" }, { now: 1, actorName: "Olivia Larsen", lookups: { projectName: () => undefined, containerTypeName: () => undefined } })
    const body = wasteFractionAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, { key: "garden", name: "Garden waste", treatment: "recycling" })
    assert.ok(WasteFractionCreate.safeParse(body).success)
    const typed = (treatment: string): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, treatment } })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, typed("disposal"), context()), { treatment: "disposal" })
    assert.deepEqual(wasteFractionAdapter.toPatchBody(treated, { ...treated, submittedValues: { ...treated.submittedValues, treatment: NO_TREATMENT } }, context()), { treatment: null })
    assert.ok(WasteFractionPatch.safeParse({ treatment: null }).success)
  })

  test("a rename is the patch; the key and the kind are set once", () => {
    const renamed: BusinessRecord = { ...record, name: "Restaffald", submittedValues: { ...record.submittedValues, name: "Restaffald" } }
    const body = wasteFractionAdapter.toPatchBody(record, renamed, context())
    assert.deepEqual(body, { name: "Restaffald" })
    assert.ok(WasteFractionPatch.safeParse(body).success)
    assert.equal(wasteFractionAdapter.toPatchBody(record, record, context()), null)
    const rekeyed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, key: "rest" } }
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, rekeyed, context()), { path: "key", message: "The key is set once: a waste fraction that needs another key is another waste fraction" })
    const rekinded: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, kind: "container-type" } }
    assert.deepEqual(wasteFractionAdapter.toPatchBody(record, rekinded, context()), { path: "kind", message: "A row keeps its kind" })
  })

  test("through the store's write, a create posts and the API's 409 comes back as its sentence", async () => {
    const lookups = { projectName: () => undefined, containerTypeName: () => undefined }
    const made = createMasterDataRecord("waste-fraction", { name: "Hard plastic", key: "hard-plastic" }, { now: 1, actorName: "Olivia Larsen", lookups })
    const created: WasteFraction = { ...residual, id: "019995e0-0000-7000-8000-0000000000f1", key: "hard-plastic", name: "Hard plastic" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/waste-fractions/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), masterDataModule, current, made, { fixtures: masterFixtures, state, now: NOW })
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].url, "http://api.test/waste-fractions")
    assert.deepEqual(bodyOf(calls[0]), { key: "hard-plastic", name: "Hard plastic" })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, created.id)
    assert.equal(outcome.record.name, "Hard plastic")

    const refused = scripted([() => problem(409, 'The company already has a waste fraction with the key "hard-plastic"')])
    const answer = await writeRecord(clientOver(refused.fetch), masterDataModule, current, made, { fixtures: masterFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), 'The company already has a waste fraction with the key "hard-plastic"')
  })
})

describe("a container type", () => {
  const lookups = { projectName: () => undefined, containerTypeName: () => undefined }
  const made = (values: Record<string, string>) => createMasterDataRecord("container-type", values, { now: 1, actorName: "Olivia Larsen", lookups })

  test("is a record with its volume, or without one where nobody recorded it", () => {
    const record = containerTypeAdapter.toRecord(bin240, context())
    assert.equal(record.id, `container-type-${bin240.id}`)
    assert.equal(record.context, "Container type · 240 L")
    assert.equal(record.value, "240 L")
    assert.equal(record.facts.Volume, "240 L")
    assert.deepEqual(record.submittedValues, { kind: "container-type", name: "Two-wheel bin · 240 L", volumeLitres: "240" })
    const skip = containerTypeAdapter.toRecord(unmeasured, context())
    assert.equal(skip.context, "Container type · volume not recorded")
    assert.equal(skip.facts.Volume, undefined)
    assert.deepEqual(skip.submittedValues, { kind: "container-type", name: "Skip" })
  })

  test("the create body carries the volume as a whole number of litres, or leaves it out", () => {
    const body = containerTypeAdapter.toCreateBody?.(made({ name: "Igloo · 2,500 L", volumeLitres: "2500" }), context())
    assert.deepEqual(body, { name: "Igloo · 2,500 L", volumeLitres: 2500 })
    assert.ok(ContainerTypeCreate.safeParse(body).success)
    const bare = containerTypeAdapter.toCreateBody?.(made({ name: "Skip" }), context())
    assert.deepEqual(bare, { name: "Skip" })
    assert.ok(ContainerTypeCreate.safeParse(bare).success)
    assert.deepEqual(containerTypeAdapter.toCreateBody?.(made({ name: "Skip", volumeLitres: "2.5" }), context()), { path: "volumeLitres", message: "A volume is a whole number of litres" })
    assert.deepEqual(containerTypeAdapter.toCreateBody?.(made({ name: "Skip", volumeLitres: "0" }), context()), { path: "volumeLitres", message: "A volume is a whole number of litres" })
    assert.deepEqual(containerTypeAdapter.toCreateBody?.(made({ name: "" }), context()), { path: "name", message: "A container type needs a name" })
  })

  test("a volume cleared on edit is null on the wire, and a volume changed is the number", () => {
    const record = containerTypeAdapter.toRecord(bin240, context())
    const cleared: BusinessRecord = { ...record, submittedValues: { kind: "container-type", name: "Two-wheel bin · 240 L" } }
    const body = containerTypeAdapter.toPatchBody(record, cleared, context())
    assert.deepEqual(body, { volumeLitres: null })
    assert.ok(ContainerTypePatch.safeParse(body).success)
    const grown: BusinessRecord = { ...record, name: "Two-wheel bin · 360 L", submittedValues: { ...record.submittedValues, name: "Two-wheel bin · 360 L", volumeLitres: "360" } }
    const body2 = containerTypeAdapter.toPatchBody(record, grown, context())
    assert.deepEqual(body2, { name: "Two-wheel bin · 360 L", volumeLitres: 360 })
    assert.ok(ContainerTypePatch.safeParse(body2).success)
  })

  test("the update patches the row's own route", async () => {
    const { fetch, calls } = scripted([() => json({ ...bin240, volumeLitres: 360 })])
    const answer = await containerTypeAdapter.update(clientOver(fetch), bin240.id, { volumeLitres: 360 })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/container-types/${bin240.id}`])
    assert.equal(answer.volumeLitres, 360)
  })
})

describe("a service frequency", () => {
  const lookups = { projectName: (id: string) => (id === FIXTURE_PROJECT_IDS.copenhagen ? "Copenhagen Central" : undefined), containerTypeName: () => undefined }
  const made = (values: Record<string, string>) => createMasterDataRecord("service-frequency", values, { now: 1, actorName: "Olivia Larsen", lookups })

  test("is a record in its project, its cadence read off the three numbers the way the contract explains them", () => {
    const record = serviceFrequencyAdapter.toRecord(weekly, context(resolve))
    assert.equal(record.id, `frequency-${weekly.id}`)
    assert.equal(record.context, "Service frequency · Copenhagen Central")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.facts.Project, "Copenhagen Central")
    assert.equal(record.facts.Cadence, "Every week")
    assert.equal(record.value, "Every week")
    assert.equal(record.facts.Description, "One collection per week on the serviced weekday.")
    assert.deepEqual(record.submittedValues, { kind: "service-frequency", name: "Every week", projectId: FIXTURE_PROJECT_IDS.copenhagen, description: "One collection per week on the serviced weekday.", collectionsPerWeek: "1", weeksBetween: "1" })
    assert.equal(serviceFrequencyAdapter.toRecord(monthly, context(resolve)).facts.Cadence, "Once a month")
    assert.equal(serviceFrequencyAdapter.toRecord(onDemand, context(resolve)).facts.Cadence, "On demand")
    assert.equal(serviceFrequencyAdapter.toRecord(twiceWeekly, context(resolve)).facts.Cadence, "2 collections a week, every 3 days")
    assert.equal(serviceFrequencyAdapter.toRecord({ ...weekly, weeksBetween: 2 }, context(resolve)).facts.Cadence, "Every 2 weeks")
  })

  test("the create body names the project by its server id and carries the numbers given, on demand being none", () => {
    const body = serviceFrequencyAdapter.toCreateBody?.(made({ name: "Every 3 weeks", projectId: FIXTURE_PROJECT_IDS.copenhagen, description: "Every third week.", collectionsPerWeek: "1", weeksBetween: "3" }), context(resolve))
    assert.deepEqual(body, { projectId: copenhagen.id, name: "Every 3 weeks", description: "Every third week.", collectionsPerWeek: 1, weeksBetween: 3 })
    assert.ok(ServiceFrequencyCreate.safeParse(body).success)
    const demand = serviceFrequencyAdapter.toCreateBody?.(made({ name: "On call", projectId: FIXTURE_PROJECT_IDS.copenhagen }), context(resolve))
    assert.deepEqual(demand, { projectId: copenhagen.id, name: "On call" })
    assert.ok(ServiceFrequencyCreate.safeParse(demand).success)
  })

  test("is refused here without a project the store loaded, without a name, with a number that is no count, or with a cadence the one rule refuses — in the contract's own sentence", () => {
    assert.equal(LOCAL_ONE_CADENCE, ONE_CADENCE, "one rule, one sentence: the adapter quotes the contract's")
    assert.deepEqual(serviceFrequencyAdapter.toCreateBody?.(made({ name: "Weekly", projectId: "project-nowhere" }), context(resolve)), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(serviceFrequencyAdapter.toCreateBody?.(made({ name: "", projectId: FIXTURE_PROJECT_IDS.copenhagen }), context(resolve)), { path: "name", message: "A service frequency needs a name" })
    assert.deepEqual(serviceFrequencyAdapter.toCreateBody?.(made({ name: "Weekly", projectId: FIXTURE_PROJECT_IDS.copenhagen, weeksBetween: "1.5" }), context(resolve)), { path: "weeksBetween", message: "Weeks between is a whole number, 1 or more" })
    assert.deepEqual(serviceFrequencyAdapter.toCreateBody?.(made({ name: "Weekly", projectId: FIXTURE_PROJECT_IDS.copenhagen, weeksBetween: "2" }), context(resolve)), { path: "collectionsPerWeek", message: ONE_CADENCE }, "an interval needs a rate")
    assert.deepEqual(serviceFrequencyAdapter.toCreateBody?.(made({ name: "Weekly", projectId: FIXTURE_PROJECT_IDS.copenhagen, collectionsPerWeek: "1", weeksBetween: "2", daysBetween: "3" }), context(resolve)), { path: "collectionsPerWeek", message: ONE_CADENCE }, "two intervals are two ways of saying the same thing")
  })

  test("a patch carries what moved, a cleared number as null, and holds the merged cadence to the rule; the project does not move", () => {
    const record = serviceFrequencyAdapter.toRecord(weekly, context(resolve))
    const fortnightly: BusinessRecord = { ...record, name: "Every 2 weeks", submittedValues: { ...record.submittedValues, name: "Every 2 weeks", weeksBetween: "2", description: "" } }
    const body = serviceFrequencyAdapter.toPatchBody(record, fortnightly, context(resolve))
    assert.deepEqual(body, { name: "Every 2 weeks", description: null, weeksBetween: 2 })
    assert.ok(ServiceFrequencyPatch.safeParse(body).success)
    const rateless: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, collectionsPerWeek: "" } }
    assert.deepEqual(serviceFrequencyAdapter.toPatchBody(record, rateless, context(resolve)), { path: "collectionsPerWeek", message: ONE_CADENCE }, "dropping the rate strands the interval")
    const moved: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, projectId: "project-harbor" } }
    assert.deepEqual(serviceFrequencyAdapter.toPatchBody(record, moved, context(resolve)), { path: "projectId", message: "A service frequency stays in its project" })
    assert.equal(serviceFrequencyAdapter.toPatchBody(record, record, context(resolve)), null)
  })
})

describe("a vehicle type", () => {
  const containerTypes = [bin240, igloo, unmeasured].map((type) => containerTypeAdapter.toRecord(type, context()))
  const withTypes: ServerRecordsState = new Map([
    ...state,
    ["configure.master", loaded({ records: containerTypes, serverIds: new Map(containerTypes.map((record, index) => [record.id, [bin240, igloo, unmeasured][index].id])) }, 1)],
  ])
  const resolveTypes = resolverOver(withTypes)
  const lookups = { projectName: () => undefined, containerTypeName: (id: string) => containerTypes.find((record) => record.id === id)?.name }
  const made = (values: Record<string, string>) => createMasterDataRecord("vehicle-type", values, { now: 1, actorName: "Olivia Larsen", lookups })

  test("is a record naming the container types it services by their web ids, and by name in its facts", () => {
    const record = vehicleTypeAdapter.toRecord(glassCrane, context(resolveTypes))
    assert.equal(record.id, `vehicle-type-${glassCrane.id}`)
    assert.equal(record.context, "Vehicle type · glass-crane")
    assert.equal(record.value, "1 container type")
    assert.equal(record.facts["Container types"], "Igloo · 2,500 L")
    assert.equal(record.facts.Description, "Crane over the igloo")
    assert.deepEqual(record.submittedValues, { kind: "vehicle-type", name: "Glass crane", key: "glass-crane", description: "Crane over the igloo", containerTypeIds: `container-type-${igloo.id}` })
    const bare = vehicleTypeAdapter.toRecord(trailer, context(resolveTypes))
    assert.equal(bare.value, "No container types")
    assert.equal(bare.facts["Container types"], undefined)
    assert.deepEqual(bare.submittedValues, { kind: "vehicle-type", name: "Closed trailer", key: "closed-trailer" })
  })

  test("names a container type by the web id the store knows it under, so one made this session keeps its minted id", () => {
    const minted: BusinessRecord = { ...containerTypes[0], id: "container-type-1700000000000" }
    const session: ServerRecordsState = new Map([...state, ["configure.master", loaded({ records: [minted], serverIds: new Map([[minted.id, bin240.id]]) }, 1)]])
    const record = vehicleTypeAdapter.toRecord(rearLoader, context(resolverOver(session)))
    assert.equal(record.submittedValues?.containerTypeIds, "container-type-1700000000000")
    assert.equal(record.facts["Container types"], "Two-wheel bin · 240 L")
  })

  test("the create body names the container types by server id, and is refused for one the store does not hold", () => {
    const body = vehicleTypeAdapter.toCreateBody?.(made({ name: "Side loader", key: "side-loader", description: "Kerbside arm", containerTypeIds: `container-type-${bin240.id},container-type-${igloo.id}` }), context(resolveTypes))
    assert.deepEqual(body, { key: "side-loader", name: "Side loader", description: "Kerbside arm", containerTypeIds: [bin240.id, igloo.id] })
    assert.ok(VehicleTypeCreate.safeParse(body).success)
    const none = vehicleTypeAdapter.toCreateBody?.(made({ name: "Side loader", key: "side-loader" }), context(resolveTypes))
    assert.deepEqual(none, { key: "side-loader", name: "Side loader", containerTypeIds: [] })
    assert.ok(VehicleTypeCreate.safeParse(none).success)
    assert.deepEqual(vehicleTypeAdapter.toCreateBody?.(made({ name: "Side loader", key: "side-loader", containerTypeIds: "container-type-nowhere" }), context(resolveTypes)), { path: "containerTypeIds", message: "Pick container types the API holds" })
    assert.deepEqual(vehicleTypeAdapter.toCreateBody?.(made({ name: "Side loader", key: "Side Loader" }), context(resolveTypes)), { path: "key", message: "A key is a lowercase slug of letters, digits and single hyphens, such as hard-plastic" })
  })

  test("an edit is a patch of the name and description, the whole set of container types, or both; the key is set once", () => {
    const record = vehicleTypeAdapter.toRecord(rearLoader, context(resolveTypes))
    const both: BusinessRecord = { ...record, name: "Rear loader (2 axles)", submittedValues: { ...record.submittedValues, name: "Rear loader (2 axles)", containerTypeIds: `container-type-${bin240.id},container-type-${unmeasured.id}` } }
    const body = vehicleTypeAdapter.toPatchBody(record, both, context(resolveTypes)) as { type?: unknown; containerTypeIds?: string[] }
    assert.deepEqual(body, { type: { name: "Rear loader (2 axles)" }, containerTypeIds: [bin240.id, unmeasured.id] })
    assert.ok(VehicleTypePatch.safeParse(body.type).success)
    assert.ok(VehicleTypeContainerTypesSet.safeParse({ containerTypeIds: body.containerTypeIds }).success)
    const emptied: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, containerTypeIds: "" } }
    assert.deepEqual(vehicleTypeAdapter.toPatchBody(record, emptied, context(resolveTypes)), { containerTypeIds: [] })
    const crane = vehicleTypeAdapter.toRecord({ ...glassCrane, containerTypeIds: [igloo.id, unmeasured.id] }, context(resolveTypes))
    const reordered: BusinessRecord = { ...crane, submittedValues: { ...crane.submittedValues, containerTypeIds: `container-type-${unmeasured.id},container-type-${igloo.id}` } }
    assert.equal(vehicleTypeAdapter.toPatchBody(crane, reordered, context(resolveTypes)), null, "the same set in the order it was ticked is no change")
    const described: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, description: "Standard rear loader" } }
    assert.deepEqual(vehicleTypeAdapter.toPatchBody(record, described, context(resolveTypes)), { type: { description: "Standard rear loader" } })
    const rekeyed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, key: "rear" } }
    assert.deepEqual(vehicleTypeAdapter.toPatchBody(record, rekeyed, context(resolveTypes)), { path: "key", message: "The key is set once: a vehicle type that needs another key is another vehicle type" })
    assert.equal(vehicleTypeAdapter.toPatchBody(record, record, context(resolveTypes)), null)
  })

  test("the update patches the type, then puts the whole set through its own route, and answers the type as it now stands", async () => {
    const renamed = { ...rearLoader, name: "Rear loader (2 axles)" }
    const reset = { ...renamed, containerTypeIds: [bin240.id, unmeasured.id] }
    const { fetch, calls } = scripted([() => json(renamed), () => json(reset)])
    const answer = await vehicleTypeAdapter.update(clientOver(fetch), rearLoader.id, { type: { name: "Rear loader (2 axles)" }, containerTypeIds: [bin240.id, unmeasured.id] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/vehicle-types/${rearLoader.id}`, `PUT http://api.test/vehicle-types/${rearLoader.id}/container-types`])
    assert.deepEqual(bodyOf(calls[1]), { containerTypeIds: [bin240.id, unmeasured.id] })
    assert.deepEqual(answer.containerTypeIds, [bin240.id, unmeasured.id])
    const setOnly = scripted([() => json(reset)])
    await vehicleTypeAdapter.update(clientOver(setOnly.fetch), rearLoader.id, { containerTypeIds: [bin240.id, unmeasured.id] })
    assert.deepEqual(setOnly.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/vehicle-types/${rearLoader.id}/container-types`])
  })

  // M10 of #293: what a vehicle of the type burns, per fuel.
  test("reads its consumption per fuel into the form's fields per 100 km, and says it in its facts", () => {
    const burning = vehicleTypeAdapter.toRecord({ ...rearLoader, consumption: [{ fuel: "diesel", unit: "litre", milliUnitsPerKm: 455 }, { fuel: "electric", unit: "kwh", milliUnitsPerKm: 1300 }] }, context(resolveTypes))
    assert.equal(burning.submittedValues?.["consumption-diesel"], "45.5")
    assert.equal(burning.submittedValues?.["consumption-electric"], "130")
    assert.equal(burning.facts.Consumption, "Diesel 45.5 l · Electric 130 kWh per 100 km")
    assert.equal(vehicleTypeAdapter.toRecord(rearLoader, context(resolveTypes)).facts.Consumption, "No consumption: its routes are unmeasured")
  })

  test("a create stays one request: the consumption is the edit's, once the type exists", () => {
    const body = vehicleTypeAdapter.toCreateBody?.(made({ name: "Side loader", key: "side-loader", "consumption-diesel": "42,5" }), context(resolveTypes)) as Record<string, unknown>
    assert.equal("consumption" in body, false)
    assert.ok(VehicleTypeCreate.safeParse(body).success)
  })

  test("a consumption the wire would refuse is refused at its field, before any request", () => {
    const burning = vehicleTypeAdapter.toRecord(rearLoader, context(resolveTypes))
    for (const typed of ["0", "-3", "45.55", "lots", "1000.1"]) {
      const edited: BusinessRecord = { ...burning, submittedValues: { ...burning.submittedValues, "consumption-diesel": typed } }
      assert.deepEqual(vehicleTypeAdapter.toPatchBody(burning, edited, context(resolveTypes)), { path: "consumption-diesel", message: CONSUMPTION_REFUSAL }, typed)
    }
  })

  test("an edit puts the whole consumption set where it moved, and nothing where it did not", async () => {
    const burning = vehicleTypeAdapter.toRecord({ ...rearLoader, consumption: [{ fuel: "diesel", unit: "litre", milliUnitsPerKm: 450 }] }, context(resolveTypes))
    const moved: BusinessRecord = { ...burning, submittedValues: { ...burning.submittedValues, "consumption-diesel": "", "consumption-electric": "130" } }
    const movedBody = vehicleTypeAdapter.toPatchBody(burning, moved, context(resolveTypes)) as { consumption?: unknown }
    assert.deepEqual(movedBody, { consumption: [{ fuel: "electric", milliUnitsPerKm: 1300 }] })
    assert.ok(VehicleTypeConsumptionSet.safeParse({ consumption: movedBody.consumption }).success)
    const retyped: BusinessRecord = { ...burning, submittedValues: { ...burning.submittedValues, "consumption-diesel": "45.0" } }
    assert.equal(vehicleTypeAdapter.toPatchBody(burning, retyped, context(resolveTypes)), null, "45.0 is the 45 it was")
    const cleared: BusinessRecord = { ...burning, submittedValues: { ...burning.submittedValues, "consumption-diesel": "" } }
    assert.deepEqual(vehicleTypeAdapter.toPatchBody(burning, cleared, context(resolveTypes)), { consumption: [] })
    const { fetch, calls } = scripted([() => json({ ...rearLoader, consumption: [] })])
    await vehicleTypeAdapter.update(clientOver(fetch), rearLoader.id, { consumption: [] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/vehicle-types/${rearLoader.id}/consumption`])
    assert.deepEqual(bodyOf(calls[0]), { consumption: [] })
  })
})
