// The permission matrix: a row per module key of @waste/domain/access/modules,
// the vocabulary the API checks and the database stores (Issue #70), read off
// the module manifest (lib/modules) by workspace, and the grants each seeded
// role starts with.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"
import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import {
  defaultAccessForRole,
  rolePermissionSections,
} from "../role-permissions"

const webKeys = rolePermissionSections.flatMap((section) => section.items.map((item) => item.key))

describe("the permission catalogue", () => {
  test("is a row for each module key of the vocabulary, once, under its workspace", () => {
    assert.deepEqual([...webKeys].sort(), [...MODULE_KEYS].sort())
    for (const section of rolePermissionSections) {
      for (const item of section.items) assert.ok(item.key.startsWith(`${section.id}.`), item.key)
    }
  })
})

describe("the seeded defaults the matrix starts from", () => {
  test("each system role's grants arrive under its fixture role id", () => {
    for (const role of SYSTEM_ROLES) {
      const access = defaultAccessForRole(`role-${role.key}`)
      assert.deepEqual(
        Object.keys(access).sort(),
        role.grants.map((grant) => grant.moduleKey),
        role.key,
      )
      for (const grant of role.grants) assert.deepEqual(access[grant.moduleKey], [...grant.actions], `${role.key} ${grant.moduleKey}`)
    }
  })

  test("the Company Administrator starts with every row of the matrix granted", () => {
    const access = defaultAccessForRole("role-company-administrator")
    assert.deepEqual(Object.keys(access).sort(), [...webKeys].sort())
    for (const key of webKeys) assert.deepEqual(access[key], [...ACTIONS], key)
  })

  test("a custom role, or an id no seeded role carries, starts with nothing; the map handed back is the caller's own", () => {
    assert.deepEqual(defaultAccessForRole("role-weekend-supervisor"), {})
    const first = defaultAccessForRole("role-driver")
    first["operate.driver-app"] = []
    assert.deepEqual(defaultAccessForRole("role-driver")["operate.driver-app"], ["view", "edit"])
  })
})
