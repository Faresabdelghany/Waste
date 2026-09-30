// The command surfaces (Issue #181): how a switched module is operated on the
// Pilot beyond its own create and edit forms — a dialog standing in for its
// primary action, its rows' commands in their details. The workspace
// consults one registry for them, and only with the adapter configured, so
// fixture mode never reaches it and a module that is not switched has none.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { COMMAND_SURFACES, commandSurfaceFor } from "@/components/waste/commands/command-surfaces"

import { moduleKeyOf } from "../records/adapter"
import { SERVER_MODULE_KEYS } from "../records/modules"

describe("the command surfaces", () => {
  test("name only switched modules", () => {
    for (const key of Object.keys(COMMAND_SURFACES)) assert.ok(SERVER_MODULE_KEYS.includes(key), `${key} is not in SERVER_MODULES`)
  })

  test("are nobody's in fixture mode, nor a module the API does not back", () => {
    for (const key of Object.keys(COMMAND_SURFACES)) {
      const [workspaceId, moduleId] = key.split(".") as [Parameters<typeof moduleKeyOf>[0], string]
      assert.equal(commandSurfaceFor(workspaceId, moduleId, false), undefined, `${key} offers its surface without the adapter`)
      assert.equal(commandSurfaceFor(workspaceId, moduleId, true), COMMAND_SURFACES[key])
    }
    assert.equal(commandSurfaceFor("improve", "insights", true), undefined)
  })
})
