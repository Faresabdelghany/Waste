// The display cache's storage (O25 of #290) over fake-indexeddb: one row per
// login, kept inside its bound, its routes those its start screen names.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IDBFactory } from "fake-indexeddb"

import { EMPTY_SNAPSHOT, kept, openReadSnapshot, SNAPSHOT_MAX_AGE_MS, type ReadSnapshot } from "../read-snapshot"
import { driverMe, NOW, route, ROUTE_ID, routeDetail } from "./driver-fixtures"

const OTHER_ROUTE = "01950000-0000-7000-8000-000000000002"
const at = (ms: number) => new Date(NOW + ms).toISOString()
const day: ReadSnapshot = {
  me: { answer: driverMe(), readAt: at(0) },
  routes: { [ROUTE_ID]: { answer: routeDetail(), readAt: at(60_000) } },
}

describe("the display cache's storage", () => {
  test("keeps each login's answers apart, and forgets one login's alone", async () => {
    const factory = new IDBFactory()
    const store = await openReadSnapshot(factory)
    await store.write("mads", day)
    assert.deepEqual(await store.read("mads", NOW), day)
    assert.deepEqual(await store.read("freja", NOW), EMPTY_SNAPSHOT)
    const second = await openReadSnapshot(factory)
    assert.deepEqual(await second.read("mads", NOW), day, "a second page reads what the first kept")
    await second.write("freja", { me: day.me, routes: {} })
    await second.forget("mads")
    assert.deepEqual(await store.read("mads", NOW), EMPTY_SNAPSHOT)
    assert.equal((await store.read("freja", NOW)).me?.readAt, at(0))
    store.close()
    second.close()
  })

  test("reads an answer older than the bound as none", async () => {
    const store = await openReadSnapshot(new IDBFactory())
    await store.write("mads", day)
    assert.deepEqual(await store.read("mads", NOW + SNAPSHOT_MAX_AGE_MS), { me: day.me, routes: day.routes }, "at the bound it still stands")
    assert.deepEqual(await store.read("mads", NOW + 60_000 + SNAPSHOT_MAX_AGE_MS + 1), EMPTY_SNAPSHOT)
    store.close()
  })
})

describe("what a login's row keeps", () => {
  test("only the routes its start screen names; with none kept, the routes stand alone", () => {
    const stray = { answer: routeDetail({ ...route({ id: OTHER_ROUTE }) }), readAt: at(0) }
    assert.deepEqual(Object.keys(kept({ ...day, routes: { ...day.routes, [OTHER_ROUTE]: stray } }, NOW).routes), [ROUTE_ID])
    assert.deepEqual(Object.keys(kept({ me: null, routes: { [OTHER_ROUTE]: stray } }, NOW).routes), [OTHER_ROUTE])
  })
})
