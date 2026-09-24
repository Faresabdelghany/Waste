// The vocabulary is the one list the API, the seed and the prototype's
// permission matrix agree on, so it is held to its shape here and to the web's
// catalogue by apps/web/lib/data/__tests__/permission-catalogue.test.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ACTIONS, MODULE_KEYS, WORKSPACE_KEYS, modulesOf } from "../modules"

describe("the module vocabulary", () => {
  test("every key is one workspace and one module, lowercase, and named once", () => {
    for (const key of MODULE_KEYS) {
      assert.match(key, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, `${key} is not a workspace.module key`)
    }
    assert.equal(new Set(MODULE_KEYS).size, MODULE_KEYS.length, "a module key is spelled twice")
  })

  test("the workspaces are the prototype's ten, in sidebar order; the standalone control centre is not one of them", () => {
    assert.deepEqual(
      [...WORKSPACE_KEYS],
      ["operate", "plan", "route-studio", "fleet", "customers", "resources", "service-providers", "commercial", "improve", "configure"],
    )
    assert.deepEqual([...new Set(MODULE_KEYS.map((key) => key.split(".")[0]))], [...WORKSPACE_KEYS])
    // Configure carries the Control Center module; the workspace of the same
    // name is a route alias and has no row of its own.
    assert.ok(MODULE_KEYS.includes("configure.control-center"))
  })

  test("every workspace has at least one module, and modulesOf reads exactly its own", () => {
    for (const workspace of WORKSPACE_KEYS) {
      const modules = modulesOf(workspace)
      assert.ok(modules.length > 0, `${workspace} has no modules`)
      assert.ok(
        modules.every((key) => key.startsWith(`${workspace}.`)),
        `modulesOf(${workspace}) reached another workspace`,
      )
      assert.deepEqual(modules, MODULE_KEYS.filter((key) => key.startsWith(`${workspace}.`)))
    }
  })

  test("the four actions, in the order a grant lists them", () => {
    assert.deepEqual([...ACTIONS], ["view", "edit", "create", "delete"])
  })
})
