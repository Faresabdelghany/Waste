// The address bar's module as the workspace applies it (#177, #197):
// WorkspaceQuerySync asks again on every record-store change, and only a
// module that is news — not the one applied last — is applied, so a switched
// module landing from the API neither closes a create dialog nor clears the
// search. A tab click is a module applied, so going Back is news again.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createModuleSync } from "../module-sync"

describe("the address bar's module", () => {
  test("is applied the first time it is asked for, and not again while it stays the same", () => {
    const sync = createModuleSync()
    assert.equal(sync.apply("contacts"), true)
    assert.equal(sync.apply("contacts"), false)
    assert.equal(sync.apply("contacts"), false)
  })

  test("is applied again when the address bar names another module", () => {
    const sync = createModuleSync()
    sync.apply("contacts")
    assert.equal(sync.apply("properties"), true)
    assert.equal(sync.apply("contacts"), true)
  })

  test("counts a tab click as applied: the click's module is not applied twice, and Back to the one before it is", () => {
    const sync = createModuleSync()
    sync.apply("contacts")
    sync.record("properties")
    assert.equal(sync.apply("properties"), false, "the address bar catching up with the click changes nothing")
    assert.equal(sync.apply("contacts"), true, "Back to the module before the click switches to it")
  })
})
