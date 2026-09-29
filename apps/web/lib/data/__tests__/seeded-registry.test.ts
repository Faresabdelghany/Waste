// The registry's generated half against its one spelling (issue #99): the
// fifty seeded properties and the hundred seeded containers the prototype
// shows are @waste/domain/fixtures/seeded-registry's, read index by index,
// and the map places them through @waste/domain/fixtures/gazetteer — the
// generator and the table `pnpm db:seed` reads too, so `property-seed-101`
// stands at the same address in the browser and on the server.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FIXTURE_GAZETTEER as DOMAIN_GAZETTEER } from "@waste/domain/fixtures/gazetteer"
import {
  SEEDED_CONTAINER_COUNT,
  SEEDED_PROPERTY_COUNT,
  seededContainer,
  seededProperty,
} from "@waste/domain/fixtures/seeded-registry"

import { businessWorkspaceList, type BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

function fixtureRecords(moduleId: string, idPrefix: string): Map<string, BusinessRecord> {
  const modules = businessWorkspaceList.flatMap((workspace) => workspace.modules).filter((module) => module.id === moduleId)
  assert.equal(modules.length, 1, `exactly one fixture module is called ${moduleId}`)
  return new Map(modules[0].records.filter((record) => record.id.startsWith(idPrefix)).map((record) => [record.id, record]))
}

const PROJECT_NAMES = { copenhagen: "Copenhagen Central", harbor: "Harbor Commercial" }

describe("the fixture registry's generated records against @waste/domain's generator", () => {
  test("the gazetteer the map places through is the domain's table itself", () => {
    assert.equal(FIXTURE_GAZETTEER, DOMAIN_GAZETTEER)
  })

  test("every seeded property is the domain's seeded property of its index, and there are no others", () => {
    const records = fixtureRecords("properties", "property-seed-")
    assert.equal(records.size, SEEDED_PROPERTY_COUNT)
    for (let index = 0; index < SEEDED_PROPERTY_COUNT; index += 1) {
      const property = seededProperty(index)
      const record = records.get(property.recordId)
      assert.ok(record, `${property.recordId} is a fixture`)
      assert.deepEqual(
        [
          record.name,
          record.status,
          record.facts.ServiceAddress,
          record.facts.Owner,
          record.facts.Payer,
          record.facts["Property number"],
          record.facts["Property type"],
          record.facts.Project,
          record.related.includes(`Agreement ${property.agreementNumber}`),
        ],
        [
          property.name,
          property.status,
          property.address,
          property.owner,
          property.payer,
          property.propertyNumber,
          property.propertyType,
          PROJECT_NAMES[property.project],
          true,
        ],
        property.recordId,
      )
    }
  })

  test("every seeded container is the domain's seeded container of its index, standing at its property, and there are no others", () => {
    const records = fixtureRecords("containers", "asset-seed-")
    assert.equal(records.size, SEEDED_CONTAINER_COUNT)
    for (let index = 0; index < SEEDED_CONTAINER_COUNT; index += 1) {
      const container = seededContainer(index)
      const property = seededProperty(container.propertyIndex)
      const record = records.get(container.recordId)
      assert.ok(record, `${container.recordId} is a fixture`)
      assert.deepEqual(
        [
          record.name,
          record.status,
          record.facts.Barcode,
          record.facts.RFID,
          record.facts["Serial number"],
          record.facts["Container type"],
          record.facts["Waste fractions"],
          record.facts.Ownership,
          record.facts.Project,
          record.facts.Property,
          record.facts.Address,
          record.facts["Planning area"],
          record.submittedValues?.planningAreaId,
          record.submittedValues?.serviceFrequencyId,
          record.facts.Agreement,
        ],
        [
          container.label,
          container.status,
          container.barcode,
          container.rfid ?? "Not recorded",
          container.serialNumber,
          container.containerType,
          container.fraction,
          container.ownership,
          PROJECT_NAMES[property.project],
          container.inService ? property.name : "—",
          container.inService ? property.address : "Warehouse West · aisle C2",
          container.planningArea?.name ?? "—",
          container.planningArea?.id,
          container.serviceFrequencyId ?? undefined,
          container.status === "Future"
            ? `${property.agreementNumber} · Future`
            : container.inService
              ? `${property.agreementNumber} · Active`
              : "None",
        ],
        container.recordId,
      )
    }
  })
})
