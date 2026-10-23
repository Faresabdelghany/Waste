// The command surfaces (Issue #181): how a switched module is operated on the
// Pilot beyond its own create and edit forms — a dialog standing in for its
// primary action, its rows' commands in their details. The workspace
// consults one registry for them, and only with the adapter configured, so
// fixture mode never reaches it and a module that is not switched has none.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { COMMAND_SURFACES, commandSurfaceFor, initialFiltersOf, listShows, type CommandSurface, type ModuleList } from "@/components/waste/commands/command-surfaces"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { emptyBusinessFilters } from "@waste/domain/business-filters"

import { moduleKeyOf } from "../records/adapter"
import { SERVER_MODULE_KEYS } from "../records/modules"

describe("the command surfaces", () => {
  test("name only switched modules", () => {
    for (const key of Object.keys(COMMAND_SURFACES)) assert.ok(SERVER_MODULE_KEYS.includes(key), `${key} is not in SERVER_MODULES`)
  })

  test("are nobody's in fixture mode, nor a module the API does not back", () => {
    for (const key of Object.keys(COMMAND_SURFACES)) {
      const [workspaceId, moduleId] = key.split(".") as [Parameters<typeof moduleKeyOf>[0], string]
      assert.equal(commandSurfaceFor(workspaceId, moduleId, false), undefined, `${key} offers its surface without the adapter`)
      assert.equal(commandSurfaceFor(workspaceId, moduleId, true), COMMAND_SURFACES[key])
    }
    assert.equal(commandSurfaceFor("improve", "insights", true), undefined)
  })
})

describe("a module's list on the Pilot (#147)", () => {
  const surface: CommandSurface = {
    primary: null,
    list: {
      readers: ({ accountId }) => ({ openness: () => ["Open"], assignees: () => (accountId === null ? [] : ["Mine"]) }),
      initial: { openness: ["Open"] },
    },
  }

  test("opens the module on its initial filters, over no filter", () => {
    assert.deepEqual(initialFiltersOf(surface), { ...emptyBusinessFilters, openness: ["Open"] })
    assert.deepEqual(initialFiltersOf({ primary: null }), emptyBusinessFilters, "a surface without a list opens unfiltered")
    assert.deepEqual(initialFiltersOf(undefined), emptyBusinessFilters)
  })

  test("is never consulted in fixture mode: every module opens unfiltered there", () => {
    for (const key of Object.keys(COMMAND_SURFACES)) {
      const [workspaceId, moduleId] = key.split(".") as [Parameters<typeof moduleKeyOf>[0], string]
      assert.deepEqual(initialFiltersOf(commandSurfaceFor(workspaceId, moduleId, false)), emptyBusinessFilters, key)
    }
  })

  test("shows every row, unless it says which: the rows of one shape where a module holds two (#185)", () => {
    const row = { id: "price-row-1", recordKind: "Price row" } as BusinessRecord
    const list = { id: "price-list-1", recordKind: "Price list" } as BusinessRecord
    assert.equal(listShows(surface.list, list), true, "a list without `shows` shows every row")
    assert.equal(listShows(undefined, list), true, "so does a module without a list")
    const rowsOnly: ModuleList = { ...surface.list!, shows: (record) => record.recordKind === "Price row" }
    assert.equal(listShows(rowsOnly, row), true)
    assert.equal(listShows(rowsOnly, list), false)
  })

  test("the Price Engine's: the price rows' table lists the rows and never the lists, the events open on the blocked and the ready (#185)", () => {
    const priceRows = COMMAND_SURFACES["commercial.price-rows"].list
    assert.equal(listShows(priceRows, { id: "price-row-0190", recordKind: "Price row" } as BusinessRecord), true)
    assert.equal(listShows(priceRows, { id: "price-list-0190", recordKind: "Price list" } as BusinessRecord), false)
    assert.equal(listShows(priceRows, { id: "price-rows-price-list-1700000000000", recordKind: "Price list" } as BusinessRecord), false, "a list made this session, under its minted id")
    assert.deepEqual(initialFiltersOf(COMMAND_SURFACES["commercial.events"]), { ...emptyBusinessFilters, statuses: ["Blocked", "Ready"] })
    const event = { status: "Blocked", facts: { Kind: "Ticket", "Block reason": "No product", Agreement: "AGR-2408", Customer: "Østerbro Housing", Route: "RC-1042", "Service date": "2026-09-29" } } as unknown as BusinessRecord
    const readers = COMMAND_SURFACES["commercial.events"].list!.readers({ accountId: null })
    assert.deepEqual([readers.blockReasons!(event), readers.agreements!(event), readers.products!(event)], [["No product"], ["AGR-2408"], []])
  })

  test("the provider-money chain's: the service areas' table lists the awards and never their assignments, the weights open on the desk's queue (#186)", () => {
    const areas = COMMAND_SURFACES["service-providers.service-areas"].list
    assert.equal(listShows(areas, { id: "service-area-0190", recordKind: "Service area" } as BusinessRecord), true)
    assert.equal(listShows(areas, { id: "service-areas-service-area-1700000000000", recordKind: "Service area" } as BusinessRecord), true, "an award made this session, under its minted id")
    assert.equal(listShows(areas, { id: "assignment-0190", recordKind: "Service area assignment" } as BusinessRecord), false)
    assert.equal(listShows(areas, { id: "service-areas-assignment-1700000000000", recordKind: "Service area assignment" } as BusinessRecord), false)
    const award = { status: "Active", facts: { "Planning areas": "Østerbro Zone 2 · Nordhavn" } } as unknown as BusinessRecord
    assert.deepEqual(areas!.readers({ accountId: null }).planningAreas!(award), ["Østerbro Zone 2", "Nordhavn"])
    assert.deepEqual(initialFiltersOf(COMMAND_SURFACES["route-studio.weights"]), { ...emptyBusinessFilters, statuses: ["Needs review"] })
    assert.equal(COMMAND_SURFACES["route-studio.weights"].primary, null, "an unload is the Driver App's, never the office's")
  })

  test("opens only on categories its readers read, so no chip filters on nothing", () => {
    for (const [key, entry] of Object.entries(COMMAND_SURFACES)) {
      if (entry.list === undefined) continue
      const read = Object.keys(entry.list.readers({ accountId: null }))
      for (const category of Object.keys(entry.list.initial)) assert.ok(read.includes(category), `${key} opens on ${category}, which it does not read`)
    }
  })
})
