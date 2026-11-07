// The module manifest: one spec per module of the domain's `MODULE_KEYS`,
// and the registries read off it — the workspaces' pages, the Settings panes,
// the provider's pages.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MODULE_KEYS, WORKSPACE_KEYS } from "@waste/domain/access/modules"

import { CONTROL_CENTER, MODULES, WORKSPACES, moduleAt, moduleSpecOf, pageModuleIds } from "../manifest"
import { PROVIDER_PAGES, PROVIDER_WORKSPACE_PATH } from "../provider-pages"

describe("the module manifest", () => {
  test("specifies exactly the domain's modules, each once", () => {
    assert.deepEqual(Object.keys(MODULES).sort(), [...MODULE_KEYS].sort())
    const spelled = WORKSPACE_KEYS.flatMap((workspaceId) => Object.keys(WORKSPACES[workspaceId].modules).map((moduleId) => `${workspaceId}.${moduleId}`))
    assert.equal(spelled.length, MODULE_KEYS.length)
  })

  test("holds the domain's workspaces in its order, and Control Center's twin last, Configure's module under its own key", () => {
    assert.deepEqual(Object.keys(WORKSPACES), [...WORKSPACE_KEYS, CONTROL_CENTER])
    const twin = WORKSPACES[CONTROL_CENTER].modules[CONTROL_CENTER]
    assert.equal(twin.label, MODULES["configure.control-center"].label)
    assert.equal(twin.shown, "tab")
    assert.equal(twin.form, undefined, "the registry keeps Control Center's form under the twin")
    assert.equal(MODULES["configure.control-center"].form, false)
  })

  test("names a module by its key", () => {
    assert.deepEqual(moduleAt("route-studio.routes"), { workspaceId: "route-studio", moduleId: "routes" })
    assert.deepEqual(moduleAt("service-providers.service-provider-workspace"), { workspaceId: "service-providers", moduleId: "service-provider-workspace" })
    assert.equal(moduleSpecOf(moduleAt("operate.tickets")), MODULES["operate.tickets"])
    assert.equal(moduleSpecOf({ workspaceId: "operate", moduleId: "routes" }), undefined, "the routes are Route Studio's")
  })

  test("places every Configure module in Settings, but Control Center, which is shown elsewhere", () => {
    for (const [moduleId, spec] of Object.entries(WORKSPACES.configure.modules)) {
      if (moduleId === CONTROL_CENTER) assert.equal(spec.shown, "elsewhere")
      else assert.equal(typeof spec.shown, "object", moduleId)
    }
    for (const [key, spec] of Object.entries(MODULES)) {
      if (typeof spec.shown === "object") assert.ok(key.startsWith("configure."), `${key} is in Settings but not Configure's`)
    }
  })

  test("gives a module shown elsewhere the surface it opens", () => {
    const elsewhere = Object.entries(MODULES).filter(([, spec]) => spec.shown === "elsewhere")
    assert.deepEqual(elsewhere.map(([key, spec]) => [key, spec.deepLink]), [
      ["operate.driver-app", "/driver"],
      ["customers.citizen-portal", "/portal"],
      ["service-providers.service-provider-workspace", "/service-provider-workspace"],
      ["configure.control-center", "/control-center"],
    ])
  })
})

describe("a workspace's page", () => {
  test("shows its tabs and its More, in the manifest's order, and nothing shown elsewhere", () => {
    assert.deepEqual(pageModuleIds("operate"), ["tickets", "bulky-bookings", "exceptions", "site-visits", "scale-house", "inspections"])
    assert.deepEqual(pageModuleIds("customers"), ["properties", "groups", "shared", "contacts", "agreements", "applications", "site-access", "right-sizing"])
    assert.deepEqual(pageModuleIds("service-providers"), ["service-providers", "service-areas", "activities"])
    assert.deepEqual(pageModuleIds("route-studio"), Object.keys(WORKSPACES["route-studio"].modules), "every Route Studio module is on its page")
  })

  test("has a path, but Configure, whose modules are Settings'", () => {
    for (const workspaceId of Object.keys(WORKSPACES) as (keyof typeof WORKSPACES)[]) {
      if (workspaceId === "configure") assert.equal(WORKSPACES[workspaceId].path, undefined)
      else assert.match(WORKSPACES[workspaceId].path, /^\/[a-z-]+$/, workspaceId)
    }
  })
})

describe("the provider's workspace", () => {
  test("is its pages in its sidebar's order, each the modules the manifest places on it, of one workspace", () => {
    assert.deepEqual(
      PROVIDER_PAGES.map((page) => [page.path, page.workspaceId, page.moduleIds]),
      [
        [`${PROVIDER_WORKSPACE_PATH}/routes`, "route-studio", ["routes", "pickups"]],
        [`${PROVIDER_WORKSPACE_PATH}/fleet`, "fleet", ["vehicles", "drivers"]],
        [`${PROVIDER_WORKSPACE_PATH}/tickets`, "operate", ["tickets"]],
        [`${PROVIDER_WORKSPACE_PATH}/activities`, "service-providers", ["activities"]],
        [`${PROVIDER_WORKSPACE_PATH}/team`, "service-providers", ["service-provider-workspace"]],
      ],
    )
    for (const page of PROVIDER_PAGES) {
      for (const moduleId of page.moduleIds) assert.equal(moduleSpecOf({ workspaceId: page.workspaceId, moduleId })?.providerPage, page.id, `${page.id}: ${moduleId}`)
    }
  })
})
