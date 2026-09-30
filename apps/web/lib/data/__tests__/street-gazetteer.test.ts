// @waste/domain places an address only on a street the caller's table
// lists, and the purity gate keeps the registry out of the package, so the
// domain can hold the gazetteer and the seeded generator together
// (fixtures/__tests__) but never the explicit fixture records. This test is
// the bridge (issue #58): every street the fixtures rely on has an anchor,
// so a renamed or added fixture street fails here instead of silently
// hashing a container to a random spot or dropping a route day from the
// Routes layer.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  addressLocation,
  containerLocation,
  containerPropertyKey,
} from "@waste/domain/map-planning/positions"
import { routesInWindow } from "@waste/domain/map-planning/routes"
import { isSoftDeleted } from "@waste/domain/record-visibility"
import { cleanFact } from "@waste/domain/record-values"

import { businessWorkspaceList, type BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

function fixtureRecords(moduleId: string): BusinessRecord[] {
  const modules = businessWorkspaceList.flatMap((workspace) => workspace.modules).filter((module) => module.id === moduleId)
  assert.equal(modules.length, 1, `exactly one fixture module is called ${moduleId}`)
  return modules[0].records
}

/** The containers the map works from: visible and placed — the view's own filter. */
const inService = fixtureRecords("containers").filter(
  (record) => !isSoftDeleted(record) && containerLocation(record, FIXTURE_GAZETTEER) !== null,
)

describe("the fixture gazetteer against the fixture registry", () => {
  test("every fixture container the map places sits on a gazetteer street, never at its hashed fallback", () => {
    assert.ok(inService.length > 0, "the registry places containers")
    // The fallback is where the address would land with no gazetteer at all; typed coordinates and
    // gazetteer streets both land elsewhere, so only an unlisted street matches its own fallback.
    const hashed = inService.filter((record) => {
      const key = containerPropertyKey(record) ?? ""
      const fallback = addressLocation(cleanFact(record.facts.Address) ?? key, {}, key)
      const placed = containerLocation(record, FIXTURE_GAZETTEER)
      return placed !== null && placed.lng === fallback.lng && placed.lat === fallback.lat
    })
    assert.deepEqual(
      [...new Set(hashed.map((record) => cleanFact(record.facts.Address) ?? containerPropertyKey(record)))],
      [],
      "streets the gazetteer does not list",
    )
  })

  test("the fixture route days the Routes layer can draw are the ones with a stop on a gazetteer street", () => {
    // Fixture pickups name containers the registry does not hold, so a stop is placed by its address
    // alone, and only a stop on a listed street counts. The e2e suite pins the same picture by status.
    const drawable = routesInWindow(fixtureRecords("routes"), fixtureRecords("pickups"), inService, null, FIXTURE_GAZETTEER)
    const names = drawable.map((route) => route.name).sort()
    assert.deepEqual(names, ["RC-1042", "RC-1044", "RC-1048"])
    assert.ok(drawable.every((route) => route.stops.length > 0), "drawable means at least one located stop")
    assert.ok(
      !names.includes("RC-1058"),
      "RC-1058 starts at a depot on Gammel Køge Landevej, which the gazetteer deliberately leaves out (see its header)",
    )
  })
})
