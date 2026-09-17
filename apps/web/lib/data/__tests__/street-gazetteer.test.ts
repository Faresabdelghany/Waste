// The gazetteer is fixture data the domain cannot see: @waste/domain places
// an address only on a street the caller's table lists, and the purity gate
// keeps the registry out of the package. This test is the bridge (issue
// #58): every street the fixtures rely on has an anchor, so a renamed or
// added fixture street fails here instead of silently hashing a container
// to a random spot or dropping a route day from the Routes layer.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { containerLocation, knownAddressLocation } from "@waste/domain/map-planning/positions"
import { routesInWindow } from "@waste/domain/map-planning/routes"
import { cleanFact } from "@waste/domain/record-values"

import { businessWorkspaceList, type BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

function fixtureRecords(moduleId: string): BusinessRecord[] {
  const modules = businessWorkspaceList.flatMap((workspace) => workspace.modules).filter((module) => module.id === moduleId)
  assert.equal(modules.length, 1, `exactly one fixture module is called ${moduleId}`)
  return modules[0].records
}

describe("the fixture gazetteer against the fixture registry", () => {
  test("every fixture container the map places sits on a gazetteer street, never at a hashed fallback", () => {
    const placed = fixtureRecords("containers").filter((record) => containerLocation(record, FIXTURE_GAZETTEER) !== null)
    assert.ok(placed.length > 40, `the registry places ${placed.length} containers`)
    const hashed = placed
      .map((record) => cleanFact(record.facts.Address) ?? cleanFact(record.facts.Property) ?? "")
      .filter((address) => knownAddressLocation(address, FIXTURE_GAZETTEER) === null)
    assert.deepEqual([...new Set(hashed)], [], "streets the gazetteer does not list")
  })

  test("the fixture route days the Routes layer can draw are the ones with a stop on a gazetteer street", () => {
    // Fixture pickups name containers the registry does not hold, so a stop is placed by its address alone.
    // Each listed route day has exactly one such stop today; the e2e suite pins the same picture on screen.
    const drawable = routesInWindow(fixtureRecords("routes"), fixtureRecords("pickups"), fixtureRecords("containers"), null, FIXTURE_GAZETTEER)
    assert.deepEqual(
      drawable.map((route) => `${route.name} ${route.bucket} ${route.stops.length}/${route.stopCount}`),
      ["RC-1042 in-progress 1/42", "RC-1048 in-progress 1/36", "RC-1044 completed 1/3"],
    )
  })
})
