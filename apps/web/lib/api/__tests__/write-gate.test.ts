// When the workspace's own writes go out on the Pilot (#239, #210): a generic
// form's create or edit and a governed action write at once in fixture mode
// and to a module on fixtures; to a switched module only once the API has
// read it, since before that the store would keep the write in the browser,
// which a switched module never shows. A refused gate keeps the dialog open
// and says why.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { loaded, loadFailed, loading, type ModuleState } from "../records/server-records"
import { writeGate } from "../records/write-gate"

const idle: ModuleState = { status: "idle", records: [], serverIds: new Map(), problem: null, loadedAt: null }
const ready = loaded({ records: [], serverIds: new Map() }, 1)

describe("the workspace's write gate", () => {
  test("lets every write out in fixture mode and to a module on fixtures", () => {
    assert.deepEqual(writeGate(false, idle, "Service Providers", "the form can be saved"), { kind: "write" })
    assert.deepEqual(writeGate(true, null, "Service Providers", "the form can be saved"), { kind: "write" })
  })

  test("lets a write out to a switched module the API has read", () => {
    assert.deepEqual(writeGate(true, ready, "Service Providers", "the form can be saved"), { kind: "write" })
    assert.deepEqual(writeGate(true, loading(ready), "Service Providers", "the form can be saved"), { kind: "write" }, "read again, it is still read")
  })

  test("holds a write to a switched module still loading or whose load failed, and says when it can go", () => {
    for (const state of [idle, loading(idle), loadFailed(idle, { type: "about:blank", title: "Unavailable", status: 503 })]) {
      assert.deepEqual(writeGate(true, state, "Service Providers", "the form can be saved"), {
        kind: "held",
        description: "Service Providers are not read from the API yet; the form can be saved once they are.",
      }, state.status)
    }
  })
})
