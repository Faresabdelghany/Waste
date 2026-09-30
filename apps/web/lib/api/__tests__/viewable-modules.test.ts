// Which switched modules the record store reads for a person (Issue #145, the
// rule the Driver App's browser pass asked for): those whose key the
// person's `/me` role grants `view` on, in SERVER_MODULES' load order. A
// module the grants do not cover is never requested, so a driver on the
// Driver App sees no refusal for an office pane they will never open.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import { moduleKeyOf } from "../records/adapter"
import { SERVER_MODULE_KEYS, SERVER_MODULES, viewableModules } from "../records/modules"

const keysOf = (modules: ReturnType<typeof viewableModules>) => modules.map((module) => moduleKeyOf(module.workspaceId, module.moduleId))
const systemRole = (key: string) => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === key)
  if (role === undefined) throw new Error(`no system role ${key}`)
  return role
}

describe("the switched modules a person's grants let the store read", () => {
  test("are none of them for the seeded driver, configure.master and configure.calendars included", () => {
    assert.deepEqual(keysOf(viewableModules(systemRole("driver").grants, SERVER_MODULES)), [])
  })

  test("are all of them, in SERVER_MODULES' order, for a role that views everything, however its grants are listed", () => {
    const everything = [...SERVER_MODULE_KEYS].reverse().map((moduleKey) => ({ moduleKey, actions: ["view"] as const }))
    assert.deepEqual(keysOf(viewableModules(everything, SERVER_MODULES)), [...SERVER_MODULE_KEYS])
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
