// What an account may do, read off `/me`'s grants on the Pilot and off its
// persona's seeded role in fixture mode: the one reading every shell, the
// record store and the workspace's actions share.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"

import { accountGrants, allows, mayOn, viewedModules, type Grants } from "../grants"

const charter = (key: SystemRoleKey): Grants => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === key)
  if (role === undefined) throw new Error(`no system role ${key}`)
  return role.grants
}

const meOf = (grants: Grants) => ({ role: { grants } })

describe("the grants", () => {
  test("allow an action on a module only where they name both; nothing without grants", () => {
    const grants: Grants = [{ moduleKey: "customers.contacts", actions: ["view", "edit"] }]
    assert.equal(allows(grants, "customers.contacts", "edit"), true)
    assert.equal(allows(grants, "customers.contacts", "create"), false)
    assert.equal(allows(grants, "customers.properties", "view"), false)
    assert.equal(allows(undefined, "customers.contacts", "view"), false)
  })

  test("view the modules they grant `view` on", () => {
    assert.deepEqual([...viewedModules([{ moduleKey: "improve.performance", actions: ["view"] }, { moduleKey: "improve.analytics", actions: [] }])], ["improve.performance"])
    assert.equal(viewedModules(undefined).size, 0)
  })
})

describe("the account signed in", () => {
  test("in fixture mode, the office is held back by nothing", () => {
    const grants = accountGrants({ apiConfigured: false, me: null })
    assert.equal(grants, null)
    assert.equal(mayOn(grants, "configure.access", "delete"), true)
  })

  test("in fixture mode, a persona works under its seeded role's charter", () => {
    const grants = accountGrants({ apiConfigured: false, me: null, fixtureRole: "service-provider-manager" })
    assert.deepEqual(grants, charter("service-provider-manager"))
    assert.equal(mayOn(grants, "operate.tickets", "create"), true)
    assert.equal(mayOn(grants, "operate.tickets", "edit"), false)
  })

  test("on the Pilot, a provider's account works under /me's grants, whatever its persona's charter", () => {
    const grants: Grants = [{ moduleKey: "route-studio.routes", actions: ["view"] }]
    assert.equal(accountGrants({ apiConfigured: true, me: meOf(grants), fixtureRole: "service-provider-manager" }), grants)
  })

  test("on the Pilot, the office's account works under /me's grants: a role that views the customers and edits none is offered no edit and no create there", () => {
    const grants = accountGrants({ apiConfigured: true, me: meOf(charter("route-planner")) })
    assert.deepEqual(grants, charter("route-planner"))
    assert.equal(mayOn(grants, "customers.contacts", "view"), true)
    assert.equal(mayOn(grants, "customers.contacts", "edit"), false)
    assert.equal(mayOn(grants, "customers.contacts", "create"), false)
    assert.equal(mayOn(grants, "configure.organization", "view"), false)
  })

  test("on the Pilot, before /me answers, nothing is held back: the API refuses what the role does not allow", () => {
    assert.equal(accountGrants({ apiConfigured: true, me: null }), null)
    assert.equal(accountGrants({ apiConfigured: true, me: null, fixtureRole: "service-provider-manager" }), null)
  })
})
