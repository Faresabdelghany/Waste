// A command whose movement landed but whose row could not be read back (#263):
// the store reads the row again — alone, through its adapter's own read, where
// it has one — and answers done with the row as it now is, so what a surface
// says of it is true; where that read fails too, nothing is made up.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { rowAgain, type BusinessRecordStores } from "@/components/waste/business-record-store"

import type { BusinessRecord } from "../../data/business-modules"
import { createExternalStore } from "../../external-store"
import { get } from "../client"
import type { Resource, ResourceAdapter, ServerModule } from "../records/adapter"
import { loaded, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, problem, scripted } from "./scripted-fetch"

type Thing = Resource & { name: string }

const row = { id: "t-1", name: "BIN-91007", status: "Ordered", facts: {}, related: [] } as unknown as BusinessRecord
const things: ResourceAdapter<Thing> = {
  prefix: "t",
  owns: (candidate) => candidate.id.startsWith("t-"),
  statuses: undefined,
  list: null,
  read: (client, serverId) => get<Thing>(client, `/things/${serverId}`),
  toRecord: (thing) => ({ ...row, id: `t-${thing.id}`, name: thing.name, status: "In stock" }),
  toPatchBody: () => null,
  update: () => Promise.reject(new Error("not written here")),
}
const module: ServerModule = { workspaceId: "resources", moduleId: "containers", resources: [things] }
const KEY = "resources.containers"

/** The two stores the read again touches; the rest of the provider's are not asked for on this path. */
const storesOver = (state: ServerRecordsState) =>
  ({ server: createExternalStore<ServerRecordsState>(state), generation: createExternalStore(0) }) as unknown as BusinessRecordStores

describe("a command that landed unread", () => {
  const held = () => new Map([[KEY, loaded({ records: [row], serverIds: new Map([["t-1", "1"]]) }, 1)]])

  test("its row is read again on its own where its adapter reads one, and the store holds it under the row's own id", async () => {
    const stores = storesOver(held())
    const { fetch, calls } = scripted([() => json({ id: "1", createdAt: "", updatedAt: "", name: "BIN-91007" })])
    const again = await rowAgain(stores, module, KEY, row, clientOver(fetch))
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), ["GET http://api.test/things/1"])
    assert.deepEqual([again?.id, again?.status], ["t-1", "In stock"], "the status the command moved it to, never the one it had")
    assert.equal(stores.server.getSnapshot().get(KEY)?.records[0].status, "In stock")
  })

  test("where that read fails too, there is no row to answer with", async () => {
    const stores = storesOver(held())
    const { fetch } = scripted([() => problem(503, "The API is unavailable")])
    assert.equal(await rowAgain(stores, module, KEY, row, clientOver(fetch)), undefined)
    assert.equal(stores.server.getSnapshot().get(KEY)?.records[0].status, "Ordered", "the row as it was, never a made-up one")
  })
})
