// The sidebar (Issue #248): an Active Route is a starred route the API
// holds, a badge a count of rows the API answered — or nothing — and the
// item a page is, its workspace's.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveActiveRouteSummaries } from "@/components/waste/active-routes-store"

import type { BusinessRecord } from "../business-modules"
import { navBadgeOf, navItemActive, navItems, type NavItem } from "../sidebar"

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

describe("the nav item a page is", () => {
  const activeOn = (pathname: string) => navItems.filter((item) => navItemActive(item, pathname)).map((item) => item.id)

  test("its workspace's: on the workspace's page, the other pages that show it and the surfaces its modules are shown on; the root's is Operate", () => {
    const expected: Record<string, NavItem["id"][]> = {
      "/": ["operate"],
      "/tickets": ["operate"],
      "/operate": ["operate"],
      "/plan": ["plan"],
      "/route-studio": ["route-studio"],
      "/routes": ["route-studio"],
      "/fleet": ["fleet"],
      "/customers": ["customers"],
      "/portal": ["customers"],
      "/resources": ["resources"],
      "/service-providers": ["service-providers"],
      "/service-provider-workspace/routes": ["service-providers"],
      "/commercial": ["commercial"],
      "/improve/imports": ["improve"],
      "/performance": ["improve"],
      "/settings": [],
    }
    for (const [pathname, items] of Object.entries(expected)) assert.deepEqual(activeOn(pathname), items, pathname)
  })
})
