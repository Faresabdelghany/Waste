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

  test("opens only on categories its readers read, so no chip filters on nothing", () => {
    for (const [key, entry] of Object.entries(COMMAND_SURFACES)) {
      if (entry.list === undefined) continue
      const read = Object.keys(entry.list.readers({ accountId: null }))
      for (const category of Object.keys(entry.list.initial)) assert.ok(read.includes(category), `${key} opens on ${category}, which it does not read`)
    }
  })
})
