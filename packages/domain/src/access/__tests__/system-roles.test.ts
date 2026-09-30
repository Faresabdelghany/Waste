import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { normaliseGrants } from "../grants"
import { ACTIONS, MODULE_KEYS } from "../modules"
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "../system-roles"

describe("the seeded system roles", () => {
  test("the eleven roles of the spec, in order, each with its copy and system true", () => {
    assert.deepEqual(
      SYSTEM_ROLES.map((role) => role.key),
      [...SYSTEM_ROLE_KEYS],
    )
    assert.equal(SYSTEM_ROLES.length, 11)
    for (const role of SYSTEM_ROLES) {
      assert.ok(role.name.length > 0, `${role.key} has no name`)
      assert.ok(role.scope.length > 0, `${role.key} has no scope`)
      assert.ok(role.description.length > 0, `${role.key} has no description`)
      assert.equal(role.system, true)
      assert.ok(role.grants.length > 0, `${role.key} grants nothing`)
    }
    assert.equal(new Set(SYSTEM_ROLES.map((role) => role.name)).size, SYSTEM_ROLES.length, "two roles share a name")
  })

  test("every default grant names a known module key and known actions, once", () => {
    const keys = new Set<string>(MODULE_KEYS)
    const actions = new Set<string>(ACTIONS)
    for (const role of SYSTEM_ROLES) {
      const seen = new Set<string>()
      for (const grant of role.grants) {
        assert.ok(keys.has(grant.moduleKey), `${role.key} grants on the unknown module ${grant.moduleKey}`)
        assert.ok(!seen.has(grant.moduleKey), `${role.key} names ${grant.moduleKey} twice`)
        seen.add(grant.moduleKey)
        assert.ok(grant.actions.length > 0, `${role.key} grants no action on ${grant.moduleKey}`)
        for (const action of grant.actions) {
          assert.ok(actions.has(action), `${role.key} grants the unknown action ${action} on ${grant.moduleKey}`)
        }
      }
    }
  })

  test("every role's grants are already normalised: view where anything is granted, in order, sorted", () => {
    for (const role of SYSTEM_ROLES) {
      assert.deepEqual(normaliseGrants(role.grants), role.grants.map((grant) => ({ ...grant, actions: [...grant.actions] })), role.key)
    }
  })

  test("the Company Administrator may do everything on every module", () => {
    const administrator = SYSTEM_ROLES.find((role) => role.key === "company-administrator")
    assert.ok(administrator)
    assert.deepEqual(
      administrator.grants.map((grant) => grant.moduleKey),
      [...MODULE_KEYS].sort(),
    )
    for (const grant of administrator.grants) assert.deepEqual([...grant.actions], [...ACTIONS])
  })

  test("a hand-spelled role carries exactly its own modules: the driver's one, the driver door (#179)", () => {
    const driver = SYSTEM_ROLES.find((role) => role.key === "driver")
    assert.ok(driver)
    assert.deepEqual(
      driver.grants.map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] })),
      [{ moduleKey: "operate.driver-app", actions: ["view", "edit"] }],
    )
  })
})
