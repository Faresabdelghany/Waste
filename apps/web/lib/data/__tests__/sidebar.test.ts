// The sidebar (Issue #248): an Active Route is a starred route the API
// holds, and a badge a count of rows the API answered — or nothing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveActiveRouteSummaries } from "@/components/waste/active-routes-store"

import type { BusinessRecord } from "../business-modules"
import { navBadgeOf, navItems, type NavItem } from "../sidebar"

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
  test("a pin the API holds no route for is dropped (#248)", () => {
    assert.deepEqual(resolveActiveRouteSummaries(["route-1042"], [], "operator"), [])
  })

  test("a starred route the API holds is summarised from its row", () => {
    const starred = route("route-01a16bc0-54b7-75b9-9a26-2dfc2fa6015e")
    const [summary] = resolveActiveRouteSummaries([starred.id], [starred], "operator")
    assert.equal(summary?.name, "Indre By Operations · RC-1001")
    assert.equal(summary?.progress, 50)
  })
})

describe("a nav item's badge", () => {
  test("is the open tickets once read, none before, and none on an item no count is read for (#248)", () => {
    assert.equal(navBadgeOf(itemNamed("operate"), 2), 2)
    assert.equal(navBadgeOf(itemNamed("operate"), undefined), undefined)
    assert.equal(navBadgeOf(itemNamed("resources"), 2), undefined)
    assert.equal(navBadgeOf(itemNamed("commercial"), 2), undefined)
  })
})
