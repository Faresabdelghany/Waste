// The Command Queue's storage (Issue #145), over fake-indexeddb's factory: one
// database per origin with two stores, the installation id minted once and
// the queue keyed by it, each command a row of its own read back in the
// order its id gives.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IDBFactory } from "fake-indexeddb"

import { openCommandQueue, type QueueEntry } from "../command-queue"

const entry = (deviceId: string, id: string, overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  owner: "driver-login",
  state: "ready",
  command: { id, kind: "pause", routeId: "route-1", occurredAt: "2027-01-15T08:00:00.000Z", deviceId, body: {} },
  ...overrides,
})

describe("the installation id", () => {
  test("is minted once as web-<uuid> and read back on every later open", async () => {
    const factory = new IDBFactory()
    const first = await openCommandQueue(factory)
    assert.match(first.deviceId, /^web-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    first.close()
    const second = await openCommandQueue(factory, { mintDeviceId: () => "web-never-used" })
    assert.equal(second.deviceId, first.deviceId)
    second.close()
  })

  test("is a new device's once the site's data is cleared", async () => {
    const before = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-before" })
    const after = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-after" })
    assert.equal(before.deviceId, "web-before")
    assert.equal(after.deviceId, "web-after")
  })
})

describe("the queue", () => {
  test("keeps each command as its own row and lists them by id, whatever order they were written in", async () => {
    const queue = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-a" })
    await queue.put(entry("web-a", "0190-b"))
    await queue.put(entry("web-a", "0190-a"))
    await queue.put(entry("web-a", "0190-c"))
    assert.deepEqual(
      (await queue.list()).map((row) => row.command.id),
      ["0190-a", "0190-b", "0190-c"],
    )
  })

  test("rewrites a row in place when the same command is put again", async () => {
    const queue = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-a" })
    await queue.put(entry("web-a", "0190-a", { state: "location-pending" }))
    await queue.put(entry("web-a", "0190-a", { state: "ready" }))
    assert.deepEqual(
      (await queue.list()).map((row) => [row.command.id, row.state]),
      [["0190-a", "ready"]],
    )
  })

  test("removes answered commands by id and leaves the rest", async () => {
    const queue = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-a" })
    for (const id of ["0190-a", "0190-b", "0190-c"]) await queue.put(entry("web-a", id))
    await queue.remove(["0190-a", "0190-c"])
    assert.deepEqual(
      (await queue.list()).map((row) => row.command.id),
      ["0190-b"],
    )
  })

  test("survives the page: a reopened database holds what the last one wrote", async () => {
    const factory = new IDBFactory()
    const before = await openCommandQueue(factory)
    await before.put(entry(before.deviceId, "0190-a", { state: "location-pending" }))
    before.close()
    const after = await openCommandQueue(factory)
    assert.deepEqual(await after.list(), [entry(before.deviceId, "0190-a", { state: "location-pending" })])
  })

  test("lists only this installation's rows", async () => {
    const queue = await openCommandQueue(new IDBFactory(), { mintDeviceId: () => "web-a" })
    await queue.put(entry("web-a", "0190-a"))
    await queue.put(entry("web-other", "0190-b"))
    assert.deepEqual(
      (await queue.list()).map((row) => row.command.id),
      ["0190-a"],
    )
  })
})
