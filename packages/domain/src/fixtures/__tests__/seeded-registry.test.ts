// The generated half of the demo registry, pinned by the rows the web
// prototype showed and `pnpm db:seed` wrote before the one spelling moved here
// (issue #99): a changed street, owner rotation or modulus fails here by the
// row it moves, since the same record id would stand elsewhere on the server
// than in the browser.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  SEEDED_CONTAINER_COPENHAGEN_COUNT,
  SEEDED_CONTAINER_COUNT,
  SEEDED_PROPERTY_COPENHAGEN_COUNT,
  SEEDED_PROPERTY_COUNT,
  seededContainer,
  seededContainerRecordId,
  seededProperty,
  seededPropertyRecordId,
} from "../seeded-registry"

const properties = Array.from({ length: SEEDED_PROPERTY_COUNT }, (_, index) => seededProperty(index))
const containers = Array.from({ length: SEEDED_CONTAINER_COUNT }, (_, index) => seededContainer(index))

describe("the seeded properties", () => {
  test("fifty, the first thirty-five in Copenhagen Central and the rest in Harbor Commercial", () => {
    assert.deepEqual([SEEDED_PROPERTY_COUNT, SEEDED_PROPERTY_COPENHAGEN_COUNT], [50, 35])
    assert.deepEqual(
      properties.map((property) => property.project),
      [...Array<string>(35).fill("copenhagen"), ...Array<string>(15).fill("harbor")],
    )
  })

  test("each is the row the prototype and the seed have shown for its record id", () => {
    assert.deepEqual(seededProperty(0), {
      recordId: "property-seed-101",
      project: "copenhagen",
      name: "Ryesgade 3",
      address: "Ryesgade 3, 2200 København N",
      propertyNumber: "CPH-91000",
      propertyType: "Residential",
      owner: "Østerbro Housing",
      payer: "Østerbro Housing",
      status: "Active",
      agreementNumber: "AGR-2600",
    })
    assert.deepEqual(seededProperty(35), {
      recordId: "property-seed-136",
      project: "harbor",
      name: "Sandkaj 8",
      address: "Sandkaj 8, 2150 Nordhavn",
      propertyNumber: "CPH-91035",
      propertyType: "Mixed use",
      owner: "By & Havn",
      payer: "Municipal payer",
      status: "Active",
      agreementNumber: "AGR-2635",
    })
    const read = (index: number) => {
      const { recordId, name, owner, payer, propertyType, status } = seededProperty(index)
      return [recordId, name, owner, payer, propertyType, status]
    }
    assert.deepEqual(read(3), ["property-seed-104", "Amagerbrogade 24", "DEAS Ejendomme", "Municipal payer", "Residential", "Active"])
    assert.deepEqual(read(7), ["property-seed-108", "Strandboulevarden 52", "KAB Bolig", "Municipal payer", "Commercial", "Prospect"])
    assert.deepEqual(read(10), ["property-seed-111", "Østerbrogade 73", "Private", "Private", "Commercial", "On hold"])
    assert.deepEqual(read(34), ["property-seed-135", "Østerbrogade 121", "Private", "Private", "Commercial", "On hold"])
    assert.deepEqual(read(49), ["property-seed-150", "Helsinkigade 106", "KAB Bolig", "KAB Bolig", "Commercial", "Active"])
  })

  test("the record id, the property number and the agreement number are the index's own, and none repeats", () => {
    for (const key of ["recordId", "propertyNumber", "agreementNumber", "address"] as const) {
      assert.equal(new Set(properties.map((property) => property[key])).size, SEEDED_PROPERTY_COUNT, `${key} repeats`)
    }
    assert.equal(seededPropertyRecordId(49), properties[49].recordId)
  })

  test("an index outside the fifty is refused, never a property nobody seeded", () => {
    for (const index of [-1, SEEDED_PROPERTY_COUNT, 1.5]) {
      assert.throws(() => seededProperty(index), RangeError)
      assert.throws(() => seededPropertyRecordId(index), RangeError)
    }
  })
})

describe("the seeded containers", () => {
  test("a hundred, the first seventy in Copenhagen Central standing at its properties and the rest at Harbor Commercial's", () => {
    assert.deepEqual([SEEDED_CONTAINER_COUNT, SEEDED_CONTAINER_COPENHAGEN_COUNT], [100, 70])
    for (const container of containers) {
      assert.equal(seededProperty(container.propertyIndex).project, container.project, `${container.label} stands in its own project`)
    }
    assert.deepEqual(
      containers.map((container) => container.project),
      [...Array<string>(70).fill("copenhagen"), ...Array<string>(30).fill("harbor")],
    )
  })

  test("each is the row the prototype and the seed have shown for its record id", () => {
    assert.deepEqual(seededContainer(0), {
      recordId: "asset-seed-91001",
      binNumber: 91001,
      label: "BIN-91001",
      project: "copenhagen",
      propertyIndex: 0,
      status: "Available",
      inService: true,
      fraction: "Residual",
      containerType: "Two-wheel bin · 140 L",
      barcode: "WH91001",
      rfid: "E20091001",
      serialNumber: "SEED-26-91001",
      ownership: "Company owned",
      serviceFrequencyId: "freq-every-2-weeks",
      planningArea: { id: "area-indreby", name: "Indre By Operations" },
    })
    assert.deepEqual(seededContainer(17), {
      recordId: "asset-seed-91018",
      binNumber: 91018,
      label: "BIN-91018",
      project: "copenhagen",
      propertyIndex: 17,
      status: "In storage",
      inService: false,
      fraction: "Cardboard",
      containerType: "Underground · 5,000 L",
      barcode: "WH91018",
      rfid: "E20091018",
      serialNumber: "SEED-26-91018",
      ownership: "Company owned",
      serviceFrequencyId: null,
      planningArea: null,
    })
    const read = (index: number) => {
      const { recordId, propertyIndex, status, fraction, containerType, ownership, rfid, serviceFrequencyId, planningArea } = seededContainer(index)
      return [recordId, seededProperty(propertyIndex).name, status, fraction, containerType, ownership, rfid, serviceFrequencyId, planningArea?.id ?? null]
    }
    assert.deepEqual(read(3), ["asset-seed-91004", "Amagerbrogade 24", "Available", "Cardboard", "Four-wheel bin · 1,100 L", "Company owned", null, "freq-weekly", "area-indreby"])
    assert.deepEqual(read(4), ["asset-seed-91005", "Istedgade 31", "Available", "Glass", "Igloo · 2,500 L", "Customer owned", "E20091005", "freq-every-2-weeks", "area-osterbro-contract"])
    assert.deepEqual(read(5), ["asset-seed-91006", "Godthåbsvej 38", "Defect", "Plastic", "Underground · 5,000 L", "Company owned", "E20091006", "freq-weekly", "area-amager-1"])
    assert.deepEqual(read(8), ["asset-seed-91009", "Tagensvej 59", "Future", "Organic", "Four-wheel bin · 660 L", "Company owned", "E20091009", "freq-every-2-weeks", "area-amager-1"])
    assert.deepEqual(read(11), ["asset-seed-91012", "Vigerslev Allé 80", "On hold", "Glass", "Underground · 5,000 L", "Company owned", null, "freq-weekly", "area-amager-1"])
    assert.deepEqual(read(69), ["asset-seed-91070", "Østerbrogade 121", "Available", "Metal", "Four-wheel bin · 1,100 L", "Customer owned", "E20091070", "freq-weekly", "area-indreby"])
    assert.deepEqual(read(70), ["asset-seed-91071", "Sandkaj 8", "Available", "Residual", "Igloo · 2,500 L", "Company owned", "E20091071", "freq-every-2-weeks", "area-harbor-1"])
    assert.deepEqual(read(99), ["asset-seed-91100", "Helsinkigade 106", "Available", "Organic", "Four-wheel bin · 1,100 L", "Customer owned", null, "freq-weekly", "area-harbor-1"])
  })

  test("only a container in storage is out of service, and it promises no cadence and files under no planning area", () => {
    for (const container of containers) {
      assert.equal(container.inService, container.status !== "In storage", container.label)
      assert.equal(container.serviceFrequencyId === null, !container.inService, container.label)
      assert.equal(container.planningArea === null, !container.inService, container.label)
    }
    assert.deepEqual(
      containers.filter((container) => !container.inService).map((container) => container.label),
      ["BIN-91018", "BIN-91038", "BIN-91058", "BIN-91078", "BIN-91098"],
    )
  })

  test("a Harbor Commercial container files under the harbor's area, a Copenhagen Central one under one of the city's three", () => {
    const areas = (project: string) =>
      [...new Set(containers.filter((container) => container.project === project && container.planningArea).map((container) => container.planningArea?.id))].sort()
    assert.deepEqual(areas("harbor"), ["area-harbor-1"])
    assert.deepEqual(areas("copenhagen"), ["area-amager-1", "area-indreby", "area-osterbro-contract"])
  })

  test("the record id, the label, the barcode and the serial number are the bin number's own, and none repeats", () => {
    for (const key of ["recordId", "label", "barcode", "serialNumber"] as const) {
      assert.equal(new Set(containers.map((container) => container[key])).size, SEEDED_CONTAINER_COUNT, `${key} repeats`)
    }
    assert.equal(seededContainerRecordId(99), containers[99].recordId)
  })

  test("an index outside the hundred is refused, never a container nobody seeded", () => {
    for (const index of [-1, SEEDED_CONTAINER_COUNT, 2.5]) {
      assert.throws(() => seededContainer(index), RangeError)
      assert.throws(() => seededContainerRecordId(index), RangeError)
    }
  })
})
