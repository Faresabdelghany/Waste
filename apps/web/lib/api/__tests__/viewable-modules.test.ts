// Which switched modules the record store reads for a person (Issue #145, the
// rule the Driver App's browser pass asked for): those whose key the
// person's `/me` role grants `view` on, in SERVER_MODULES' load order. A
// module the grants do not cover is never requested, so a driver on the
// Driver App sees no refusal for an office pane they will never open.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import { moduleKeyOf } from "../records/adapter"
import { MODULES_WITHOUT_ME, SERVER_MODULE_KEYS, SERVER_MODULES, viewableModules } from "../records/modules"

const keysOf = (modules: readonly ReturnType<typeof viewableModules>[number][]) => modules.map((module) => moduleKeyOf(module.workspaceId, module.moduleId))
const systemRole = (key: string) => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === key)
  if (role === undefined) throw new Error(`no system role ${key}`)
  return role
}

describe("the switched modules a person's grants let the store read", () => {
  test("are none of them for the seeded driver, configure.master and configure.calendars included", () => {
    assert.deepEqual(keysOf(viewableModules(systemRole("driver").grants, SERVER_MODULES)), [])
  })

  test("are all of them, in SERVER_MODULES' order, for a provider's role that views everything, however its grants are listed", () => {
    const everything = [...SERVER_MODULE_KEYS].reverse().map((moduleKey) => ({ moduleKey, actions: ["view"] as const }))
    assert.deepEqual(keysOf(viewableModules(everything, SERVER_MODULES, { provider: true })), [...SERVER_MODULE_KEYS])
  })

  test("leave a provider's own team to a provider's account (#291 C24): the office's accounts are the access module's", () => {
    const everything = SERVER_MODULE_KEYS.map((moduleKey) => ({ moduleKey, actions: ["view"] as const }))
    const team = "service-providers.service-provider-workspace"
    assert.deepEqual(keysOf(viewableModules(everything, SERVER_MODULES)), SERVER_MODULE_KEYS.filter((key) => key !== team))
    assert.deepEqual(keysOf(MODULES_WITHOUT_ME), SERVER_MODULE_KEYS.filter((key) => key !== team))
    // An Operations Manager views the providers' workspace and not the accounts: the team is never asked for.
    assert.equal(keysOf(viewableModules(systemRole("operations-manager").grants, SERVER_MODULES)).includes(team), false)
    assert.equal(keysOf(viewableModules(systemRole("service-provider-manager").grants, SERVER_MODULES, { provider: true })).includes(team), true)
  })

  test("are exactly the ones viewed, for a role between the two", () => {
    const grants = [
      { moduleKey: "configure.areas", actions: ["view", "edit"] as const },
      { moduleKey: "customers.contacts", actions: ["view"] as const },
      { moduleKey: "operate.driver-app", actions: ["view", "edit"] as const },
    ]
    assert.deepEqual(keysOf(viewableModules(grants, SERVER_MODULES)), ["customers.contacts", "configure.areas"])
  })

  test("are none for an empty grants list, or a grant that allows nothing", () => {
    assert.deepEqual(viewableModules([], SERVER_MODULES), [])
    assert.deepEqual(viewableModules([{ moduleKey: "configure.master", actions: [] }], SERVER_MODULES), [])
  })
})

// A module read through others (`derivedFrom`, #232) is read again by the store when one of them has new rows: each it
// names is a switched module read before it, and none is itself or another such module, so a read again never asks
// for another (no chain, no loop).
describe("a module read through others", () => {
  const derived = SERVER_MODULES.filter((module) => module.derivedFrom !== undefined)

  test("the containers are one, read through the organisation (a project's day) and their places' modules", () => {
    assert.deepEqual(
      derived.map((module) => [moduleKeyOf(module.workspaceId, module.moduleId), module.derivedFrom]),
      [["resources.containers", ["configure.organization", "customers.agreements", "customers.properties", "customers.shared", "configure.areas", "configure.master"]]],
    )
  })

  test("the modules read on the project's day are the planning areas, the containers, the provider prices and the settlements", () => {
    assert.deepEqual(SERVER_MODULES.filter((module) => module.readsTheDay === true).map((module) => moduleKeyOf(module.workspaceId, module.moduleId)), ["configure.areas", "resources.containers", "commercial.service-provider-prices", "commercial.settlements"])
  })

  test("names switched modules read before it, never itself nor another module read through others", () => {
    const derivedKeys = new Set(derived.map((module) => moduleKeyOf(module.workspaceId, module.moduleId)))
    for (const module of derived) {
      const key = moduleKeyOf(module.workspaceId, module.moduleId)
      for (const source of module.derivedFrom ?? []) {
        assert.notEqual(source, key, `${key} names itself`)
        assert.ok(!derivedKeys.has(source), `${key} names ${source}, itself read through others`)
        assert.ok(SERVER_MODULE_KEYS.includes(source), `${source} is no switched module`)
        assert.ok(SERVER_MODULE_KEYS.indexOf(source) < SERVER_MODULE_KEYS.indexOf(key), `${source} is read after ${key}`)
      }
    }
  })
})
