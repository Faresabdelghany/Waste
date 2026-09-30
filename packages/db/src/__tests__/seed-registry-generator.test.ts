// The Registry seed's generated half against its one spelling (issue #99),
// without a database: the rows `pnpm db:seed` proposes for the fifty seeded
// properties and the hundred seeded containers are
// @waste/domain/fixtures/seeded-registry's, read index by index through the
// readings registry.ts states, and every point is where
// @waste/domain/fixtures/gazetteer places the address — the generator and the
// table the web prototype shows, so `property-seed-101` stands at the same
// address on the server as in the browser.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FIXTURE_GAZETTEER } from "@waste/domain/fixtures/gazetteer"
import {
  SEEDED_CONTAINER_COUNT,
  SEEDED_PROPERTY_COUNT,
  seededContainer,
  seededProperty,
} from "@waste/domain/fixtures/seeded-registry"
import { knownAddressLocation } from "@waste/domain/map-planning/positions"

import { DEMO_PROJECT_IDS } from "../seed/ids"
import { REGISTRY_IDS, REGISTRY_MAP_PLACES, REGISTRY_ROWS } from "../seed/registry"

const properties = Array.from({ length: SEEDED_PROPERTY_COUNT }, (_, index) => seededProperty(index))
const containers = Array.from({ length: SEEDED_CONTAINER_COUNT }, (_, index) => seededContainer(index))

function rowOf<T extends { id?: string }>(rows: readonly T[], id: string | undefined, what: string): T {
  const row = rows.find((candidate) => candidate.id === id)
  assert.ok(row, `the seed proposes no ${what} row ${id}`)
  return row
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

describe("the Registry seed's generated rows against @waste/domain's generator", () => {
  test("every seeded property is the domain's, keyed by its record id and stored where the gazetteer places its address", () => {
    const kinds = { Residential: "residential", Commercial: "commercial", "Mixed use": "mixed" }
    for (const property of properties) {
      const row = rowOf(REGISTRY_ROWS.properties, REGISTRY_IDS.properties[property.recordId], "property")
      const at = knownAddressLocation(property.address, FIXTURE_GAZETTEER, property.name)
      assert.ok(at, `${property.address} is on a gazetteer street`)
      assert.deepEqual(
        [row.projectId, row.name, row.address, row.registryId, row.kind, row.status, row.location],
        [
          DEMO_PROJECT_IDS[property.project],
          property.name,
          property.address,
          property.propertyNumber,
          kinds[property.propertyType],
          property.status === "Active" ? "active" : "inactive",
          { type: "Point", coordinates: [round6(at.lng), round6(at.lat)] },
        ],
        property.recordId,
      )
      const agreement = rowOf(REGISTRY_ROWS.agreements, REGISTRY_IDS.agreements[property.agreementNumber], "agreement")
      assert.deepEqual(
        [agreement.number, agreement.projectId, agreement.status, agreement.validFrom],
        property.status === "Prospect"
          ? [property.agreementNumber, row.projectId, "draft", "2026-10-01"]
          : [property.agreementNumber, row.projectId, "active", "2026-01-01"],
        property.agreementNumber,
      )
    }
  })

  test("every seeded container is the domain's, keyed by its record id, of the type its name spells", () => {
    const typeIdNamed = (name: string) => REGISTRY_ROWS.containerTypes.find((row) => row.name === name)?.id
    const ownerships = { "Company owned": "company", "Customer owned": "customer" }
    for (const container of containers) {
      const row = rowOf(REGISTRY_ROWS.containers, REGISTRY_IDS.containers[container.recordId], "container")
      assert.deepEqual(
        [row.projectId, row.label, row.containerTypeId, row.barcode, row.rfid, row.serialNumber, row.ownership],
        [
          DEMO_PROJECT_IDS[container.project],
          container.label,
          typeIdNamed(container.containerType),
          container.barcode,
          container.rfid,
          container.serialNumber,
          ownerships[container.ownership],
        ],
        container.recordId,
      )
    }
  })

  test("a seeded container in service is placed at its property, under its agreement, when a product collects its fraction, and from October when it is Future", () => {
    const collected = new Set(["Residual", "Paper", "Cardboard", "Glass"])
    const fractionIdNamed = (name: string) => REGISTRY_ROWS.wasteFractions.find((row) => row.name === name)?.id
    for (const container of containers) {
      const placement = REGISTRY_ROWS.containerServicePlacements.find((row) => row.containerId === REGISTRY_IDS.containers[container.recordId])
      if (!container.inService || !collected.has(container.fraction)) {
        assert.equal(placement, undefined, `${container.label} stands unplaced`)
        continue
      }
      assert.ok(placement, `${container.label} is placed`)
      const property = seededProperty(container.propertyIndex)
      const subscription = rowOf(REGISTRY_ROWS.subscriptions, placement.subscriptionId, "subscription")
      assert.deepEqual(
        [subscription.propertyId, subscription.agreementId, placement.wasteFractionId, placement.validFrom],
        [
          REGISTRY_IDS.properties[property.recordId],
          REGISTRY_IDS.agreements[property.agreementNumber],
          fractionIdNamed(container.fraction),
          container.status === "Future" ? "2026-10-01" : subscription.validFrom,
        ],
        container.label,
      )
    }
  })

  test("a seeded container in service is on the map at its property's point, under its planning area; one in storage is not", () => {
    const mapped = new Map(REGISTRY_MAP_PLACES.map((place) => [place.container, place]))
    for (const container of containers) {
      const place = mapped.get(container.recordId)
      if (!container.inService) {
        assert.equal(place, undefined, `${container.label} is in storage`)
        continue
      }
      const property = seededProperty(container.propertyIndex)
      const stored = rowOf(REGISTRY_ROWS.properties, REGISTRY_IDS.properties[property.recordId], "property").location
      assert.deepEqual([place?.area, place?.spot], [container.planningArea?.id, stored], container.label)
    }
  })
})
