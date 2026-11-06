import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { EACH_CONTAINER_TYPE_ONCE, VehicleType, VehicleTypeContainerTypesSet, VehicleTypeCreate, VehicleTypeListQuery, VehicleTypePatch } from "../vehicle-types"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }

/** More ids than a set body may carry, to tell the body's bound from the row's. */
const tooManyIds = Array.from({ length: 201 }, (_unused, index) => `01a0d3a5-e5e0-7000-8000-${String(index).padStart(12, "0")}`)

const vehicleType = { id: ID, key: "rear-loader", name: "Rear loader", description: "Lifts two- and four-wheel bins from the back.", containerTypeIds: [OTHER, THIRD], ...STAMPS }

describe("VehicleType", () => {
  test("is the company's row with its compatibility set: a key, a name, a description and the container types it services", () => {
    assert.deepEqual(VehicleType.parse(vehicleType), vehicleType)
    const bare = { ...vehicleType, description: null, containerTypeIds: [] }
    assert.deepEqual(VehicleType.parse(bare), bare, "a type no typed rule matches through")
  })

  test("holds the key to the one slug shape a waste fraction's key has, at most fifty characters: the display string is not the key", () => {
    for (const key of ["Rear loader", "rear_loader", "REAR-LOADER", "-rear", "rear--loader", "", "a".repeat(51)]) assert.equal(VehicleType.safeParse({ ...vehicleType, key }).success, false, key)
    assert.equal(VehicleType.safeParse({ ...vehicleType, key: "glass-crane-16t" }).success, true)
    assert.equal(VehicleType.safeParse({ ...vehicleType, key: "a".repeat(50) }).success, true)
  })
})

describe("VehicleTypeCreate and VehicleTypePatch", () => {
  const body = { key: "glass-crane", name: "Glass crane" }

  test("defaults the compatibility set to none, says so, and mints nothing", () => {
    assert.deepEqual(VehicleTypeCreate.parse(body), { ...body, containerTypeIds: [] })
    assert.match(VehicleTypeCreate.shape.containerTypeIds.description ?? "", /no typed rule matches/)
    assert.deepEqual(VehicleTypeCreate.parse({ ...body, containerTypeIds: [OTHER], description: null }), { ...body, containerTypeIds: [OTHER], description: null })
    refusesWhatTheServerOwns(VehicleTypeCreate, body)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(VehicleTypeCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("names each container type once, and takes at most two hundred on a body", () => {
    assert.deepEqual(refusal(VehicleTypeCreate.safeParse({ ...body, containerTypeIds: [OTHER, OTHER] })), [{ path: "containerTypeIds", message: EACH_CONTAINER_TYPE_ONCE }])
    assert.equal(VehicleTypeCreate.safeParse({ ...body, containerTypeIds: tooManyIds }).success, false)
    assert.equal(VehicleType.parse({ ...vehicleType, containerTypeIds: tooManyIds }).containerTypeIds.length, tooManyIds.length, "the bound is a body's; a stored set reads back however long it grew")
  })

  test("the patch moves the name and the description, and never the key or the set", () => {
    assert.deepEqual(VehicleTypePatch.parse({ name: "Baglæsser" }), { name: "Baglæsser" })
    assert.deepEqual(VehicleTypePatch.parse({ description: null }), { description: null })
    refusesAnEmptyPatch(VehicleTypePatch)
    for (const key of ["key", "containerTypeIds", "id"]) {
      assert.match(refusal(VehicleTypePatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key))
    }
  })
})

describe("VehicleTypeContainerTypesSet and VehicleTypeListQuery", () => {
  test("the set is the whole list, the empty list included, each type once, at most two hundred, and nothing else", () => {
    assert.deepEqual(VehicleTypeContainerTypesSet.parse({ containerTypeIds: [OTHER, THIRD] }), { containerTypeIds: [OTHER, THIRD] })
    assert.deepEqual(VehicleTypeContainerTypesSet.parse({ containerTypeIds: [] }), { containerTypeIds: [] })
    assert.deepEqual(refusal(VehicleTypeContainerTypesSet.safeParse({ containerTypeIds: [OTHER, OTHER] })), [{ path: "containerTypeIds", message: EACH_CONTAINER_TYPE_ONCE }])
    assert.equal(VehicleTypeContainerTypesSet.safeParse({ containerTypeIds: tooManyIds }).success, false)
    assert.match(refusal(VehicleTypeContainerTypesSet.safeParse({ containerTypeIds: [], vehicleTypeId: ID }))[0].message, /vehicleTypeId/)
  })

  test("the list is a page and nothing more: a vehicle type is the company's", () => {
    assert.deepEqual(VehicleTypeListQuery.parse({}), { limit: 50 })
    assert.deepEqual(VehicleTypeListQuery.parse({ limit: "10", projectId: OTHER }), { limit: 10 }, "a project is not a filter here and is dropped, not refused")
  })
})
