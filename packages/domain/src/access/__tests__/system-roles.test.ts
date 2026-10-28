import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { normaliseGrants } from "../grants"
import { ACTIONS, MODULE_KEYS } from "../modules"
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, systemRoleKept, systemRoleScopeKept } from "../system-roles"

describe("the seeded system roles", () => {
  test("the eleven roles of the spec and the Site attendant (M4 of #293), in order, each with its copy and system true", () => {
    assert.deepEqual(
      SYSTEM_ROLES.map((role) => role.key),
      [...SYSTEM_ROLE_KEYS],
    )
    assert.equal(SYSTEM_ROLES.length, 12)
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

  test("Customer Service reads the catalogue it sells from: the products a subscription names and the price lists an agreement is priced under, to view and nothing more (#291)", () => {
    const service = SYSTEM_ROLES.find((role) => role.key === "customer-service")
    assert.ok(service)
    const actionsOn = (moduleKey: string) => service.grants.find((grant) => grant.moduleKey === moduleKey)?.actions
    assert.deepEqual(actionsOn("commercial.products"), ["view"])
    assert.deepEqual(actionsOn("commercial.price-rows"), ["view"])
    assert.deepEqual(actionsOn("commercial.invoices"), ["view"])
    assert.equal(actionsOn("commercial.events"), undefined, "the money the work makes stays Finance's")
    assert.deepEqual(actionsOn("customers.agreements"), ["view", "edit", "create"])
  })

  test("Customer Service keeps the Sorting Guide's items (#293): view, edit and create, and no delete since an item is withdrawn; it reads the projects and fractions the pane names, and publishing the project stays the administrator's", () => {
    const service = SYSTEM_ROLES.find((role) => role.key === "customer-service")
    assert.ok(service)
    const actionsOn = (moduleKey: string) => service.grants.find((grant) => grant.moduleKey === moduleKey)?.actions
    assert.deepEqual(actionsOn("configure.sorting-guide"), ["view", "edit", "create"])
    assert.deepEqual(actionsOn("configure.organization"), ["view"], "the projects a guide is kept for, read: a project's public slug is the organisation's edit")
    assert.deepEqual(actionsOn("configure.master"), ["view"], "the fractions an item names, read")
    const holders = SYSTEM_ROLES.filter((role) => role.grants.some((grant) => grant.moduleKey === "configure.sorting-guide")).map((role) => role.key)
    assert.deepEqual(holders, ["company-administrator", "customer-service"])
  })

  test("Customer Service reads the stops a ticket is about (M6 of #293): view on the stops, whose photos are the evidence a missed-collection dispute is answered with, and nothing else of Route Studio", () => {
    const service = SYSTEM_ROLES.find((role) => role.key === "customer-service")
    assert.ok(service)
    const routeStudio = service.grants.filter((grant) => grant.moduleKey.startsWith("route-studio."))
    assert.deepEqual(
      routeStudio.map((grant) => [grant.moduleKey, grant.actions]),
      [["route-studio.pickups", ["view"]]],
    )
  })

  test("the Drop-off Points (#293, M3) are a place the operation runs: the resources workspace's roles hold them as they hold the depots, and Customer Service keeps them beside the guide", () => {
    const actionsOn = (key: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === "resources.drop-off-points")?.actions
    const depotsOn = (key: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === "resources.depots")?.actions
    const holders = SYSTEM_ROLES.filter((role) => actionsOn(role.key) !== undefined).map((role) => role.key)
    for (const key of holders.filter((holder) => holder !== "customer-service")) assert.deepEqual(actionsOn(key), depotsOn(key), key)
    assert.deepEqual(actionsOn("customer-service"), ["view", "edit", "create"])
    assert.deepEqual(actionsOn("company-administrator"), ["view", "edit", "create", "delete"])
    assert.deepEqual(actionsOn("operations-manager"), ["view", "edit"])
  })

  test("the Applications (#293, M7) are the customers' workspace's: Customer Service receives and decides them, the administrator holds all, and the roles that view the customers read them", () => {
    const actionsOn = (key: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === "customers.applications")?.actions
    assert.deepEqual(actionsOn("customer-service"), ["view", "edit", "create"])
    assert.deepEqual(actionsOn("company-administrator"), ["view", "edit", "create", "delete"])
    for (const key of ["operations-manager", "dispatcher", "route-planner", "finance-specialist"]) assert.deepEqual(actionsOn(key), ["view"], key)
    for (const key of ["service-provider-manager", "service-provider-foreman", "driver", "integration-writer"]) assert.equal(actionsOn(key), undefined, key)
  })

  test("the Service Provider Activities (#474) are opened by both sides' managers and decided by the office: the Operations Manager and the provider's manager create, the foreman reads", () => {
    const actionsOn = (key: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === "service-providers.activities")?.actions
    assert.deepEqual(actionsOn("company-administrator"), ["view", "edit", "create", "delete"])
    for (const key of ["operations-manager", "service-provider-manager"]) assert.deepEqual(actionsOn(key), ["view", "edit", "create"], key)
    for (const key of ["service-provider-foreman", "finance-specialist"]) assert.deepEqual(actionsOn(key), ["view"], key)
  })

  test("every office role that may move a route may make one: edit on route-studio.routes comes with create, the ad-hoc route being a dispatcher's daily job (#111); the provider's manager crews the routes it runs and makes none (#291 slice 23b)", () => {
    const routes = (key: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === "route-studio.routes")?.actions ?? []
    const editors = SYSTEM_ROLES.filter((role) => routes(role.key).includes("edit")).map((role) => role.key)
    assert.deepEqual(editors, ["company-administrator", "operations-manager", "dispatcher", "route-planner", "service-provider-manager"])
    for (const key of editors.filter((editor) => editor !== "service-provider-manager")) assert.ok(routes(key).includes("create"), key)
    assert.deepEqual([...routes("dispatcher")], ["view", "edit", "create"], "and nothing more: a dispatcher deletes no route")
    // `edit` reaches `assign` and `dispatch` alone from a provider's account (apps/api/src/routes/routes.ts); an ad-hoc route names a project, and a provider works in none.
    assert.deepEqual([...routes("service-provider-manager")], ["view", "edit"])
    assert.deepEqual([...routes("service-provider-foreman")], ["view"], "the foreman reads the routes and crews none")
  })

  test("a system role's scope and permissions are its charter's, which every seed restores: each sentence names the role, as the tenant calls it, and the way out (#291)", () => {
    assert.equal(systemRoleKept("Disponent"), "Disponent is a system role, whose permissions every seed restores to its charter; make a custom role to allow something else")
    assert.equal(systemRoleScopeKept("Disponent"), "Disponent is a system role, whose scope every seed restores to its charter; make a custom role for another scope")
  })

  test("a hand-spelled role carries exactly its own modules: the driver's one, the driver door (#179)", () => {
    const driver = SYSTEM_ROLES.find((role) => role.key === "driver")
    assert.ok(driver)
    assert.deepEqual(
      driver.grants.map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] })),
      [{ moduleKey: "operate.driver-app", actions: ["view", "edit"] }],
    )
  })

  test("the Site attendant (M4 of #293) checks visitors in and reads the ledger and the register, and nothing else", () => {
    const attendant = SYSTEM_ROLES.find((role) => role.key === "site-attendant")
    assert.ok(attendant)
    assert.deepEqual(
      attendant.grants.map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] })),
      [
        { moduleKey: "customers.site-access", actions: ["view"] },
        { moduleKey: "operate.site-visits", actions: ["view", "create"] },
      ],
    )
  })

  test("the recycling centres' visits and register (M4 of #293) go to the office's roles and never to a Service Provider's", () => {
    const actionsOn = (key: string, moduleKey: string) => SYSTEM_ROLES.find((role) => role.key === key)?.grants.find((grant) => grant.moduleKey === moduleKey)?.actions
    for (const moduleKey of ["operate.site-visits", "customers.site-access"]) {
      for (const key of ["service-provider-manager", "service-provider-foreman", "driver", "integration-writer"]) assert.equal(actionsOn(key, moduleKey), undefined, `${key} on ${moduleKey}`)
      assert.deepEqual(actionsOn("company-administrator", moduleKey), ["view", "edit", "create", "delete"])
    }
    assert.deepEqual(actionsOn("customer-service", "customers.site-access"), ["view", "edit", "create"])
    assert.deepEqual(actionsOn("dispatcher", "operate.site-visits"), ["view", "edit", "create"])
  })
})
