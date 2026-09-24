import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CONTAINER_TYPE_VOCABULARY, CONTAINER_VEHICLE_COMPATIBILITY } from "../matching"
import {
  SCHEME_SERVICE_TYPES,
  SERVICE_TYPE_CONTAINER_TYPES,
  allowedContainerTypes,
  containerTypesOutsideServiceType,
  isSchemeServiceType,
} from "../scope"

describe("service type → allowed container types", () => {
  test("the five service types, the prototype's three first", () => {
    assert.deepEqual(SCHEME_SERVICE_TYPES, [
      "Container collection",
      "Underground collection",
      "Kerbside collection",
      "Crane collection",
      "Tank emptying",
    ])
    assert.equal(isSchemeServiceType("Kerbside collection"), true)
    assert.equal(isSchemeServiceType("Crane collection"), true)
    assert.equal(isSchemeServiceType("Tank emptying"), true)
    // Round 2's five values mapped to nothing; a stored "Collection" is unset.
    assert.equal(isSchemeServiceType("Collection"), false)
  })

  test("each service type allows its container types; no service type restricts nothing", () => {
    assert.deepEqual(allowedContainerTypes("Container collection"), [
      "Two-wheel bin · 240 L",
      "Four-wheel bin · 660 L",
      "Four-wheel bin · 1,100 L",
    ])
    assert.deepEqual(allowedContainerTypes("Underground collection"), ["Underground · 5,000 L"])
    assert.deepEqual(allowedContainerTypes("Kerbside collection"), [
      "Two-wheel bin · 140 L",
      "Two-wheel bin · 240 L",
    ])
    // Issue #42: the crane empties igloos and underground containers alike,
    // so Underground · 5,000 L belongs to both its own type and the crane's.
    assert.deepEqual(allowedContainerTypes("Crane collection"), [
      "Igloo · 2,500 L",
      "Underground · 5,000 L",
    ])
    assert.deepEqual(allowedContainerTypes("Tank emptying"), ["Wastewater tank · 3,000 L"])
    assert.equal(allowedContainerTypes(""), null)
    assert.equal(allowedContainerTypes("Collection"), null)
  })

  test("the container types of a group that fall outside the scheme's service type", () => {
    assert.deepEqual(
      containerTypesOutsideServiceType(
        ["Two-wheel bin · 240 L", "Four-wheel bin · 660 L"],
        "Kerbside collection",
      ),
      ["Four-wheel bin · 660 L"],
    )
    assert.deepEqual(
      containerTypesOutsideServiceType(["Four-wheel bin · 660 L"], "Container collection"),
      [],
    )
    assert.deepEqual(
      containerTypesOutsideServiceType(["Igloo · 2,500 L"], "Container collection"),
      ["Igloo · 2,500 L"],
    )
    assert.deepEqual(containerTypesOutsideServiceType(["Igloo · 2,500 L"], "Crane collection"), [])
    assert.deepEqual(containerTypesOutsideServiceType(["Igloo · 2,500 L"], ""), [])
  })

  test("every container type in the vocabulary belongs to at least one service type", () => {
    // The gap issue #42 closed: a type no service type collects cannot be
    // planned by Guided Setup at all. Pinned so a type added to the
    // vocabulary fails here until a service type names it.
    const mapped = new Set(Object.values(SERVICE_TYPE_CONTAINER_TYPES).flat())
    for (const containerType of CONTAINER_TYPE_VOCABULARY) {
      assert.ok(mapped.has(containerType), `${containerType} belongs to no service type`)
    }
    for (const containerType of mapped) {
      assert.ok(
        CONTAINER_TYPE_VOCABULARY.includes(containerType),
        `${containerType} is not in the container vocabulary`,
      )
    }
  })

  test("a service type's container types share at least one vehicle type", () => {
    // A service type is one kind of work for one kind of vehicle: the group
    // editor lets a group pick any of its container types, so one vehicle
    // must be able to service them all.
    for (const serviceType of SCHEME_SERVICE_TYPES) {
      const [first, ...rest] = SERVICE_TYPE_CONTAINER_TYPES[serviceType]
      assert.ok(first, `${serviceType} collects nothing`)
      const shared = rest.reduce<readonly string[]>(
        (vehicleTypes, containerType) =>
          vehicleTypes.filter((vehicleType) =>
            CONTAINER_VEHICLE_COMPATIBILITY[containerType]?.includes(vehicleType),
          ),
        CONTAINER_VEHICLE_COMPATIBILITY[first] ?? [],
      )
      assert.ok(shared.length > 0, `${serviceType}'s container types share no vehicle type`)
    }
  })
})
