// Where a module opens: each workspace's path and the `?module=` / `?record=`
// the workspace reads, a restricted shell's page in place of the workspace's,
// Settings' modules on their pane and the Driver App on its own surface.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { workspaceHref } from "../workspace-href"

describe("workspaceHref", () => {
  test("opens a module on its workspace's page, and a record in it", () => {
    assert.equal(workspaceHref({ workspaceId: "route-studio", moduleId: "routes" }), "/route-studio?module=routes")
    assert.equal(workspaceHref({ workspaceId: "route-studio", moduleId: "routes" }, "route-1"), "/route-studio?module=routes&record=route-1")
    assert.equal(workspaceHref({ workspaceId: "operate", moduleId: "tickets" }, "ticket-1"), "/tickets?module=tickets&record=ticket-1")
  })

  test("opens it on a restricted shell's own page where one is named", () => {
    assert.equal(workspaceHref({ workspaceId: "route-studio", moduleId: "routes" }, "route-1", { page: "/service-provider-workspace/routes" }), "/service-provider-workspace/routes?module=routes&record=route-1")
  })

  test("opens the Driver App on its own surface, and a Settings module on its pane", () => {
    assert.equal(workspaceHref({ workspaceId: "operate", moduleId: "driver-app" }), "/driver")
    assert.equal(workspaceHref({ workspaceId: "configure", moduleId: "areas" }, "area-1"), "/settings?pane=areas&record=area-1")
  })
})
