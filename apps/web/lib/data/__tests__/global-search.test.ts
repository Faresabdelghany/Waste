import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { officeSearchModules, searchPages, searchRecords, type SearchSource } from "../global-search"

const row = (id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord =>
  ({ id, name, context: "", status: "Active", value: "", facts: {}, ...extra }) as unknown as BusinessRecord

const providers: SearchSource = {
  location: { workspaceId: "service-providers", moduleId: "service-providers" } as SearchSource["location"],
  label: "Service Providers",
  records: [row("service-provider-1", "NordRen ApS", { context: "Denmark · 40291188" }), row("service-provider-2", "CityHaul A/S", { facts: { "Primary contact": "Nora Renberg" } })],
}
const tickets: SearchSource = {
  location: { workspaceId: "operate", moduleId: "tickets" } as SearchSource["location"],
  label: "Tickets",
  records: [row("ticket-1", "Bin not emptied at Nordre Fasanvej 12", { context: "T-1004" })],
}

describe("searchRecords (#648)", () => {
  test("finds a record by its name, its context or a fact, in any case, and opens it at its own address", () => {
    const [hit] = searchRecords([providers], "nordren")
    assert.equal(hit.title, "NordRen ApS")
    assert.equal(hit.group, "Service Providers")
    assert.match(hit.href, /^\/service-providers\?.*record=service-provider-1/)
    assert.deepEqual(searchRecords([providers], "40291188").map((hit) => hit.title), ["NordRen ApS"])
    assert.deepEqual(searchRecords([providers], "renberg").map((hit) => hit.title), ["CityHaul A/S"])
  })

  test("every word must be found; a name beginning with the query comes first", () => {
    assert.deepEqual(searchRecords([tickets, providers], "nor").map((hit) => hit.title), ["NordRen ApS", "Bin not emptied at Nordre Fasanvej 12", "CityHaul A/S"])
    assert.deepEqual(searchRecords([tickets, providers], "nordre fasanvej").map((hit) => hit.title), ["Bin not emptied at Nordre Fasanvej 12"])
    assert.deepEqual(searchRecords([tickets, providers], "nordren fasanvej"), [])
  })

  test("a query of one letter, or none, searches nothing; the hits stop at the limit", () => {
    assert.deepEqual(searchRecords([providers], "n"), [])
    assert.deepEqual(searchRecords([providers], "   "), [])
    assert.equal(searchRecords([tickets, providers], "a", { limit: 1 }).length, 0)
    assert.equal(searchRecords([tickets, providers], "no", { limit: 2 }).length, 2)
  })
})

describe("a provider's search", () => {
  test("opens a record on the provider's own page, never the office's workspace", () => {
    const [hit] = searchRecords([{ ...providers, page: "/service-provider-workspace/fleet" }], "nordren")
    assert.match(hit.href, /^\/service-provider-workspace\/fleet\?/)
  })
})

describe("searchPages", () => {
  test("an empty query lists every page; a word narrows them", () => {
    const pages = [{ label: "Tickets", href: "/tickets" }, { label: "Service providers", href: "/service-providers" }]
    assert.equal(searchPages(pages, "").length, 2)
    assert.deepEqual(searchPages(pages, "serv").map((page) => page.href), ["/service-providers"])
  })
})

describe("officeSearchModules", () => {
  test("reads the office's modules, never the Driver App or a module shown inside another", () => {
    const keys = officeSearchModules().map(({ location }) => `${location.workspaceId}.${location.moduleId}`)
    assert.ok(keys.includes("operate.tickets"))
    assert.ok(keys.includes("service-providers.service-providers"))
    assert.ok(keys.length > 20)
    assert.ok(!keys.some((key) => key.startsWith("improve.")), "the Dashboard opens no record")
    assert.ok(!keys.includes("operate.driver-app"), "the Driver App is an app of its own")
    assert.ok(!keys.some((key) => key.startsWith("control-center.")), "a workspace the sidebar does not list has no page")
    assert.ok(keys.includes("configure.portals"), "Settings is searched")
  })
})
