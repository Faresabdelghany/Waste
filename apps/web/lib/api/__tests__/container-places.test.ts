// Where a server container stands (#184, slice 9b of #81): a container's
// placement names its subscription, the subscription its property or shared
// collection point, and the place its point. A container whose placement is
// in force on its project's day carries that place — its point as typed
// coordinates, its name and address as facts — and every planning area whose
// boundary in force contains the point, so the map places it and the
// collection groups' rule preview scopes it as the fixtures' containers are.
// A container serving nowhere today, or at a place not yet located, has no
// place on the map; one serving nowhere today is out of service to the
// preview (#207).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Agreement, Subscription } from "@waste/contracts/agreements"
import type { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import type { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import type { Customer, Property, SharedCollectionPoint } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"
import type { PlanningArea, PlanningAreaBoundary } from "@waste/contracts/planning-areas"
import { FIXTURE_GAZETTEER } from "@waste/domain/fixtures/gazetteer"
import { containerLocation } from "@waste/domain/map-planning/positions"
import { resolveStopMatches, servingReadingOf } from "@waste/domain/route-schemes/matching"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type MappingContext, type ResourceAdapter, type Resource } from "../records/adapter"
import { agreementAdapter, subscriptionAdapter } from "../records/agreements"
import { containerAdapter, type ContainerResource } from "../records/containers"
import { containerTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { projectAdapter } from "../records/organisation"
import { planningAreaAdapter } from "../records/planning"
import { propertyAdapter, sharedPointAdapter } from "../records/properties"
import { customerAdapter } from "../records/registry"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const HARBOR = "01a0d2a4-a280-7002-8000-000000000002"

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const square = (west: number, south: number, east: number, north: number): PlanningAreaBoundary["boundary"] => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
})
// Another project's area first: its outline covers Parkvej too, and a container of Copenhagen Central is no stop of it.
const harborArea: PlanningArea = { id: "01a0d2a4-a280-7016-8000-000000000004", ...STAMPS, projectId: HARBOR, code: "OP-HAR-01", name: "Nordhavn Harbor Area", purpose: "route-planning" }
const osterbroArea: PlanningArea = { ...harborArea, id: "01a0d2a4-a280-7016-8000-000000000002", projectId: copenhagen.id, code: "OP-OST-02", name: "Østerbro Zone 2" }
const boundaryOf = (area: PlanningArea, id: string, boundary = square(12.56, 55.69, 12.58, 55.71)): PlanningAreaBoundary => ({ id, ...STAMPS, projectId: area.projectId, planningAreaId: area.id, boundary, validFrom: "2026-01-01", validTo: null })
// A second area of Copenhagen Central over Parkvej alone, inside Østerbro Zone 2: areas of one project overlap.
const parkvejBlock: PlanningArea = { ...osterbroArea, id: "01a0d2a4-a280-7016-8000-000000000003", code: "OP-OST-03", name: "Parkvej Block" }

const residual: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, key: "residual", name: "Residual", wasteCode: null, treatment: null, densityKgPerCubicMetre: null, hazardous: false }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240, serviceSeconds: null }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const parkvej: Property = { id: "01a0d2a4-a280-700c-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", addressId: null, addressParts: null, registryId: null, kind: "residential", location: { type: "Point", coordinates: [12.5709, 55.7012] }, notes: null, driverInstructions: null, serviceWindow: null, status: "active", parties: [] }
const dock4: Property = { ...parkvej, id: "01a0d2a4-a280-700c-8000-000000000002", name: "Dock 4 · Harbor Offices", address: "Dock 4, Nordhavn", location: null }
const kongens: SharedCollectionPoint = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Kongens Nytorv Shared Point", kind: "underground", address: "Kongens Nytorv, 1050 København K", location: { type: "Point", coordinates: [12.5855, 55.6805] }, eligibilityDistanceM: 350, operatingModel: "municipal", accessMode: "open", accessConditions: null, availability: "24/7", driverInstructions: null, billingMode: "municipal", responsibleCustomerId: null, status: "open", members: [] }
const agr2408: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: osterbro.id, payerCustomerId: osterbro.id, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, serviceWindow: null, validFrom: "2026-01-01", validTo: null }
const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"
const subscriptionAt = (id: string, place: { propertyId: string } | { sharedCollectionPointId: string }): Subscription => ({ id, ...STAMPS, projectId: copenhagen.id, agreementId: agr2408.id, productId: PRODUCT, propertyId: null, sharedCollectionPointId: null, ...place, quantity: 1, validFrom: "2026-01-01", validTo: null })
const atParkvej = subscriptionAt("01a0d2a4-a280-7013-8000-000000000001", { propertyId: parkvej.id })
const atKongens = subscriptionAt("01a0d2a4-a280-7013-8000-000000000002", { sharedCollectionPointId: kongens.id })
const atDock = subscriptionAt("01a0d2a4-a280-7013-8000-000000000003", { propertyId: dock4.id })
// A subscription that ended while its container's placement stays open (the API lets an open placement outlive it until the container is returned), and one under an agreement that ended.
const endedSubscription: Subscription = { ...atParkvej, id: "01a0d2a4-a280-7013-8000-000000000004", validFrom: "2025-01-01", validTo: "2026-01-01" }
const agrEnded: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000002", number: "AGR-2188", validFrom: "2025-01-01", validTo: "2026-01-01" }
const underEnded: Subscription = { ...atParkvej, id: "01a0d2a4-a280-7013-8000-000000000005", agreementId: agrEnded.id, validFrom: "2025-01-01", validTo: null }

// The store as it stands when the containers load: every module a placement's place is read through, loaded before them in SERVER_MODULES' order.
const bare: MappingContext = { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
let state: ServerRecordsState = new Map()
function load<R extends Resource>(key: string, adapter: ResourceAdapter<R>, resources: readonly R[], fixtures: readonly BusinessRecord[] = []) {
  const context: MappingContext = { ...bare, fixtures, resolve: resolverOver(state) }
  const records = resources.map((resource) => adapter.toRecord(resource, context))
  state = new Map([...state, [key, loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, resources[index].id])) }, 1)]])
}
load("configure.organization", projectAdapter, [copenhagen], getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [])
load("configure.areas", planningAreaAdapter, [
  { ...harborArea, boundaries: [boundaryOf(harborArea, "01a0d2a4-a280-7017-8000-000000000004")] },
  { ...osterbroArea, boundaries: [boundaryOf(osterbroArea, "01a0d2a4-a280-7017-8000-000000000002")] },
  { ...parkvejBlock, boundaries: [boundaryOf(parkvejBlock, "01a0d2a4-a280-7017-8000-000000000003", square(12.565, 55.698, 12.575, 55.705))] },
])
const masterRecords = [wasteFractionAdapter.toRecord(residual, bare), containerTypeAdapter.toRecord(bin240, bare)]
state = new Map([...state, ["configure.master", loaded({ records: masterRecords, serverIds: new Map([[masterRecords[0].id, residual.id], [masterRecords[1].id, bin240.id]]) }, 1)]])
load("customers.contacts", customerAdapter, [osterbro])
load("customers.properties", propertyAdapter, [parkvej, dock4])
load("customers.shared", sharedPointAdapter, [kongens])
load("customers.agreements", agreementAdapter, [agr2408, agrEnded])
state = new Map([
  ...state,
  [
    "customers.agreements",
    (() => {
      const agreements = state.get("customers.agreements")
      if (agreements === undefined) throw new Error("no agreements")
      const context: MappingContext = { ...bare, resolve: resolverOver(state) }
      const subscriptions = [atParkvej, atKongens, atDock, endedSubscription, underEnded]
      const records = subscriptions.map((subscription) => subscriptionAdapter.toRecord(subscription, context))
      return loaded({ records: [...agreements.records, ...records], serverIds: new Map([...agreements.serverIds, ...records.map((record, index): [string, string] => [record.id, subscriptions[index].id])]) }, 1)
    })(),
  ],
])
const context: MappingContext = { ...bare, resolve: resolverOver(state) }

const containerOf = (id: string, label: string): Container => ({ id, ...STAMPS, projectId: copenhagen.id, label, containerTypeId: bin240.id, barcode: null, rfid: null, serialNumber: null, ownership: "company", notes: null, assetState: null })
const placementOf = (id: string, container: Container, subscription: Subscription, validFrom: string, validTo: string | null): ContainerServicePlacement => ({ id, ...STAMPS, projectId: copenhagen.id, containerId: container.id, subscriptionId: subscription.id, wasteFractionId: residual.id, serviceFrequencyId: null, effectiveServiceFrequencyId: null, validFrom, validTo })
function placed(label: string, index: number, subscription: Subscription, validFrom: string, validTo: string | null = null): BusinessRecord {
  const ordinal = String(index).padStart(12, "0")
  const container = containerOf(`01a0d2a4-a280-7014-8000-${ordinal}`, label)
  const resource: ContainerResource = { ...container, placements: [placementOf(`01a0d2a4-a280-7015-8000-${ordinal}`, container, subscription, validFrom, validTo)] }
  return containerAdapter.toRecord(resource, context)
}

const areaId = `area-${osterbroArea.id}`
// The day the records are read on: NOW on Copenhagen's clock.
const ASOF = "2026-09-30"
/** A record's serving, for each placement not ended by today: its period and the areas its place lies in. */
const readingOf = (record: BusinessRecord) => servingReadingOf(record)
const PARKVEJ = "Parkvej 18, 2100 København Ø"
const KONGENS = "Kongens Nytorv Shared Point, Kongens Nytorv, 1050 København K"
const AREA_NAMES: Record<string, string> = { [`area-${"01a0d2a4-a280-7016-8000-000000000002"}`]: "Østerbro Zone 2", [`area-${"01a0d2a4-a280-7016-8000-000000000003"}`]: "Parkvej Block" }
/** The serving the record carries: each period's areas by id and by name, its fraction, its place, and the one the record shows marked. */
const serving = (...periods: { from: string; until: string | null; areaIds: string[]; place: string; shown?: true }[]) => ({
  asOf: ASOF,
  periods: periods.map((period) => ({ ...period, areaNames: period.areaIds.map((id) => AREA_NAMES[id]), fractions: ["Residual"] })),
})
const blockId = `area-${parkvejBlock.id}`

describe("a container placed today", () => {
  test("at a located property carries the property's point, its name and address, and every planning area whose boundary in force contains it", () => {
    const record = placed("BIN-91001", 1, atParkvej, "2026-01-01")
    assert.equal(record.facts.Property, "Parkvej 18")
    assert.equal(record.facts.Address, "Parkvej 18, 2100 København Ø")
    assert.deepEqual(readingOf(record), serving({ from: "2026-01-01", until: null, areaIds: [areaId, blockId], place: PARKVEJ, shown: true }), "placement, subscription and agreement all from 2026-01-01, open; the areas of its own project, not another project's that covers the same street")
    assert.equal(record.facts["Planning area"], "Østerbro Zone 2 · Parkvej Block", "every area, joined, which the map's readers split (#232)")
    assert.equal(record.submittedValues?.planningAreaId, areaId)
    assert.equal(record.submittedValues?.latitude, "55.7012")
    assert.equal(record.submittedValues?.longitude, "12.5709")
    assert.deepEqual(containerLocation(record, FIXTURE_GAZETTEER), { lng: 12.5709, lat: 55.7012 }, "the map places it at the property's point")
  })

  test("is a stop the rule preview matches in each area that contains it, by its fraction's and its type's names, whatever its asset state (#207)", () => {
    const record = placed("BIN-91008", 8, atParkvej, "2026-01-01")
    assert.equal(record.status, "No stock record", "no movement yet, as every seeded container")
    for (const area of [areaId, blockId]) {
      const preview = resolveStopMatches({ rule: { fractions: ["Residual"], containerTypes: ["Two-wheel bin · 240 L"], vehicleType: "Rear loader" }, areaId: area, projectIds: [FIXTURE_PROJECT_IDS.copenhagen], containers: [record] })
      assert.deepEqual([preview.scopeTotal, preview.matched.map((profile) => profile.name), preview.excluded], [1, ["BIN-91008"], []], area)
    }
  })

  test("carries what the map's statistics and filters read of a place: the property's type and the agreement it serves under", () => {
    const record = placed("BIN-91006", 6, atParkvej, "2026-01-01")
    assert.equal(record.facts["Property type"], "Residential")
    assert.equal(record.facts.Agreement, "AGR-2408 · active", "the Selected area's active agreements read it")
    const atPoint = placed("BIN-91007", 7, atKongens, "2026-06-01")
    assert.equal(atPoint.facts["Property type"], undefined, "a point has no property type")
    assert.equal(atPoint.facts.Agreement, "AGR-2408 · active")
  })

  test("at a shared collection point carries the point's place, and no area where no boundary contains it", () => {
    const record = placed("BIN-91002", 2, atKongens, "2026-06-01")
    assert.equal(record.facts["Shared collection point"], "Kongens Nytorv Shared Point")
    assert.equal(record.facts.Property, undefined, "a point is not a property")
    assert.equal(record.facts.Address, "Kongens Nytorv, 1050 København K")
    assert.equal(record.facts["Planning area"], undefined)
    assert.equal(record.submittedValues?.planningAreaId, undefined)
    assert.deepEqual(readingOf(record), serving({ from: "2026-06-01", until: null, areaIds: [], place: KONGENS, shown: true }))
    assert.deepEqual(containerLocation(record, FIXTURE_GAZETTEER), { lng: 12.5855, lat: 55.6805 })
  })

  test("at a property not yet located says where it serves and has no place on the map", () => {
    const record = placed("BIN-91003", 3, atDock, "2026-01-01")
    assert.equal(record.facts["Serves at"], "Dock 4 · Harbor Offices, not located yet")
    assert.equal(record.facts.Property, undefined)
    assert.equal(record.facts.Address, undefined)
    assert.equal(record.submittedValues?.latitude, undefined)
    assert.deepEqual(readingOf(record), serving({ from: "2026-01-01", until: null, areaIds: [], place: "Dock 4 · Harbor Offices, Dock 4, Nordhavn", shown: true }), "it serves today, at a place no area can contain yet")
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
  })

  test("with no movement yet and a next placement scheduled, shows the placement serving today, as the worker matches it (#207)", () => {
    const container = containerOf("01a0d2a4-a280-7014-8000-000000000014", "BIN-91014")
    const today = placementOf("01a0d2a4-a280-7015-8000-000000000014", container, atParkvej, "2026-01-01", "2026-11-01")
    const next = placementOf("01a0d2a4-a280-7015-8000-000000000015", container, atKongens, "2026-11-01", null)
    const record = containerAdapter.toRecord({ ...container, placements: [today, next] }, context)
    assert.equal(record.facts.Placement, "From 2026-01-01 to 2026-10-31")
    assert.equal(record.facts.Property, "Parkvej 18")
    assert.deepEqual(readingOf(record), serving({ from: "2026-01-01", until: "2026-11-01", areaIds: [areaId, blockId], place: PARKVEJ, shown: true }, { from: "2026-11-01", until: null, areaIds: [], place: KONGENS }), "each placement's own period and areas: a scheme from November is judged on the next")
  })
})

describe("a container serving nowhere today", () => {
  test("whose placement ended has no place, and serves in no period", () => {
    const record = placed("BIN-91004", 4, atParkvej, "2026-01-01", "2026-09-01")
    assert.deepEqual([record.facts.Property, record.facts.Address, record.facts["Serves at"]], [undefined, undefined, undefined])
    assert.deepEqual(readingOf(record), serving())
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
  })

  test("whose placement has not begun is not on today's map, but is in its areas' scope with its period: a scheme from its first day matches it (#232)", () => {
    const record = placed("BIN-91005", 5, atParkvej, "2026-10-01")
    assert.deepEqual([record.facts.Property, record.facts["Planning area"], record.submittedValues?.planningAreaId], [undefined, undefined, undefined], "the map's readings are today's")
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
    assert.deepEqual(readingOf(record), serving({ from: "2026-10-01", until: null, areaIds: [areaId, blockId], place: PARKVEJ, shown: true }))
    assert.equal(record.facts["Serves at"], "Parkvej 18, 2100 København Ø — from 2026-10-01", "where and from when, for the preview's matched rows: a property by its address")
    const preview = (from?: string) => resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId, ...(from === undefined ? {} : { from }), containers: [record] })
    assert.deepEqual(preview("2026-10-01").matched.map((profile) => profile.name), ["BIN-91005"], "a scheme from the 1st")
    assert.deepEqual(preview().excluded.map((exclusion) => exclusion.reason), ["Serves from 2026-10-01 — not in service"], "judged today")
  })

  test("nor one with no placement at all", () => {
    const record = containerAdapter.toRecord({ ...containerOf("01a0d2a4-a280-7014-8000-000000000009", "BIN-91009"), placements: [] }, context)
    assert.deepEqual(readingOf(record), serving())
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
  })

  test("nor one whose open placement outlived its subscription, or whose subscription's agreement has ended: the period three times over, as the worker reads eligibility", () => {
    // The subscription ended the day its agreement began: the three periods share no day. The other agreement ended with 2025.
    for (const record of [placed("BIN-91010", 10, endedSubscription, "2025-06-01"), placed("BIN-91011", 11, underEnded, "2025-06-01")]) {
      assert.equal(record.facts.Property, undefined, record.name)
      assert.deepEqual(readingOf(record), serving(), record.name)
      assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null, record.name)
    }
  })

  test("nor one the ledger has in service at another placement than the one in force today: its record shows that one, so its place is not today's", () => {
    // Returned with a last day ahead, and issued under the point from the day after: the ledger serves the point's placement, which is not in force yet.
    const container = containerOf("01a0d2a4-a280-7014-8000-000000000012", "BIN-91012")
    const today = placementOf("01a0d2a4-a280-7015-8000-000000000012", container, atParkvej, "2026-01-01", "2026-10-05")
    const next = placementOf("01a0d2a4-a280-7015-8000-000000000013", container, atKongens, "2026-10-05", null)
    const assetState = { status: "in-service" as const, warehouseId: null, placementId: next.id, since: "2026-09-29T08:00:00.000Z", movementId: "01a0d2a4-a280-7030-8000-000000000001" }
    const record = containerAdapter.toRecord({ ...container, assetState, placements: [today, next] }, context)
    assert.equal(record.facts.Placement, "From 2026-10-05, open", "the record shows the placement the ledger serves")
    assert.equal(record.facts.Property, undefined)
    assert.equal(record.facts["Shared collection point"], undefined)
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
    assert.deepEqual(readingOf(record), serving({ from: "2026-01-01", until: "2026-10-05", areaIds: [areaId, blockId], place: PARKVEJ }, { from: "2026-10-05", until: null, areaIds: [], place: KONGENS, shown: true }))
    assert.equal(record.facts["Serves at"], `${KONGENS} — from 2026-10-05`, "a point by its name and its address")
  })
})
