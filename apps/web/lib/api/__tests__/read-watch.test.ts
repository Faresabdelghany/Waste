// The store's watcher (#232), driven without React: a module is read again a
// second after something its last read read has moved, never while the
// session's load is still reading, a failed read again is asked for again
// half a minute on rather than at the next move of a module it never read,
// and a development build is told of a module read again and again.
import assert from "node:assert/strict"
import { describe, test, type TestContext } from "node:test"

import type { Property } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"

import { createExternalStore } from "../../external-store"
import type { ApiClient } from "../client"
import { projectAdapter } from "../records/organisation"
import { propertiesModule } from "../records/properties"
import { watchReads, type RecordStoreContext } from "../records/record-store"
import { loaded, readModuleInto, resolverOver, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, problem } from "./scripted-fetch"

const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const parkvej: Property = { id: "01a0d2a4-a280-700c-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", addressId: null, addressParts: null, registryId: null, kind: "residential", location: null, notes: null, driverInstructions: null, serviceWindow: null, status: "active", parties: [] }
const PROPERTIES = "customers.properties"
const NOON = Date.parse("2026-10-24T10:00:00Z")

/** The organisation holding the project under `name`. */
const organisation = (name: string) => {
  const record = projectAdapter.toRecord({ ...copenhagen, name }, { resolve: resolverOver(new Map()) })
  return loaded({ records: [record], serverIds: new Map([[record.id, copenhagen.id]]) }, NOON)
}

/** A fetch that answers the properties' list, or a refusal while `refusing` says so, counting what it was asked. */
function propertiesApi() {
  const api = { asked: 0, refusing: false }
  const fetchImpl = (async () => {
    api.asked += 1
    return api.refusing ? problem(400, "Not now") : json({ items: [parkvej], nextCursor: null })
  }) as typeof fetch
  return { api, client: clientOver(fetchImpl) }
}

/** The store as a session holds it once its load has read the organisation and the properties, the watcher's to watch. */
async function storesAfterTheLoad(client: ApiClient): Promise<RecordStoreContext> {
  const server = createExternalStore<ServerRecordsState>(new Map([["configure.organization", organisation("Copenhagen Central")]]))
  await readModuleInto(server, client, propertiesModule, { alive: () => true })
  return {
    server,
    client: createExternalStore<ApiClient | null>(client),
    pendingWrites: new Map(),
    pendingReads: new Map(),
    generation: createExternalStore(0),
    sessionSignal: createExternalStore<AbortSignal | null>(new AbortController().signal),
    loading: createExternalStore(false),
    notices: { refused: () => {}, landed: () => {}, landedCommand: () => {}, unsent: () => {} },
  }
}

/** Lets the reads a timer started answer and land. */
const settled = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

const renamed = (stores: RecordStoreContext, name: string) => stores.server.set((state) => new Map(state).set("configure.organization", organisation(name)))

async function watching(t: TestContext, options: Parameters<typeof watchReads>[1] = {}) {
  const { api, client } = propertiesApi()
  const stores = await storesAfterTheLoad(client)
  api.asked = 0
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOON })
  const stop = watchReads(stores, { onReturn: () => () => {}, ...options })
  t.after(stop)
  return { api, stores }
}

describe("the store's watcher", () => {
  test("reads a module again a second after a row it read moves, once for a burst", async (t) => {
    const { api, stores } = await watching(t)
    renamed(stores, "Copenhagen C")
    t.mock.timers.tick(500)
    renamed(stores, "Copenhagen Centre")
    t.mock.timers.tick(999)
    await settled()
    assert.equal(api.asked, 0, "a second after the last move")
    t.mock.timers.tick(1)
    await settled()
    assert.equal(api.asked, 1)
    assert.equal(stores.server.getSnapshot().get(PROPERTIES)?.records[0].facts.Project, "Copenhagen Centre")
  })

  test("reads nothing again while the session's load is still reading: a module it has yet to read may answer what a mapping missed", async (t) => {
    const { api, stores } = await watching(t)
    stores.loading.set(true)
    renamed(stores, "Copenhagen Centre")
    t.mock.timers.tick(10_000)
    await settled()
    assert.equal(api.asked, 0, "held back while the load reads")
    stores.loading.set(false)
    t.mock.timers.tick(1_000)
    await settled()
    assert.equal(api.asked, 1, "read once the load is done")
  })

  test("asks for a failed read again half a minute on, not at the next move of a module it never read", async (t) => {
    const { api, stores } = await watching(t)
    api.refusing = true
    renamed(stores, "Copenhagen Centre")
    t.mock.timers.tick(1_000)
    await settled()
    assert.equal(api.asked, 1)
    assert.ok(stores.server.getSnapshot().get(PROPERTIES)?.problem, "the read again failed, the rows kept")
    api.refusing = false
    stores.server.set((state) => new Map(state).set("route-studio.live", organisation("A board polled")))
    t.mock.timers.tick(29_000)
    await settled()
    assert.equal(api.asked, 1, "the Live board's poll asks for nothing")
    t.mock.timers.tick(1_000)
    t.mock.timers.tick(1_000)
    await settled()
    assert.equal(api.asked, 2, "half a minute on, asked again")
    assert.equal(stores.server.getSnapshot().get(PROPERTIES)?.problem, null)
  })

  test("tells a development build of a module read again and again for what it read, once", async (t) => {
    const loops: string[] = []
    const { api, stores } = await watching(t, { onLoop: (key) => loops.push(key) })
    for (let move = 1; move <= 7; move += 1) {
      renamed(stores, `Copenhagen ${move}`)
      t.mock.timers.tick(1_000)
      await settled()
    }
    assert.equal(api.asked, 7)
    assert.deepEqual(loops, [PROPERTIES])
  })
})
