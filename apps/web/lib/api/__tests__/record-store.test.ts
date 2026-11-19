// The record store's controller (lib/api/records/record-store.ts), driven
// without React: a session reads the modules its role views and marks the
// rest not granted, two saves of one row take turns, and a write the session
// outlives leaves the next session's store alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Customer } from "@waste/contracts/customers"
import type { Me } from "@waste/contracts/me"

import type { BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, recordFrom } from "../records/adapter"
import { ME_PROJECTS } from "../records/me-projects"
import { createRecordStore, LOAD_READS_IN_FLIGHT, type RecordStore, type RecordStoreNotices } from "../records/record-store"
import { customerAdapter } from "../records/registry"
import { bodyOf, clientOver, json, type Call } from "./scripted-fetch"

const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const CUSTOMERS = "customers.contacts"

const me = (grants: Me["role"]["grants"]): Me => ({
  user: { id: "01a0d2a4-a280-7005-8000-000000000001", email: "olivia.larsen@kystbyen.example", fullName: "Olivia Larsen", status: "active", allProjects: false, primaryAdministrator: false },
  company: { id: "01a0d2a4-a280-7001-8000-000000000001", name: "Kystbyen Renovation" },
  role: { id: "01a0d2a4-a280-7004-8000-000000000001", key: null, name: "Customer desk", scope: "Company", system: false, grants },
  projects: [{ id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central", timezone: "Europe/Copenhagen", currency: "DKK" }],
  serviceProvider: null,
  driver: null,
})

/** An API that answers each request through `answer`, keeping what it was asked. */
function apiAnswering(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, client: clientOver(fetchImpl) }
}

/** Nobody told anything: these tests read the store. */
const QUIET: RecordStoreNotices = { refused: () => {}, landed: () => {}, landedCommand: () => {}, unsent: () => {} }

/** A controller whose session has read the customers, as a role viewing and editing them alone. */
async function sessionReading(answer: (call: Call) => Response | Promise<Response>): Promise<{ store: RecordStore; calls: Call[] }> {
  const { calls, client } = apiAnswering(answer)
  const store = createRecordStore(QUIET)
  store.client.set(client)
  store.startSession(true, async () => me([{ moduleKey: CUSTOMERS, actions: ["view", "edit", "create"] }]))
  while (store.loading.getSnapshot()) await new Promise((resolve) => setImmediate(resolve))
  return { store, calls }
}

const path = (call: Call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`

describe("the record store's controller", () => {
  test("a session reads the modules its role views, marks the rest not granted, and files /me's projects where the organisation is not one of them", async () => {
    const { store, calls } = await sessionReading(() => json({ items: [osterbro], nextCursor: null }))
    const state = store.server.getSnapshot()
    assert.deepEqual(calls.map(path), ["GET /customers"])
    assert.equal(state.get(CUSTOMERS)?.status, "ready")
    assert.equal(state.get(CUSTOMERS)?.records[0].name, "Østerbro Housing")
    assert.equal(state.get("configure.organization")?.status, "not-granted")
    assert.equal(state.get(ME_PROJECTS)?.records[0].submittedValues?.timezone, "Europe/Copenhagen")
    assert.equal(store.loading.getSnapshot(), false, "the load is done")
  })

  test("two saves of a new row take their turns: the second is a patch of the row the first made, never a second create", async () => {
    const made: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000009", name: "Nørrebro Boligselskab", registrationNumber: null }
    const { store, calls } = await sessionReading((call) => {
      if ((call.init.method ?? "GET") === "GET") return json({ items: [], nextCursor: null })
      if (call.init.method === "POST") return json(made, 201, { location: `/customers/${made.id}` })
      return json({ ...made, name: (bodyOf(call) as { name: string }).name })
    })
    const typed = (name: string): BusinessRecord => ({ ...recordFrom(customerAdapter, made, { resolve: NOTHING_RESOLVED }), id: "contacts-company-1700000000000", name, submittedValues: { partyType: "company", displayName: name } })
    const route = { apiConfigured: true, label: "Customers" }
    const first = store.write("customers", "contacts", typed("Nørrebro Boligselskab"), route)
    const second = store.write("customers", "contacts", typed("Nørrebro Bolig"), route)
    assert.deepEqual([(await first)?.kind, (await second)?.kind], ["created", "updated"])
    assert.deepEqual(calls.slice(1).map(path), ["POST /customers", `PATCH /customers/${made.id}`])
    assert.deepEqual(store.server.getSnapshot().get(CUSTOMERS)?.records.map((row) => [row.id, row.name]), [["contacts-company-1700000000000", "Nørrebro Bolig"]])
  })

  test("a write the session outlives answers its caller and leaves the next session's store alone", async () => {
    const asked: ((response: Response) => void)[] = []
    const { store } = await sessionReading((call) => ((call.init.method ?? "GET") === "GET" ? json({ items: [osterbro], nextCursor: null }) : new Promise<Response>((resolve) => asked.push(resolve))))
    const held = store.server.getSnapshot().get(CUSTOMERS)?.records[0] as BusinessRecord
    const written = store.write("customers", "contacts", { ...held, submittedValues: { ...held.submittedValues, displayName: "Østerbro Housing A/S" } }, { apiConfigured: true, label: "Customers" })
    while (asked.length === 0) await new Promise((resolve) => setImmediate(resolve))
    store.startSession(false, async () => me([]))
    asked[0](json({ ...osterbro, name: "Østerbro Housing A/S" }))
    assert.equal((await written)?.kind, "updated", "the API answered, and its caller is told")
    assert.equal(store.server.getSnapshot().size, 0, "the signed-out store holds nothing of it")
  })
})

// #649: the session's reads were sent one after the other, so a page waited
// for every module ahead of its own. They now go out a few at a time and land
// in SERVER_MODULES' order, so a module still maps against those before it.
describe("the session's load (#649)", () => {
  const VIEWED: Me["role"]["grants"][number]["moduleKey"][] = ["customers.contacts", "resources.warehouses", "fleet.vehicles", "fleet.drivers", "commercial.products"]
  const LISTS: Record<string, string> = { "/customers": "customers.contacts", "/warehouses": "resources.warehouses", "/vehicles": "fleet.vehicles", "/drivers": "fleet.drivers", "/products": "commercial.products", "/price-lists": "commercial.products" }

  /** A session whose every read waits until the test answers it. */
  function heldSession() {
    const held = new Map<string, () => void>()
    const { calls, client } = apiAnswering((call) => new Promise<Response>((resolve) => held.set(new URL(call.url).pathname, () => resolve(json({ items: [], nextCursor: null })))))
    const store = createRecordStore(QUIET)
    store.client.set(client)
    const landed: string[] = []
    store.server.subscribe(() => {
      for (const [key, state] of store.server.getSnapshot()) if (state.status === "ready" && (VIEWED as string[]).includes(key) && !landed.includes(key)) landed.push(key)
    })
    store.startSession(true, async () => me(VIEWED.map((moduleKey) => ({ moduleKey, actions: ["view"] }))))
    const settle = async () => {
      for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve))
    }
    const answer = async (pathname: string) => {
      held.get(pathname)?.()
      held.delete(pathname)
      await settle()
    }
    return { store, calls, held, landed, settle, answer }
  }

  const modulesOut = (held: Map<string, () => void>) => new Set([...held.keys()].map((pathname) => LISTS[pathname]))

  test("a few modules are read at once, never more than LOAD_READS_IN_FLIGHT, the next sent as one answers", async () => {
    const { held, settle, answer } = heldSession()
    await settle()
    assert.deepEqual([...modulesOut(held)], VIEWED.slice(0, LOAD_READS_IN_FLIGHT), "the first three, in order, at once")
    await answer("/warehouses")
    assert.deepEqual([...modulesOut(held)].sort(), ["customers.contacts", "fleet.drivers", "fleet.vehicles"], "the fourth sent as the second answered")
  })

  test("a module answered before one ahead of it lands after it, in SERVER_MODULES' order", async () => {
    const { store, held, landed, settle, answer } = heldSession()
    await settle()
    await answer("/vehicles")
    await answer("/warehouses")
    assert.deepEqual(landed, [], "nothing lands before the customers")
    await answer("/customers")
    assert.deepEqual(landed, ["customers.contacts", "resources.warehouses", "fleet.vehicles"])
    while (held.size > 0) await answer([...held.keys()][0])
    while (store.loading.getSnapshot()) await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(landed, VIEWED)
  })
})
