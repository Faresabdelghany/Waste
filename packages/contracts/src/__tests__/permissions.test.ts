import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"

import { Action, Grant, ModuleKey } from "../permissions"

describe("ModuleKey", () => {
  test("the vocabulary is the domain's, whole and in order", () => {
    assert.deepEqual(ModuleKey.options, [...MODULE_KEYS])
  })

  test("a known key parses; anything else is refused", () => {
    assert.equal(ModuleKey.parse("configure.access"), "configure.access")
    assert.equal(ModuleKey.safeParse("configure.nothing").success, false)
    assert.equal(ModuleKey.safeParse("configure").success, false)
    assert.equal(ModuleKey.safeParse("Configure.Access").success, false)
    assert.equal(ModuleKey.safeParse("").success, false)
    assert.equal(ModuleKey.safeParse(null).success, false)
  })
})

describe("Action", () => {
  test("the four actions, and nothing else", () => {
    assert.deepEqual(Action.options, [...ACTIONS])
    for (const action of ACTIONS) assert.equal(Action.parse(action), action)
    assert.equal(Action.safeParse("approve").success, false)
    assert.equal(Action.safeParse("View").success, false)
  })
})

describe("Grant", () => {
  test("a module key and the actions allowed on it", () => {
    assert.deepEqual(Grant.parse({ moduleKey: "fleet.vehicles", actions: ["view", "edit"] }), {
      moduleKey: "fleet.vehicles",
      actions: ["view", "edit"],
    })
    // No actions is a row the API may keep or drop (@waste/domain/access/grants
    // drops it); the wire shape does not decide that.
    assert.deepEqual(Grant.parse({ moduleKey: "fleet.vehicles", actions: [] }).actions, [])
  })

  test("an unknown module, an unknown action, a missing member or an extra one is refused", () => {
    assert.equal(Grant.safeParse({ moduleKey: "fleet.spaceships", actions: ["view"] }).success, false)
    assert.equal(Grant.safeParse({ moduleKey: "fleet.vehicles", actions: ["approve"] }).success, false)
    assert.equal(Grant.safeParse({ moduleKey: "fleet.vehicles" }).success, false)
    assert.equal(Grant.safeParse({ actions: ["view"] }).success, false)
    assert.deepEqual(Grant.parse({ moduleKey: "fleet.vehicles", actions: ["view"], colour: "blue" }), {
      moduleKey: "fleet.vehicles",
      actions: ["view"],
    })
  })
})
