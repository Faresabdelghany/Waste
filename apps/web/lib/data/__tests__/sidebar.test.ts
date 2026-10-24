// The sidebar on the Pilot (Issue #248): the prototype's pins and badge
// numbers are fixture mode's. On the Pilot an Active Route is a starred
// route the API holds, and a badge a count of rows the API answered — or
// nothing, never the registry's number.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveActiveRouteSummaries } from "@/components/waste/active-routes-store"

import type { BusinessRecord } from "../business-modules"
import { activeRoutes, navBadgeOf, navItems, type NavItem } from "../sidebar"

const route = (id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name: "RC-1001",
  context: "",
  status: "Active",
  owner: "",
  value: "2/4 stops",
  updated: "",
  description: "",
  facts: { Area: "Indre By Operations" },
  related: [],
  source: "",
  freshness: "",
  ...extra,
})

const itemNamed = (id: NavItem["id"]): NavItem => {
  const item = navItems.find((candidate) => candidate.id === id)
  assert.ok(item, id)
  return item
}

describe("Active Routes", () => {
  const fixturePins = activeRoutes.map((pin) => pin.id)

  test("in fixture mode the curated pins stand, as the prototype had them", () => {
    assert.deepEqual(resolveActiveRouteSummaries(fixturePins, [], "operator").map((summary) => summary.name), activeRoutes.map((pin) => pin.name))
  })

  test("on the Pilot a fixture pin the API holds no route for is dropped: no fixture route is shown as active (#248)", () => {
    assert.deepEqual(resolveActiveRouteSummaries(fixturePins, [], "operator", true), [])
  })

  test("on the Pilot a starred route the API holds is summarised from its row, even under a fixture pin's id", () => {
    const starred = route("route-01a16bc0-54b7-75b9-9a26-2dfc2fa6015e")
    const [summary] = resolveActiveRouteSummaries([starred.id], [starred], "operator", true)
    assert.equal(summary?.name, "Indre By Operations · RC-1001")
    assert.equal(summary?.progress, 50)
    const underFixtureId = route(fixturePins[0] ?? "route-1042", { name: "RC-1042" })
    assert.equal(resolveActiveRouteSummaries([underFixtureId.id], [underFixtureId], "operator", true)[0]?.name, "Indre By Operations · RC-1042", "the row's, never the curated summary")
  })
})

describe("a nav item's badge", () => {
  test("in fixture mode is the registry's number", () => {
    assert.equal(navBadgeOf(itemNamed("resources"), null), itemNamed("resources").badge)
    assert.equal(navBadgeOf(itemNamed("operate"), null), itemNamed("operate").badge)
  })

  test("on the Pilot is the open tickets once read, none before, and none on an item no count is read for (#248)", () => {
    assert.equal(navBadgeOf(itemNamed("operate"), { openTickets: 2 }), 2)
    assert.equal(navBadgeOf(itemNamed("operate"), { openTickets: undefined }), undefined)
    assert.equal(navBadgeOf(itemNamed("resources"), { openTickets: 2 }), undefined)
    assert.equal(navBadgeOf(itemNamed("commercial"), { openTickets: 2 }), undefined)
  })
})
