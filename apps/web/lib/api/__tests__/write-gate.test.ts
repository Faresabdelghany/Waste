// When the workspace's own writes go out on the Pilot (#239, #210): a generic
// form's create or edit and a governed action write at once in fixture mode
// and to a module on fixtures; to a switched module only once the API has
// read it, since before that the store would keep the write in the browser,
// which a switched module never shows, and an edit only of a row the API
// holds, since another would go out as a create. A held write keeps its
// dialog open and says why, by the module's state. A write that throws
// instead of answering is a refusal, so the dialog waiting on it is freed.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IDLE, loaded, loadFailed, loading, type ModuleState, type WriteOutcome } from "../records/server-records"
import { answered, writeGate } from "../records/write-gate"

const ready = loaded({ records: [], serverIds: new Map([["service-provider-nordren", "01a0d2a4-a280-7003-8000-000000000001"]]) }, 1)
const form = { label: "Service Providers", when: "the form can be saved" }

describe("the workspace's write gate", () => {
  test("lets every write out in fixture mode and to a module on fixtures", () => {
    assert.deepEqual(writeGate({ ...form, apiConfigured: false, target: IDLE }), { kind: "write" })
    assert.deepEqual(writeGate({ ...form, apiConfigured: true, target: null }), { kind: "write" })
  })

  test("lets a write out to a switched module the API has read, an edit of a row it holds", () => {
    assert.deepEqual(writeGate({ ...form, apiConfigured: true, target: ready }), { kind: "write" })
    assert.deepEqual(writeGate({ ...form, apiConfigured: true, target: loading(ready) }), { kind: "write" }, "read again, it is still read")
    assert.deepEqual(writeGate({ ...form, apiConfigured: true, target: ready, editing: { id: "service-provider-nordren", name: "NordRen ApS" } }), { kind: "write" })
  })

  test("holds a write to a switched module not read yet, says when it can go, and says what a failed or ungranted read means", () => {
    const held = (target: ModuleState) => writeGate({ ...form, apiConfigured: true, target })
    for (const state of [IDLE, loading(IDLE)]) {
      assert.deepEqual(held(state), { kind: "held", description: "Service Providers is being read from the API; the form can be saved once it is." }, state.status)
    }
    assert.deepEqual(held(loadFailed(IDLE, { type: "about:blank", title: "Unavailable", status: 503 })), { kind: "held", description: "Service Providers could not be read from the API; reload the page to try again." })
    assert.deepEqual(held({ ...IDLE, status: "not-granted" }), { kind: "held", description: "Your role does not view Service Providers." })
  })

  test("holds an edit of a row the API does not hold: shown while the module loaded, it would go out as a create", () => {
    assert.deepEqual(writeGate({ ...form, apiConfigured: true, target: ready, editing: { id: "service-provider-seed-1", name: "Seed Provider" } }), {
      kind: "held",
      description: "Seed Provider is not a row the API holds; close the form and open it again from the list.",
    })
  })
})

describe("a write's answer", () => {
  test("passes an answer through, and nothing for a write on the browser's own path", async () => {
    const done: WriteOutcome = { kind: "unchanged", record: { id: "x" } as never }
    assert.equal(await answered(Promise.resolve(done), "x", () => assert.fail("no fault")), done)
    assert.equal(answered(undefined, "x", () => assert.fail("no fault")), undefined)
  })

  test("is a refusal where the write threw instead of answering, and the fault is said", async () => {
    let said = 0
    const outcome = await answered(Promise.reject(new Error("toRecord threw")), "service-provider-1", () => (said += 1))
    assert.equal(outcome?.kind, "refused")
    assert.equal(outcome?.kind === "refused" ? outcome.recordId : undefined, "service-provider-1")
    assert.equal(said, 1)
  })
})
