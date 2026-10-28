// The provider-money chain's Pilot forms held to their adapters (#186): every
// field a form offers is a key its adapter reads, so a form filled in becomes
// the body the contract accepts, and a renamed field cannot quietly send
// nothing. The bodies are parsed by the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Product, WasteFraction } from "@waste/contracts/catalogue"
import type { Project } from "@waste/contracts/organisation"
import { ServiceAreaAssignmentCreate, ServiceAreaAssignmentPatch, ServiceAreaCreate } from "@waste/contracts/service-areas"
import { ServiceProviderPriceCreate, ServiceProviderPriceIndex } from "@waste/contracts/service-provider-prices"
import { SettlementCreate, SettlementReopen } from "@waste/contracts/settlements"
import { UnloadCreate } from "@waste/contracts/unloads"
import { WeightApprove, WeightCorrect, WeightReject } from "@waste/contracts/weight-control"

import { isLocalRefusal, NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { wasteFractionAdapter } from "../../api/records/master-data"
import { projectAdapter } from "../../api/records/organisation"
import { productAdapter } from "../../api/records/pricing"
import { providerPriceAdapter, settlementAdapter } from "../../api/records/provider-money"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { assignmentAdapter, serviceAreaAdapter } from "../../api/records/service-areas"
import { unloadAdapter } from "../../api/records/weights"
import type { BusinessFormSchema, BusinessFormValues } from "../business-form-types"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../business-modules"
import { NO_ONE } from "../properties"
import {
  ASSIGNMENT_FORM,
  assignmentEndForm,
  createAssignmentRecord,
  createIndexedPriceRecord,
  createProviderPriceRecord,
  createServiceAreaRecord,
  createSettlementRecord,
  INDEX_FORM,
  NO_PLANNING_AREA_SELECTED,
  pilotProviderCreate,
  pilotServiceAreaCreate,
  PROVIDER_PRICE_FORM,
  providerPriceEditForm,
  REOPEN_FORM,
  SERVICE_AREA_FORM,
  serviceAreaEditForm,
  SETTLEMENT_FORM,
  updateServiceAreaRecord,
  UNLOAD_FORM,
  createUnloadRecord,
  WEIGHT_REVIEW_FORMS,
} from "../provider-money-forms"
import { SERVICE_AREA_SEED_FIELDS } from "../service-areas"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const organic: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000002", ...STAMPS, key: "organic", name: "Organic", wasteCode: null, treatment: null, densityKgPerCubicMetre: null }
const residual: Product = { id: "01a0d2a4-a280-700a-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Residual waste · 240L bin", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: null, wasteFractionId: null, serviceFrequencyId: null, invoiceName: null, invoiceCode: null, vatPercent: 25, freeDays: null }
const OSTERBRO = "01a0d2a4-a280-7015-8000-000000000002"
const NORDREN = "01a0d2a4-a280-7004-8000-000000000001"
const AREA = "01a0d2a4-a280-7090-8000-000000000001"
const ASSIGNMENT = "01a0d2a4-a280-7091-8000-000000000001"
const PRICE = "01a0d2a4-a280-7092-8000-000000000001"
const SETTLEMENT = "01a0d2a4-a280-7093-8000-000000000001"

const bare: MappingContext = { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const projectRecord = projectAdapter.toRecord(copenhagen, bare)
const fractionRecord = wasteFractionAdapter.toRecord(organic, bare)
const productRecord = productAdapter.toRecord(residual, bare)
const plain = (id: string, name: string, recordKind: string, submittedValues: BusinessFormValues = {}): BusinessRecord => ({ ...projectRecord, id, name, recordKind, projectIds: [projectRecord.id], submittedValues })
const planningArea = plain(`area-${OSTERBRO}`, "Østerbro Zone 2", "Planning area")
const provider = plain(`service-provider-${NORDREN}`, "NordRen ApS", "Service provider")
const areaRecord = plain(`service-area-${AREA}`, "Østerbro organic", "Service area", { projectId: projectRecord.id, areaCode: "CA-Ø-2", areaName: "Østerbro organic", boundary: "North of Jagtvej", zoneIds: planningArea.id, wasteFractionIds: fractionRecord.id, validFrom: "2026-01-01" })
const assignmentRecord = plain(`assignment-${ASSIGNMENT}`, "CA-Ø-2 · NordRen ApS", "Service area assignment", { serviceAreaId: areaRecord.id, serviceProviderId: provider.id, validFrom: "2026-01-01" })
const priceRecord = plain(`provider-price-${PRICE}`, "Residual waste · 240L bin · NordRen ApS", "Service provider price", { serviceAreaAssignmentId: assignmentRecord.id, productId: productRecord.id, bid: "11.20", fee: "11.20", validFrom: "2026-01-01" })
const settlementRecord = plain(`settlement-${SETTLEMENT}`, "NordRen ApS · 2026-09-01 – 2026-09-30", "Settlement", { serviceAreaAssignmentId: assignmentRecord.id, status: "closed", validFrom: "2026-09-01", validTo: "2026-09-30" })
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([projectRecord], [copenhagen.id])],
  ["configure.master", moduleOf([fractionRecord], [organic.id])],
  ["configure.areas", moduleOf([planningArea], [OSTERBRO])],
  ["service-providers.service-providers", moduleOf([provider], [NORDREN])],
  ["commercial.products", moduleOf([productRecord], [residual.id])],
  ["service-providers.service-areas", moduleOf([areaRecord, assignmentRecord], [AREA, ASSIGNMENT])],
  ["commercial.service-provider-prices", moduleOf([priceRecord], [PRICE])],
  ["commercial.settlements", moduleOf([settlementRecord], [SETTLEMENT])],
])
const context: MappingContext = { ...bare, resolve: resolverOver(state) }

/** Every field id a form offers. */
const fieldsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))
/** The fields a form leaves open to change. */
const editableOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.filter((field) => !field.readOnly).map((field) => field.id)).sort()

/** Asserts a form offers exactly these fields: what the adapter reads, nothing it does not. */
const offersExactly = (schema: BusinessFormSchema, ids: readonly string[]) => assert.deepEqual([...fieldsOf(schema)].sort(), [...ids].sort(), schema.title)

const body = (made: unknown) => {
  if (isLocalRefusal(made)) throw new Error(`refused at ${made.path}: ${made.message}`)
  return made as { [key: string]: unknown }
}

describe("the provider-money chain's Pilot forms", () => {
  test("Create service area filled in is the award the contract accepts, its first assignment beside it; the map's seed lands in its fields", () => {
    const values: BusinessFormValues = { areaName: "Østerbro organic 2027", areaCode: "CA-Ø-3", projectId: projectRecord.id, serviceProviderId: provider.id, boundary: "North of Jagtvej", zoneIds: planningArea.id, wasteFractionIds: fractionRecord.id, notes: "", validFrom: "2027-01-01", validTo: "2027-12-31" }
    offersExactly(SERVICE_AREA_FORM, Object.keys(values))
    // The drawn polygon rides beside the fields as an extra value, which the Pilot drops.
    for (const seeded of [SERVICE_AREA_SEED_FIELDS.projectId, SERVICE_AREA_SEED_FIELDS.planningAreaIds, SERVICE_AREA_SEED_FIELDS.boundary]) assert.ok(fieldsOf(SERVICE_AREA_FORM).includes(seeded), `the map's seed lands in ${seeded}`)
    const made = body(serviceAreaAdapter.toCreateBody!(createServiceAreaRecord(values, 1), context))
    assert.ok(ServiceAreaCreate.safeParse(made).success)
    assert.deepEqual(made.planningAreaIds, [OSTERBRO])
    assert.deepEqual(made.assignment, { serviceProviderId: NORDREN })
    assert.equal(made.validTo, "2028-01-01", "the form's last day in, the wire's first day out")
    const unawarded = body(serviceAreaAdapter.toCreateBody!(createServiceAreaRecord({ ...values, serviceProviderId: NO_ONE }, 1), context))
    assert.equal(unawarded.assignment, undefined, "None awards it later")
  })

  test("the map's door opens the Pilot's form on the selection's planning areas, its polygon dropped, and refuses a selection of none", () => {
    const seed = { projectId: projectRecord.id, planningAreaIds: [planningArea.id], boundary: "Drawn on the map: 12 containers", polygon: [{ lng: 12.5, lat: 55.6 }, { lng: 12.6, lat: 55.6 }, { lng: 12.6, lat: 55.7 }] }
    const opened = pilotServiceAreaCreate(seed)
    if ("refused" in opened) throw new Error(opened.refused)
    assert.equal(opened.schemaOverride, SERVICE_AREA_FORM)
    assert.deepEqual(opened.initialValues, { projectId: projectRecord.id, zoneIds: planningArea.id, boundary: seed.boundary })
    assert.ok(!("extraValues" in opened), "the drawn polygon is never persisted (#127)")
    assert.deepEqual(pilotServiceAreaCreate({ ...seed, planningAreaIds: [] }), { refused: NO_PLANNING_AREA_SELECTED })
  })

  test("the provider page's doors open the Pilot's award and price forms, the provider named on the award", () => {
    assert.deepEqual(pilotProviderCreate("service-area", provider.id, "2026-10-24", []), { workspaceId: "service-providers", moduleId: "service-areas", initialValues: { serviceProviderId: provider.id, validFrom: "2026-10-24" }, schemaOverride: SERVICE_AREA_FORM })
    const records = [areaRecord, assignmentRecord, plain("assignment-other", "CA-H-1 · CityHaul A/S", "Service area assignment", { serviceProviderId: "service-provider-other" })]
    const price = pilotProviderCreate("service-provider-price", provider.id, "2026-10-24", records)
    assert.deepEqual([price.workspaceId, price.moduleId], ["commercial", "service-provider-prices"])
    assert.deepEqual(price.initialValues, { validFrom: "2026-10-24", serviceAreaAssignmentId: assignmentRecord.id }, "its one assignment picked")
    const field = price.schemaOverride.sections.flatMap((section) => section.fields).find((candidate) => candidate.id === "serviceAreaAssignmentId")
    assert.deepEqual(field?.relation?.allowedRecordIds, [assignmentRecord.id], "this provider's assignments alone")
    assert.deepEqual(pilotProviderCreate("service-provider-price", "service-provider-none", "2026-10-24", records).initialValues, { validFrom: "2026-10-24" })
  })

  test("an award's edit holds its code and project, offers no provider, and moves its sets through their own routes", () => {
    const edit = serviceAreaEditForm(areaRecord)
    assert.deepEqual(editableOf(edit), ["areaName", "boundary", "notes", "validFrom", "validTo", "wasteFractionIds", "zoneIds"])
    assert.ok(!fieldsOf(edit).includes("serviceProviderId"), "who holds it is its assignments'")
    const write = body(serviceAreaAdapter.toPatchBody(areaRecord, updateServiceAreaRecord(areaRecord, { areaName: "Østerbro organic and paper", wasteFractionIds: "" }), context))
    assert.deepEqual(write, { patch: { name: "Østerbro organic and paper" }, wasteFractionIds: { ids: [] } })
  })

  test("an assignment filled in is the create the contract accepts under its award, and its end form moves its notes and last day alone", () => {
    const values: BusinessFormValues = { serviceAreaId: areaRecord.id, serviceProviderId: provider.id, notes: "Transfer", validFrom: "2027-01-01", validTo: "" }
    offersExactly(ASSIGNMENT_FORM, Object.keys(values))
    const write = body(assignmentAdapter.toCreateBody!(createAssignmentRecord(values, 1), context))
    assert.equal(write.serviceAreaId, AREA)
    assert.ok(ServiceAreaAssignmentCreate.safeParse(write.body).success)
    assert.deepEqual(editableOf(assignmentEndForm(assignmentRecord)), ["notes", "validTo"])
    const patch = assignmentAdapter.toPatchBody(assignmentRecord, { ...assignmentRecord, submittedValues: { ...assignmentRecord.submittedValues, validTo: "2026-12-31" } }, context)
    assert.ok(ServiceAreaAssignmentPatch.safeParse(patch).success)
  })

  test("Add price filled in is the chain's first row the contract accepts, and a price's edit offers its notes and end alone", () => {
    const values: BusinessFormValues = { serviceAreaAssignmentId: assignmentRecord.id, productId: productRecord.id, bid: "11.20", fee: "", notes: "Tender", validFrom: "2026-01-01", validTo: "" }
    offersExactly(PROVIDER_PRICE_FORM, Object.keys(values))
    const made = body(providerPriceAdapter.toCreateBody!(createProviderPriceRecord(values, 1), context))
    assert.ok(ServiceProviderPriceCreate.safeParse(made).success)
    assert.equal(made.bidMinor, 1120)
    assert.equal(made.unitPriceMinor, undefined, "the fee is the bid when blank")
    assert.deepEqual(editableOf(providerPriceEditForm(priceRecord)), ["notes", "validTo"])
  })

  test("Apply index filled in is the index the contract accepts, posted under the price it indexes", () => {
    const values: BusinessFormValues = { label: "CPI", percent: "5", base: "bid", appliedFrom: "2026-03-01" }
    offersExactly(INDEX_FORM, Object.keys(values))
    const indexed = createIndexedPriceRecord(priceRecord, values, 1)
    assert.deepEqual(indexed.projectIds, priceRecord.projectIds)
    const write = body(providerPriceAdapter.toCreateBody!(indexed, context))
    assert.equal(write.indexes, PRICE)
    assert.ok(ServiceProviderPriceIndex.safeParse(write.body).success)
    for (const option of INDEX_FORM.sections[0].fields.find((field) => field.id === "base")?.options ?? []) {
      assert.ok(ServiceProviderPriceIndex.safeParse(body(providerPriceAdapter.toCreateBody!(createIndexedPriceRecord(priceRecord, { ...values, base: option.value }, 1), context)).body).success, option.value)
    }
  })

  test("Open settlement filled in is the period the contract accepts, and Reopen's reason is the command's body", () => {
    const values: BusinessFormValues = { serviceAreaAssignmentId: assignmentRecord.id, validFrom: "2026-10-01", validTo: "2026-10-31" }
    offersExactly(SETTLEMENT_FORM, Object.keys(values))
    const made = body(settlementAdapter.toCreateBody!(createSettlementRecord(values, 1), context))
    assert.ok(SettlementCreate.safeParse(made).success)
    assert.equal(made.validTo, "2026-11-01")
    offersExactly(REOPEN_FORM, ["reason"])
    assert.ok(SettlementReopen.safeParse(body(settlementAdapter.commands!.reopen.toBody!({ reason: "A late event" }, settlementRecord, context))).success)
  })

  test("Record unload filled in is the capture the contract accepts, posted under its route (O9 of #290)", () => {
    const ROUTE = "01a0d2a4-a280-7030-8000-000000000001"
    const STATION = "01a0d2a4-a280-7020-8000-000000000002"
    const at: ServerRecordsState = new Map([
      ...state,
      ["route-studio.routes", moduleOf([plain(`route-${ROUTE}`, "RC-1042 · 2026-09-29", "Route", { projectId: projectRecord.id, status: "completed" })], [ROUTE])],
      ["resources.depots", moduleOf([plain(`station-${STATION}`, "ARC Amager", "Unloading station")], [STATION])],
    ])
    const values: BusinessFormValues = { routeId: `route-${ROUTE}`, unloadingStationId: `station-${STATION}`, wasteFractionId: fractionRecord.id, occurredAt: "2026-09-29T15:05", netKg: "7200", grossKg: "", tareKg: "", weighbridgeTicket: "WB-2026-3901", note: "", refusalReason: "contamination", refusalNote: "" }
    offersExactly(UNLOAD_FORM, Object.keys(values))
    const made = createUnloadRecord(values, 1)
    assert.equal(made.status, "Needs review")
    const write = body(unloadAdapter.toCreateBody!(made, { ...context, resolve: resolverOver(at) }))
    assert.equal(write.routeId, ROUTE)
    assert.ok(UnloadCreate.safeParse(write.body).success)
    assert.deepEqual((write.body as { refusal?: unknown }).refusal, { reason: "contamination" })
    for (const option of UNLOAD_FORM.sections.flatMap((section) => section.fields).find((field) => field.id === "refusalReason")?.options ?? []) {
      const refused = unloadAdapter.toCreateBody!(createUnloadRecord({ ...values, refusalReason: option.value, refusalNote: "In the station's words" }, 1), { ...context, resolve: resolverOver(at) })
      assert.ok(UnloadCreate.safeParse(body(refused).body).success, option.value)
    }
  })

  test("each weight review's dialog is the body its command's contract accepts", () => {
    const unload = plain("unload-01a0d2a4-a280-7096-8000-000000000001", "WB-2026-3901 · Residual", "Weight record")
    const commands = unloadAdapter.commands!
    offersExactly(WEIGHT_REVIEW_FORMS.approve, ["note"])
    assert.ok(WeightApprove.safeParse(body(commands.approve.toBody!({ note: "" }, unload, context))).success)
    offersExactly(WEIGHT_REVIEW_FORMS.reject, ["note"])
    assert.ok(WeightReject.safeParse(body(commands.reject.toBody!({ note: "Wrong vehicle" }, unload, context))).success)
    const correction = { netKg: "7100", grossKg: "18300", tareKg: "11200", weighbridgeTicket: "WB-2026-3901B", note: "Ticket misread" }
    offersExactly(WEIGHT_REVIEW_FORMS.correct, Object.keys(correction))
    assert.ok(WeightCorrect.safeParse(body(commands.correct.toBody!(correction, unload, context))).success)
  })
})
