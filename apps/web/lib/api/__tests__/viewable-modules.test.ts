// Which switched modules the record store reads for a person (Issue #145, the
// rule the Driver App's browser pass asked for): those whose key the
// person's `/me` role grants `view` on, in SERVER_MODULES' order. A
// module the grants do not cover is never requested, so a driver on the
// Driver App sees no refusal for an office pane they will never open.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import type { Grants } from "../grants"
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
    const everything: Grants = [...SERVER_MODULES].reverse().map((module) => ({ moduleKey: moduleKeyOf(module.workspaceId, module.moduleId), actions: ["view"] }))
    assert.deepEqual(keysOf(viewableModules(everything, SERVER_MODULES, { provider: true })), [...SERVER_MODULE_KEYS])
  })

  test("leave a provider's own team to a provider's account (#291 C24): the office's accounts are the access module's", () => {
    const everything: Grants = SERVER_MODULES.map((module) => ({ moduleKey: moduleKeyOf(module.workspaceId, module.moduleId), actions: ["view"] }))
    const team = "service-providers.service-provider-workspace"
    assert.deepEqual(keysOf(viewableModules(everything, SERVER_MODULES)), SERVER_MODULE_KEYS.filter((key) => key !== team))
    assert.deepEqual(keysOf(MODULES_WITHOUT_ME), SERVER_MODULE_KEYS.filter((key) => key !== team))
    // An Operations Manager views the providers' workspace and not the accounts: the team is never asked for.
    assert.equal(keysOf(viewableModules(systemRole("operations-manager").grants, SERVER_MODULES)).includes(team), false)
    assert.equal(keysOf(viewableModules(systemRole("service-provider-manager").grants, SERVER_MODULES, { provider: true })).includes(team), true)
  })

  test("are exactly the ones viewed, for a role between the two", () => {
    const grants: Grants = [
      { moduleKey: "configure.areas", actions: ["view", "edit"] },
      { moduleKey: "customers.contacts", actions: ["view"] },
      { moduleKey: "operate.driver-app", actions: ["view", "edit"] },
    ]
    assert.deepEqual(keysOf(viewableModules(grants, SERVER_MODULES)), ["customers.contacts", "configure.areas"])
  })

  test("take the ticket teams and types under the tickets' grant too, as the API reads them (#545 of #544): a Dispatcher picks a type and fills in its fields", () => {
    assert.deepEqual(keysOf(viewableModules([{ moduleKey: "operate.tickets", actions: ["view", "edit"] }], SERVER_MODULES)), ["configure.templates", "operate.tickets"])
    const dispatcher = keysOf(viewableModules(systemRole("dispatcher").grants, SERVER_MODULES))
    assert.ok(dispatcher.includes("configure.templates"), "the seeded Dispatcher, who works tickets and keeps no type")
    assert.deepEqual(
      SERVER_MODULES.filter((module) => module.alsoViewedUnder !== undefined).map((module) => [moduleKeyOf(module.workspaceId, module.moduleId), module.alsoViewedUnder]),
      [["configure.templates", ["operate.tickets"]]],
    )
  })

  test("are none for an empty grants list, or a grant that allows nothing", () => {
    assert.deepEqual(viewableModules([], SERVER_MODULES), [])
    assert.deepEqual(viewableModules([{ moduleKey: "configure.master", actions: [] }], SERVER_MODULES), [])
  })
})
