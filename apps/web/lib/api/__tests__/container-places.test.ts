// Where a server container stands (#184, slice 9b of #81): a container's
// placement names its subscription, the subscription its property or shared
// collection point, and the place its point. A container whose placement is
// in force on its project's day carries that place — its point as typed
// coordinates, its name and address as facts — and the planning area whose
// boundary in force contains the point, so the map places it and the
// collection groups' rule preview scopes it as the fixtures' containers are.
// A container serving nowhere today, or at a place not yet located, has no
// place on the map.
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
import { resolveStopMatches } from "@waste/domain/route-schemes/matching"

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

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
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
const boundaryOf = (area: PlanningArea, id: string): PlanningAreaBoundary => ({ id, ...STAMPS, projectId: area.projectId, planningAreaId: area.id, boundary: square(12.56, 55.69, 12.58, 55.71), validFrom: "2026-01-01", validTo: null })

const residual: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const parkvej: Property = { id: "01a0d2a4-a280-700c-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", registryId: null, kind: "residential", location: { type: "Point", coordinates: [12.5709, 55.7012] }, notes: null, status: "active", parties: [] }
const dock4: Property = { ...parkvej, id: "01a0d2a4-a280-700c-8000-000000000002", name: "Dock 4 · Harbor Offices", address: "Dock 4, Nordhavn", location: null }
const kongens: SharedCollectionPoint = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Kongens Nytorv Shared Point", kind: "underground", address: "Kongens Nytorv, 1050 København K", location: { type: "Point", coordinates: [12.5855, 55.6805] }, eligibilityDistanceM: 350, operatingModel: "municipal", accessMode: "open", accessConditions: null, availability: "24/7", billingMode: "municipal", responsibleCustomerId: null, status: "open", members: [] }
const agr2408: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: osterbro.id, payerCustomerId: osterbro.id, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, validFrom: "2026-01-01", validTo: null }
const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"
const subscriptionAt = (id: string, place: { propertyId: string } | { sharedCollectionPointId: string }): Subscription => ({ id, ...STAMPS, projectId: copenhagen.id, agreementId: agr2408.id, productId: PRODUCT, propertyId: null, sharedCollectionPointId: null, ...place, quantity: 1, validFrom: "2026-01-01", validTo: null })
const atParkvej = subscriptionAt("01a0d2a4-a280-7013-8000-000000000001", { propertyId: parkvej.id })
const atKongens = subscriptionAt("01a0d2a4-a280-7013-8000-000000000002", { sharedCollectionPointId: kongens.id })
const atDock = subscriptionAt("01a0d2a4-a280-7013-8000-000000000003", { propertyId: dock4.id })

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
])
const masterRecords = [wasteFractionAdapter.toRecord(residual, bare), containerTypeAdapter.toRecord(bin240, bare)]
state = new Map([...state, ["configure.master", loaded({ records: masterRecords, serverIds: new Map([[masterRecords[0].id, residual.id], [masterRecords[1].id, bin240.id]]) }, 1)]])
load("customers.contacts", customerAdapter, [osterbro])
load("customers.properties", propertyAdapter, [parkvej, dock4])
load("customers.shared", sharedPointAdapter, [kongens])
load("customers.agreements", agreementAdapter, [agr2408])
state = new Map([
  ...state,
  [
    "customers.agreements",
    (() => {
      const agreements = state.get("customers.agreements")
      if (agreements === undefined) throw new Error("no agreements")
      const context: MappingContext = { ...bare, resolve: resolverOver(state) }
      const subscriptions = [atParkvej, atKongens, atDock]
      const records = subscriptions.map((subscription) => subscriptionAdapter.toRecord(subscription, context))
      return loaded({ records: [...agreements.records, ...records], serverIds: new Map([...agreements.serverIds, ...records.map((record, index): [string, string] => [record.id, subscriptions[index].id])]) }, 1)
    })(),
  ],
])
const context: MappingContext = { ...bare, resolve: resolverOver(state) }

const containerOf = (id: string, label: string): Container => ({ id, ...STAMPS, projectId: copenhagen.id, label, containerTypeId: bin240.id, barcode: null, rfid: null, serialNumber: null, ownership: "company", notes: null, assetState: null })
const placementOf = (id: string, container: Container, subscription: Subscription, validFrom: string, validTo: string | null): ContainerServicePlacement => ({ id, ...STAMPS, projectId: copenhagen.id, containerId: container.id, subscriptionId: subscription.id, wasteFractionId: residual.id, serviceFrequencyId: null, effectiveServiceFrequencyId: null, validFrom, validTo })
function placed(label: string, index: number, subscription: Subscription, validFrom: string, validTo: string | null = null): BusinessRecord {
  const container = containerOf(`01a0d2a4-a280-7014-8000-00000000000${index}`, label)
  const resource: ContainerResource = { ...container, placements: [placementOf(`01a0d2a4-a280-7015-8000-00000000000${index}`, container, subscription, validFrom, validTo)] }
  return containerAdapter.toRecord(resource, context)
}

const areaId = `area-${osterbroArea.id}`

describe("a container placed today", () => {
  test("at a located property carries the property's point, its name and address, and the planning area whose boundary in force contains it", () => {
    const record = placed("BIN-91001", 1, atParkvej, "2026-01-01")
    assert.equal(record.facts.Property, "Parkvej 18")
    assert.equal(record.facts.Address, "Parkvej 18, 2100 København Ø")
    assert.equal(record.facts["Planning area"], "Østerbro Zone 2", "the area of the container's own project, not another project's that covers the same street")
    assert.equal(record.submittedValues?.latitude, "55.7012")
    assert.equal(record.submittedValues?.longitude, "12.5709")
    assert.equal(record.submittedValues?.planningAreaId, areaId)
    assert.deepEqual(containerLocation(record, FIXTURE_GAZETTEER), { lng: 12.5709, lat: 55.7012 }, "the map places it at the property's point")
    const preview = resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId, projectIds: [FIXTURE_PROJECT_IDS.copenhagen], containers: [record] })
    assert.equal(preview.scopeTotal, 1, "the rule preview counts it in the area's scope")
  })

  test("at a shared collection point carries the point's place, and no area where no boundary contains it", () => {
    const record = placed("BIN-91002", 2, atKongens, "2026-06-01")
    assert.equal(record.facts["Shared collection point"], "Kongens Nytorv Shared Point")
    assert.equal(record.facts.Property, undefined, "a point is not a property")
    assert.equal(record.facts.Address, "Kongens Nytorv, 1050 København K")
    assert.equal(record.facts["Planning area"], undefined)
    assert.equal(record.submittedValues?.planningAreaId, undefined)
    assert.deepEqual(containerLocation(record, FIXTURE_GAZETTEER), { lng: 12.5855, lat: 55.6805 })
  })

  test("at a property not yet located says where it serves and has no place on the map", () => {
    const record = placed("BIN-91003", 3, atDock, "2026-01-01")
    assert.equal(record.facts["Serves at"], "Dock 4 · Harbor Offices, not located yet")
    assert.equal(record.facts.Property, undefined)
    assert.equal(record.facts.Address, undefined)
    assert.equal(record.submittedValues?.latitude, undefined)
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
  })
})

describe("a container serving nowhere today", () => {
  test("has no place, whether its placement ended or has not begun", () => {
    for (const record of [placed("BIN-91004", 4, atParkvej, "2026-01-01", "2026-09-01"), placed("BIN-91005", 5, atParkvej, "2026-10-01")]) {
      assert.equal(record.facts.Property, undefined, record.name)
      assert.equal(record.facts.Address, undefined, record.name)
      assert.equal(record.submittedValues?.planningAreaId, undefined, record.name)
      assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null, record.name)
    }
  })

  test("nor one with no placement at all", () => {
    const record = containerAdapter.toRecord({ ...containerOf("01a0d2a4-a280-7014-8000-000000000009", "BIN-91009"), placements: [] }, context)
    assert.equal(containerLocation(record, FIXTURE_GAZETTEER), null)
  })
})
