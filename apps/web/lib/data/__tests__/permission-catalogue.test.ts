// The permission matrix has two halves that must stay one catalogue: the web
// derives its rows from `businessWorkspaces`, and @waste/domain/access/modules
// spells the same keys as the vocabulary the API checks and the database
// stores (Issue #70). Neither can see the other's source, so this test holds
// them equal in both directions: a module added to a workspace fails here
// until the vocabulary names it, and a key named there that no workspace
// carries fails here too.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"
import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import {
  defaultAccessForRole,
  rolePermissionSections,
  ROLE_PERMISSION_ACTIONS,
} from "../role-permissions"

const webKeys = rolePermissionSections.flatMap((section) => section.items.map((item) => item.key))

describe("the permission catalogue", () => {
  test("every row of the web's matrix is a module key of the vocabulary", () => {
    const vocabulary = new Set<string>(MODULE_KEYS)
    const missing = webKeys.filter((key) => !vocabulary.has(key))
    assert.deepEqual(missing, [], `name these in @waste/domain/access/modules: ${missing.join(", ")}`)
  })

  test("every module key of the vocabulary is a row of the web's matrix", () => {
    const rows = new Set(webKeys)
    const orphans = MODULE_KEYS.filter((key) => !rows.has(key))
    assert.deepEqual(orphans, [], `no workspace carries these modules any more: ${orphans.join(", ")}`)
  })

  test("the matrix names each row once, and the two lists are the same size", () => {
    assert.equal(new Set(webKeys).size, webKeys.length)
    assert.equal(webKeys.length, MODULE_KEYS.length)
  })

  test("the actions are the vocabulary's, in the same order", () => {
    assert.deepEqual([...ROLE_PERMISSION_ACTIONS], [...ACTIONS])
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
    for (const key of webKeys) assert.deepEqual(access[key], [...ROLE_PERMISSION_ACTIONS], key)
  })

  test("a custom role, or an id no seeded role carries, starts with nothing; the map handed back is the caller's own", () => {
    assert.deepEqual(defaultAccessForRole("role-weekend-supervisor"), {})
    const first = defaultAccessForRole("role-driver")
    first["operate.driver-app"] = []
    assert.deepEqual(defaultAccessForRole("role-driver")["operate.driver-app"], ["view", "edit"])
  })
})
