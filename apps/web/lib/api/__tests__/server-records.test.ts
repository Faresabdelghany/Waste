// The server-backed half of the record store (Issue #81), without React or a
// browser: a module's states, what `getRecords` answers in each, a load
// through scripted adapters with the resolver seeing what loaded before, an
// optimistic write reconciled or rolled back, the resolver over several
// modules, and a module read into the store — the load's read, and the read
// again after a command that changed its rows (Issue #198).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_ACTIVE_ACCOUNT } from "@waste/domain/access/accounts"
import { softDeletedRecord } from "@/lib/prototype/record-visibility"

import type { BusinessRecord } from "../../data/business-modules"
import { createExternalStore } from "../../external-store"
import { command, get, patch, put, UNREACHABLE_STATUS, type ApiClient } from "../client"
import { ApiProblem, genericProblem, type Problem } from "../problem"
import { NOTHING_RESOLVED, PartialWrite, type MappingContext, type Resource, type ResourceAdapter, type ServerModule } from "../records/adapter"
import { todayIn } from "../records/clock"
import {
  adapterFor,
  clocksRead,
  commandRecord,
  dayTurned,
  dayTurnRereads,
  IDLE,
  KEPT_ON_API,
  keptOnApi,
  loadFailed,
  loadModule,
  loaded,
  loading,
  mapModule,
  moduleState,
  notGranted,
  paneAnswerOf,
  readModuleInto,
  readsChanged,
  readSourcesNow,
  refusalProblem,
  rereadsOf,
  resolverOver,
  sameSources,
  spellsStatus,
  untilDayTurns,
  withCreated,
  withNotGranted,
  withOutcome,
  withRecord,
  withoutRecord,
  writeRecord,
  type ServerRecordsState,
} from "../records/server-records"
import { clientOver, json, problem, scripted } from "./scripted-fetch"

const client: ApiClient = { baseUrl: "http://api.test", token: "t" }

const record = (id: string, name: string, overrides: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name,
  context: "",
  status: "Active",
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "",
  freshness: "",
  ...overrides,
})

type Thing = Resource & { name: string; parentId?: string }

/** An adapter over a scripted list: `things` in, records out, writes recorded. A thing's status is `active` or `inactive` on the wire. */
function thingAdapter(prefix: string, things: Thing[], calls: string[] = []): ResourceAdapter<Thing> & { calls: string[] } {
  return {
    prefix,
    calls,
    owns: (candidate) => candidate.id.startsWith(`${prefix}-`),
    statuses: ["active", "inactive"],
    list: async () => things,
    toRecord: (thing, context) => {
      const parent = thing.parentId === undefined ? undefined : context.resolve.byServerId(thing.parentId)
      return record(`${prefix}-${thing.id}`, thing.name, { facts: parent ? { Parent: parent.name } : {}, updated: context.now?.toISOString() ?? "" })
    },
    toCreateBody: (candidate) => (candidate.name === "" ? { path: "name", message: "A thing needs a name" } : { name: candidate.name }),
    toPatchBody: (before, after) => {
      const body: Record<string, string> = {}
      if (before.name !== after.name) body.name = after.name
      if (before.status !== after.status) body.status = after.status.toLowerCase()
      return Object.keys(body).length === 0 ? null : body
    },
    create: async (_client, body) => {
      calls.push(`create ${JSON.stringify(body)}`)
      return { id: "new-1", createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", name: (body as { name: string }).name }
    },
    update: async (_client, serverId, body) => {
      calls.push(`update ${serverId} ${JSON.stringify(body)}`)
      return { id: serverId, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", name: (body as { name: string }).name }
    },
  }
}

const NOW = new Date("2026-09-25T12:00:00Z")
const options = (state: ServerRecordsState = new Map()) => ({ state, now: NOW })

describe("a module's state", () => {
  test("a module the store has not been asked for is idle, with no rows", () => {
    assert.equal(moduleState(new Map(), "configure", "organization"), IDLE)
    assert.deepEqual([IDLE.records, IDLE.serverIds.size, IDLE.loadedAt], [[], 0, null])
  })

  test("loading keeps a ready module ready and moves an idle one to loading, clearing the problem", () => {
    assert.equal(loading(IDLE).status, "loading")
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    assert.equal(loading({ ...ready, problem: genericProblem(500) }).status, "ready")
    assert.equal(loading({ ...ready, problem: genericProblem(500) }).problem, null)
  })

  test("a ready module holds the server's records, at the clock of the read", () => {
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    assert.deepEqual(ready.records.map((candidate) => candidate.id), ["t-1"])
    assert.equal(ready.loadedAt, 5)
  })

  test("a failed first read is failed with no rows; a failed re-read keeps the rows and notes the problem", () => {
    const problem = genericProblem(503)
    const failed = loadFailed(loading(IDLE), problem)
    assert.equal(failed.status, "failed")
    assert.equal(failed.problem, problem)
    assert.deepEqual(failed.records, [])
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    const stillReady = loadFailed(ready, problem)
    assert.equal(stillReady.status, "ready")
    assert.deepEqual(stillReady.records, ready.records)
    assert.equal(stillReady.problem, problem)
  })

  test("a module the person's role does not view is not granted: no rows, and the sentence a pane shows, with nothing read", () => {
    const withheld = notGranted("configure.master")
    assert.equal(withheld.status, "not-granted")
    assert.deepEqual(withheld.problem, { type: "about:blank", title: "Forbidden", status: 403, detail: "Your role does not allow view on configure.master" })
    assert.deepEqual([withheld.records, withheld.serverIds.size, withheld.loadedAt], [[], 0, null])
  })

  test("withNotGranted marks exactly the modules it is handed, leaves every other module as it stands, and hands back the same state when there are none", () => {
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    const state: ServerRecordsState = new Map([["customers.contacts", ready]])
    const withheld: ServerModule[] = [
      { workspaceId: "configure", moduleId: "organization", resources: [] },
      { workspaceId: "configure", moduleId: "master", resources: [] },
    ]
    const marked = withNotGranted(state, withheld)
    assert.deepEqual([...marked.keys()], ["customers.contacts", "configure.organization", "configure.master"])
    assert.equal(marked.get("customers.contacts"), ready)
    assert.deepEqual(marked.get("configure.organization"), notGranted("configure.organization"))
    assert.deepEqual(marked.get("configure.master"), notGranted("configure.master"))
    assert.equal(state.size, 1, "the state it was handed is left alone")
    assert.equal(withNotGranted(state, []), state, "nothing withheld is no change, so the store tells nobody")
  })

  test("withRecord replaces in place or puts a new record first; withoutRecord drops it and its server id", () => {
    const ready = loaded({ records: [record("t-1", "One"), record("t-2", "Two")], serverIds: new Map([["t-1", "1"], ["t-2", "2"]]) }, 5)
    const replaced = withRecord(ready, record("t-2", "Two renamed"))
    assert.deepEqual(replaced.records.map((candidate) => candidate.name), ["One", "Two renamed"])
    const added = withRecord(ready, record("t-3", "Three"), "3")
    assert.deepEqual(added.records.map((candidate) => candidate.id), ["t-3", "t-1", "t-2"])
    assert.equal(added.serverIds.get("t-3"), "3")
    const removed = withoutRecord(added, "t-3")
    assert.deepEqual(removed.records.map((candidate) => candidate.id), ["t-1", "t-2"])
    assert.equal(removed.serverIds.has("t-3"), false)
  })

  test("withCreated keeps the minted id for the session, with the server's row and id behind it", () => {
    const ready = withRecord(loaded({ records: [], serverIds: new Map() }, 5), record("mint-1", "New", { facts: { Optimistic: "yes" } }))
    const created = withCreated(ready, "mint-1", record("t-new-1", "New", { facts: { Stamped: "by the server" } }), "new-1")
    assert.deepEqual(created.records.map((candidate) => candidate.id), ["mint-1"])
    assert.deepEqual(created.records[0].facts, { Stamped: "by the server" }, "the server's row, under the minted id")
    assert.equal(created.serverIds.get("mint-1"), "new-1")
    assert.equal(created.serverIds.has("t-new-1"), false)
  })
})

describe("what a pane reading its own module is told on the Pilot", () => {
  const rows = [record("t-1", "One")]

  test("no rows and pending while the read is still to come or out; the rows once the module is ready", () => {
    assert.deepEqual(paneAnswerOf(IDLE), { records: [], ready: false, pending: true, notGranted: false, problem: null })
    assert.deepEqual(paneAnswerOf(loading(IDLE)), { records: [], ready: false, pending: true, notGranted: false, problem: null })
    assert.deepEqual(paneAnswerOf(loaded({ records: rows, serverIds: new Map([["t-1", "1"]]) }, 5)), { records: rows, ready: true, pending: false, notGranted: false, problem: null })
  })

  test("a read that failed: no rows, nothing to wait for, and the API's problem, which is no refusal of the role", () => {
    const problem = genericProblem(503)
    assert.deepEqual(paneAnswerOf(loadFailed(loading(IDLE), problem)), { records: [], ready: false, pending: false, notGranted: false, problem })
  })

  test("a module the role does not view: no rows and nothing to wait for, told apart from a failed read, with the sentence the pane shows in their place", () => {
    assert.deepEqual(paneAnswerOf(notGranted("configure.organization")), {
      records: [],
      ready: false,
      pending: false,
      notGranted: true,
      problem: { type: "about:blank", title: "Forbidden", status: 403, detail: "Your role does not allow view on configure.organization" },
    })
  })

  test("a module kept on the API where none is configured: no rows, nothing to wait for, and the store's sentence in their place", () => {
    assert.deepEqual(paneAnswerOf(KEPT_ON_API), { records: [], ready: false, pending: false, notGranted: false, problem: genericProblem(UNREACHABLE_STATUS, keptOnApi("This list")) })
  })
})

describe("loading a module", () => {
  test("lists every adapter in order, maps each row, and a later adapter resolves an earlier one's rows", async () => {
    const parents = thingAdapter("p", [{ id: "p1", createdAt: "", updatedAt: "", name: "Parent" }])
    const children = thingAdapter("c", [{ id: "c1", createdAt: "", updatedAt: "", name: "Child", parentId: "p1" }])
    const module: ServerModule = { workspaceId: "configure", moduleId: "organization", resources: [parents, children] }
    const result = await loadModule(client, module, options())
    assert.deepEqual(result.records.map((candidate) => candidate.id), ["p-p1", "c-c1"])
    assert.equal(result.records[1].facts.Parent, "Parent")
    assert.equal(result.serverIds.get("c-c1"), "c1")
    assert.equal(result.records[0].updated, NOW.toISOString(), "the clock reaches the mapping")
  })

  test("a mapping resolves the rows of modules loaded before it", async () => {
    const earlier: ServerRecordsState = new Map([["configure.organization", loaded({ records: [record("p-p1", "Parent")], serverIds: new Map([["p-p1", "p1"]]) }, 1)]])
    const children = thingAdapter("c", [{ id: "c1", createdAt: "", updatedAt: "", name: "Child", parentId: "p1" }])
    const module: ServerModule = { workspaceId: "configure", moduleId: "access", resources: [children] }
    const result = await loadModule(client, module, options(earlier))
    assert.equal(result.records[0].facts.Parent, "Parent")
  })

  test("a second row mapped onto an id another row holds keeps the server's id, so no two rows share a web id", async () => {
    const twins = thingAdapter("t", [
      { id: "1", createdAt: "", updatedAt: "", name: "Olivia Larsen" },
      { id: "2", createdAt: "", updatedAt: "", name: "Olivia Larsen" },
    ])
    const aliasing: ResourceAdapter<Thing> = { ...twins, toRecord: (thing) => record("t-olivia", thing.name) }
    const module: ServerModule = { workspaceId: "configure", moduleId: "access", resources: [aliasing] }
    const result = await loadModule(client, module, options())
    assert.deepEqual(result.records.map((candidate) => candidate.id), ["t-olivia", "t-2"])
    assert.equal(result.serverIds.get("t-olivia"), "1")
    assert.equal(result.serverIds.get("t-2"), "2")
  })

  test("a list that throws fails the load", async () => {
    const broken: ResourceAdapter<Thing> = { ...thingAdapter("b", []), list: async () => { throw new Error("boom") } }
    const module: ServerModule = { workspaceId: "configure", moduleId: "access", resources: [broken] }
    await assert.rejects(() => loadModule(client, module, options()), /boom/)
  })
})

describe("reading a module into the store", () => {
  const things: Thing[] = [{ id: "1", createdAt: "", updatedAt: "", name: "One" }, { id: "2", createdAt: "", updatedAt: "", name: "Two" }]
  const oldRows = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)

  /** A module whose one list answers when the test lets it, so the store can be looked at while the read is out. */
  function heldModule(answer: () => Promise<Thing[]>): ServerModule {
    return { workspaceId: "resources", moduleId: "inventory", resources: [{ ...thingAdapter("t", []), list: answer }] }
  }

  test("a module read for the first time is loading while the read is out, then ready with the rows at the clock given", async () => {
    const store = createExternalStore<ServerRecordsState>(new Map())
    let whileOut: string | undefined
    const module = heldModule(async () => {
      whileOut = store.getSnapshot().get("resources.inventory")?.status
      return things
    })
    const problem = await readModuleInto(store, client, module, { alive: () => true, now: () => 7 })
    assert.equal(problem, null)
    assert.equal(whileOut, "loading")
    const read = store.getSnapshot().get("resources.inventory")
    assert.deepEqual([read?.status, read?.records.map((candidate) => candidate.id), read?.loadedAt], ["ready", ["t-1", "t-2"], 7])
  })

  test("a ready module read again keeps its rows while the read is out, then holds the API's", async () => {
    const store = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    let whileOut: string[] | undefined
    const module = heldModule(async () => {
      const held = store.getSnapshot().get("resources.inventory")
      whileOut = held?.status === "ready" ? held.records.map((candidate) => candidate.id) : []
      return things
    })
    await readModuleInto(store, client, module, { alive: () => true, now: () => 8 })
    assert.deepEqual(whileOut, ["t-1"], "ready with its old rows while the read is out")
    assert.deepEqual(store.getSnapshot().get("resources.inventory")?.records.map((candidate) => candidate.id), ["t-1", "t-2"])
  })

  test("a read that fails leaves a ready module its rows beside the problem, fails one that was not, and hands the problem back", async () => {
    const problem = genericProblem(503, "The API is down")
    const failing = heldModule(async () => {
      throw new ApiProblem(problem)
    })
    const ready = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    assert.deepEqual(await readModuleInto(ready, client, failing, { alive: () => true, retryDelaysMs: [] }), problem)
    const kept = ready.getSnapshot().get("resources.inventory")
    assert.deepEqual([kept?.status, kept?.records, kept?.problem], ["ready", oldRows.records, problem])
    const first = createExternalStore<ServerRecordsState>(new Map())
    await readModuleInto(first, client, failing, { alive: () => true, retryDelaysMs: [] })
    assert.equal(first.getSnapshot().get("resources.inventory")?.status, "failed")
  })

  describe("a read that fails on the way, not by the API's answer", () => {
    /** A module whose list fails with `failures` in turn, then answers; the calls are counted. */
    function flaky(failures: readonly Problem[]) {
      let calls = 0
      const module = heldModule(async () => {
        const failure = failures[calls]
        calls += 1
        if (failure !== undefined) throw new ApiProblem(failure)
        return things
      })
      return { module, calls: () => calls }
    }
    const reset = genericProblem(500, "Internal Server Error")
    const unreachable = genericProblem(UNREACHABLE_STATUS, "The API at /waste-api did not answer (fetch failed)")

    test("a 5xx or an API that did not answer is asked again, and the module lands: one proxy reset in the page's burst of reads does not fail it for the session", async () => {
      for (const failure of [reset, unreachable]) {
        const { module, calls } = flaky([failure])
        const store = createExternalStore<ServerRecordsState>(new Map())
        assert.equal(await readModuleInto(store, client, module, { alive: () => true, now: () => 9, retryDelaysMs: [0, 0] }), null)
        assert.equal(calls(), 2)
        assert.equal(store.getSnapshot().get("resources.inventory")?.status, "ready")
      }
    })

    test("asked once per delay, then the failure stands", async () => {
      const { module, calls } = flaky([reset, reset, reset, reset])
      const store = createExternalStore<ServerRecordsState>(new Map())
      assert.deepEqual(await readModuleInto(store, client, module, { alive: () => true, retryDelaysMs: [0, 0] }), reset)
      assert.equal(calls(), 3, "the first read and one per delay")
      assert.equal(store.getSnapshot().get("resources.inventory")?.status, "failed")
    })

    test("a refusal the API answered is never asked again: a 4xx says the same twice", async () => {
      const { module, calls } = flaky([genericProblem(403, "This account's role does not allow view on resources.inventory")])
      const store = createExternalStore<ServerRecordsState>(new Map())
      await readModuleInto(store, client, module, { alive: () => true, retryDelaysMs: [0, 0] })
      assert.equal(calls(), 1)
      assert.equal(store.getSnapshot().get("resources.inventory")?.status, "failed")
    })

    test("a session that ended while it waited asks nothing more and writes nothing", async () => {
      let alive = true
      const { module, calls } = flaky([reset])
      const store = createExternalStore<ServerRecordsState>(new Map())
      const read = readModuleInto(store, client, module, { alive: () => alive, retryDelaysMs: [20] })
      alive = false
      assert.equal(await read, null)
      assert.equal(calls(), 1)
      assert.equal(store.getSnapshot().get("resources.inventory")?.status, "loading", "left as the read found it; the session's next load replaces the store")
    })
  })

  test("the account's own refusal comes back and is written nowhere: the session has ended, and /login says why", async () => {
    const refusal = { type: NO_ACTIVE_ACCOUNT.type, title: "Forbidden", status: 403, detail: "No active account in this company is bound to this login" }
    const refused = heldModule(async () => {
      throw new ApiProblem(refusal)
    })
    const store = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    assert.deepEqual(await readModuleInto(store, client, refused, { alive: () => true }), refusal)
    const kept = store.getSnapshot().get("resources.inventory")
    assert.deepEqual([kept?.status, kept?.records, kept?.problem], ["ready", oldRows.records, null])
  })

  test("an answer the session outlived lands nothing, and a session already over is neither asked nor written to", async () => {
    let alive = true
    const outlived = heldModule(async () => {
      alive = false
      return things
    })
    const store = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    await readModuleInto(store, client, outlived, { alive: () => alive })
    assert.deepEqual(store.getSnapshot().get("resources.inventory")?.records.map((candidate) => candidate.id), ["t-1"], "the old rows, not the answer")

    let asked = false
    const unasked = heldModule(async () => {
      asked = true
      return things
    })
    const before = store.getSnapshot()
    assert.equal(await readModuleInto(store, client, unasked, { alive: () => false }), null)
    assert.equal(asked, false)
    assert.equal(store.getSnapshot(), before, "not even a loading mark: it would land in the next session's store")
  })
})

describe("the modules a command touched", () => {
  const module = (moduleId: string): ServerModule => ({ workspaceId: "resources", moduleId, resources: [] })
  const modules = [module("containers"), module("inventory"), module("allocations"), module("stock"), module("depots"), module("yards")]

  test("are read again when the store holds them ready or on their first read, in the modules' own order; not one it never asked for, the role does not view, failed to read or does not switch", () => {
    const state: ServerRecordsState = new Map([
      ["resources.containers", loaded({ records: [], serverIds: new Map() }, 1)],
      ["resources.inventory", loaded({ records: [], serverIds: new Map() }, 1)],
      ["resources.allocations", loading(IDLE)],
      ["resources.stock", loadFailed(loading(IDLE), genericProblem(503))],
      ["resources.yards", notGranted("resources.yards")],
    ])
    const touches = ["resources.yards", "resources.depots", "resources.stock", "resources.allocations", "resources.inventory", "resources.unswitched"]
    assert.deepEqual(rereadsOf(state, touches, modules).map((candidate) => candidate.moduleId), ["inventory", "allocations"])
    assert.deepEqual(rereadsOf(state, [], modules), [])
  })
})

describe("the resolver", () => {
  test("looks across every ready module and the rows being mapped, and misses cleanly", () => {
    const state: ServerRecordsState = new Map([
      ["a", loaded({ records: [record("x-1", "X")], serverIds: new Map([["x-1", "1"]]) }, 1)],
      ["b", loadFailed(IDLE, genericProblem(500))],
    ])
    const extra = { records: [record("y-2", "Y")], serverIds: new Map([["y-2", "2"]]), byServerId: new Map([["2", record("y-2", "Y")]]) }
    const resolve = resolverOver(state, extra)
    assert.equal(resolve.byServerId("1")?.name, "X")
    assert.equal(resolve.byServerId("2")?.name, "Y")
    assert.equal(resolve.serverIdOf("y-2"), "2")
    assert.equal(resolve.byServerId("3"), undefined)
    assert.equal(resolve.serverIdOf("nowhere"), undefined)
    assert.equal(NOTHING_RESOLVED.byServerId("1"), undefined)
  })

  test("by server id, answers the row a load is mapping before the store's: the module read again holds both, the load's as just listed (#240)", () => {
    const state: ServerRecordsState = new Map([["a", loaded({ records: [record("x-1", "X")], serverIds: new Map([["x-1", "1"]]) }, 1)]])
    const extra = { records: [record("x-1", "X again")], serverIds: new Map([["x-1", "1"]]), byServerId: new Map([["1", record("x-1", "X again")]]) }
    assert.equal(resolverOver(state, extra).byServerId("1")?.name, "X again")
  })

  test("answers a miss on the rows a load is mapping by their index, never by walking them: a load of thousands asks once per row (#179)", () => {
    const walked = new Map([["y-2", "2"]])
    walked.entries = () => {
      throw new Error("the resolver walked the load's rows")
    }
    walked[Symbol.iterator] = walked.entries
    const extra = { records: [record("y-2", "Y")], serverIds: walked, byServerId: new Map([["2", record("y-2", "Y")]]) }
    const resolve = resolverOver(new Map(), extra)
    assert.equal(resolve.byServerId("2")?.name, "Y")
    assert.equal(resolve.byServerId("missing"), undefined)
  })

  test("lists every record of a module a predicate holds for once, in its order, the loaded row before the one being mapped again (#207)", () => {
    const state: ServerRecordsState = new Map([
      ["a", loaded({ records: [record("x-1", "X"), record("x-2", "X2")], serverIds: new Map() }, 1)],
      ["b", loaded({ records: [record("z-3", "Z")], serverIds: new Map() }, 1)],
    ])
    const extra = { key: "a", records: [record("x-1", "X again"), record("x-4", "X4")], serverIds: new Map(), byServerId: new Map() }
    const names = resolverOver(state, extra).filter("a", (candidate) => candidate.id.startsWith("x-")).map((candidate) => candidate.name)
    assert.deepEqual(names, ["X", "X2", "X4"])
    assert.deepEqual(resolverOver(state, extra).filter("b", () => true).map((candidate) => candidate.name), ["Z"], "one module's rows alone")
    assert.deepEqual(NOTHING_RESOLVED.filter("a", () => true), [])
  })
})

describe("writing a record", () => {
  const adapter = () => thingAdapter("t", [])
  const module = (resource: ResourceAdapter<Thing>): ServerModule => ({ workspaceId: "configure", moduleId: "organization", resources: [resource] })

  test("a record without a server id is created, and the outcome carries the mapped row, the server id and the optimistic id", async () => {
    const resource = adapter()
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-mint-1", "New thing"), options())
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.optimisticId, "t-mint-1")
    assert.equal(outcome.serverId, "new-1")
    assert.equal(outcome.record.id, "t-new-1")
    assert.deepEqual(resource.calls, ['create {"name":"New thing"}'])
  })

  test("a record with a server id is patched with what moved, against the row as the module last had it", async () => {
    const resource = adapter()
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One renamed"), options())
    assert.equal(outcome.kind, "updated")
    assert.deepEqual(resource.calls, ['update 1 {"name":"One renamed"}'])
  })

  test("an updated row keeps its web id whatever the mapping would now derive, as a created row keeps its minted one: one server row is one row here", async () => {
    const resource: ResourceAdapter<Thing> = { ...adapter(), toRecord: (thing) => record(`t-by-name-${thing.name.toLowerCase()}`, thing.name) }
    const current = loaded({ records: [record("t-by-name-one", "One")], serverIds: new Map([["t-by-name-one", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-by-name-one", "Two"), options())
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.id, "t-by-name-one", "not t-by-name-two")
    assert.equal(outcome.record.name, "Two")
  })

  test("a move to a status the wire has a word for is a patch", async () => {
    const resource = adapter()
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One", { status: "Inactive" }), options())
    assert.equal(outcome.kind, "updated")
    assert.deepEqual(resource.calls, ['update 1 {"status":"inactive"}'])
  })

  test("a status the wire has no word for is refused, not unchanged: the row is rolled back and the person told, nothing sent", async () => {
    const resource = adapter()
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One", { status: "Archived" }), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.recordId, "t-1")
    assert.equal(outcome.problem.status, 400)
    assert.deepEqual(outcome.problem.errors, [{ path: "status", message: 'The API has no status "Archived" for a t; it knows active, inactive' }])
    assert.deepEqual(resource.calls, [])
  })

  test("a kind whose status the API does not take refuses every status move and says so", async () => {
    const resource: ResourceAdapter<Thing> = { ...adapter(), statuses: undefined }
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One", { status: "Inactive" }), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(outcome.problem.errors, [{ path: "status", message: "The API does not change a t's status" }])
  })

  test("a soft delete of an owned record is refused: the API has no delete, and the marker is a fact that travels nowhere", async () => {
    const resource = adapter()
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const deleted = softDeletedRecord(record("t-1", "One"), { reason: "Duplicate", actorName: "Olivia", deletionLogId: "audit-1" })
    const outcome = await writeRecord(client, module(resource), current, deleted, options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.match(outcome.problem.detail ?? "", /The API has no delete: a t is deactivated or moved to another status, not deleted/)
    assert.deepEqual(resource.calls, [])
  })

  test("spellsStatus is the same rule for the workspace: the wire's statuses as lifecycle labels, nothing for a kind without them or a record nobody owns", () => {
    const withStatuses = module(adapter())
    assert.ok(spellsStatus(withStatuses, record("t-1", "One"), "Inactive"))
    assert.ok(spellsStatus(withStatuses, record("t-1", "One"), "Active"))
    assert.ok(!spellsStatus(withStatuses, record("t-1", "One"), "Archived"))
    assert.ok(!spellsStatus(withStatuses, record("t-1", "One"), "Merged"))
    assert.ok(!spellsStatus(module({ ...adapter(), statuses: undefined }), record("t-1", "One"), "Inactive"))
    assert.ok(!spellsStatus(withStatuses, record("elsewhere-1", "X"), "Inactive"))
  })

  test("nothing moved, nothing sent", async () => {
    const resource = adapter()
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One", { facts: { Anything: "else" } }), options())
    assert.equal(outcome.kind, "unchanged")
    assert.deepEqual(resource.calls, [])
  })

  test("a local refusal is a 400 in the API's shape naming the field, and nothing is sent", async () => {
    const resource = adapter()
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-mint", ""), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(outcome.problem, refusalProblem({ path: "name", message: "A thing needs a name" }))
    assert.deepEqual(resource.calls, [])
  })

  test("a record no adapter owns is refused with a sentence", async () => {
    const outcome = await writeRecord(client, module(adapter()), loaded({ records: [], serverIds: new Map() }, 1), record("elsewhere-1", "X"), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.match(outcome.problem.detail ?? "", /has no server resource for elsewhere-1/)
    assert.equal(adapterFor(module(adapter()), record("elsewhere-1", "X")), undefined)
  })

  test("a kind the API does not create is refused as such", async () => {
    const readOnly: ResourceAdapter<Thing> = { ...adapter(), toCreateBody: undefined, create: undefined }
    const outcome = await writeRecord(client, module(readOnly), loaded({ records: [], serverIds: new Map() }, 1), record("t-mint", "X"), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.detail, "A t is not created here")
  })

  test("an API refusal is the problem it threw", async () => {
    const refusing: ResourceAdapter<Thing> = {
      ...adapter(),
      create: async () => {
        const { ApiProblem } = await import("../problem")
        throw new ApiProblem({ type: "about:blank", title: "Conflict", status: 409, detail: "This company already has a project called \"X\"" })
      },
    }
    const outcome = await writeRecord(client, module(refusing), loaded({ records: [], serverIds: new Map() }, 1), record("t-mint", "X"), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 409)
    assert.match(outcome.problem.detail ?? "", /already has a project/)
  })

  test("the mapping context of a write resolves what is loaded", async () => {
    const resource: ResourceAdapter<Thing> = {
      ...adapter(),
      toCreateBody: (candidate, context: MappingContext) => ({ name: candidate.name, parent: context.resolve.serverIdOf("p-p1") }),
    }
    const state: ServerRecordsState = new Map([["x", loaded({ records: [record("p-p1", "Parent")], serverIds: new Map([["p-p1", "p1"]]) }, 1)]])
    const outcome = await writeRecord(client, module(resource), loaded({ records: [], serverIds: new Map() }, 1), record("t-mint", "New"), options(state))
    assert.equal(outcome.kind, "created")
    assert.deepEqual((resource as ReturnType<typeof thingAdapter>).calls, ['create {"name":"New","parent":"p1"}'])
  })
})

// What a mapping read (#232): the resolver and the clock a load's mapping is handed note what it asks — the rows of
// other modules it named, the modules it scanned, the ids it found nowhere, the project's day on each clock — stamped
// with the store as the read began. The store reads the module again once one of them moves, so nothing declares
// which modules a module is read through, or that it reads the day.
describe("what a module's mapping read", () => {
  const thing = (id: string, name: string, parentId?: string): Thing => ({ id, createdAt: "", updatedAt: "", name, ...(parentId === undefined ? {} : { parentId }) })
  const ready = (records: BusinessRecord[]) => loaded({ records, serverIds: new Map(records.map((row) => [row.id, row.id.slice(row.id.indexOf("-") + 1)])) }, 1)
  const parents = [record("p-p1", "Parent"), record("p-p2", "Other")]
  /** The children, each naming its parent by server id. */
  const childrenOf = (things: Thing[]): ServerModule => ({ workspaceId: "resources", moduleId: "inventory", resources: [thingAdapter("c", things)] })
  const read = async (state: ServerRecordsState, module: ServerModule) => {
    const store = createExternalStore<ServerRecordsState>(state)
    await readModuleInto(store, client, module, { alive: () => true })
    return store
  }

  test("notes the rows of other modules it named and the fields of each it read, as the read began, never its own", async () => {
    const store = await read(new Map([["configure.organization", ready(parents)]]), childrenOf([thing("c1", "Child", "p1"), thing("c2", "Second", "c1")]))
    const reads = store.getSnapshot().get("resources.inventory")?.reads
    assert.deepEqual([...(reads?.rows ?? [])].map(([key, rows]) => [key, [...rows.keys()]]), [["configure.organization", ["p-p1"]]])
    const named = reads?.rows.get("configure.organization")?.get("p-p1")
    assert.equal(named?.record, parents[0])
    assert.deepEqual([...(named?.fields ?? [])], [["name", true]], "its name, the one field the child reads of it")
  })

  test("a row it named that moves only in what it never read moves nothing: a live route's position, under the stop that names its route", async () => {
    const naming: ServerModule = {
      ...childrenOf([]),
      resources: [{ ...thingAdapter("c", [thing("c1", "Child", "p1")]), toRecord: (candidate: Thing, context) => record(`c-${candidate.id}`, candidate.name, { facts: { Route: context.resolve.byServerId(candidate.parentId ?? "")?.facts.Name ?? "" } }) }],
    }
    const route = (position: string, name = "RC-1042") => record("p-p1", name, { facts: { Name: name, "Last position": position } })
    const store = await read(new Map([["configure.organization", ready([route("55.70, 12.57")])]]), naming)
    assert.deepEqual([...(store.getSnapshot().get("resources.inventory")?.reads?.rows.get("configure.organization")?.get("p-p1")?.fields ?? [])], [["facts", new Set(["Name"])]])
    const moved = (row: BusinessRecord) => readsChanged(new Map(store.getSnapshot()).set("configure.organization", ready([row])), "resources.inventory")
    assert.deepEqual(moved(route("55.71, 12.58")), [], "its position: a fact it never read")
    assert.deepEqual(moved(route("55.70, 12.57", "RC-1043")), ["configure.organization"], "the fact it read")
  })

  test("is read again once a row it named moves, and not for a row of the same module it never named", async () => {
    const store = await read(new Map([["configure.organization", ready(parents)]]), childrenOf([thing("c1", "Child", "p1")]))
    const moved = (rows: BusinessRecord[]) => new Map(store.getSnapshot()).set("configure.organization", ready(rows))
    assert.deepEqual(readsChanged(store.getSnapshot(), "resources.inventory"), [], "nothing has moved")
    assert.deepEqual(readsChanged(moved([parents[0], record("p-p2", "Other renamed")]), "resources.inventory"), [], "another row of the module")
    assert.deepEqual(readsChanged(moved([record("p-p1", "Parent renamed"), parents[1]]), "resources.inventory"), ["configure.organization"])
    assert.deepEqual(readsChanged(moved([parents[1]]), "resources.inventory"), ["configure.organization"], "the row it named is gone")
  })

  test("is stamped from the snapshot its read began with: a change landing while it is out is still new once it lands", async () => {
    const store = createExternalStore<ServerRecordsState>(new Map([["configure.organization", ready(parents)]]))
    const module: ServerModule = {
      ...childrenOf([]),
      resources: [
        {
          ...thingAdapter("c", []),
          list: async () => {
            store.set((state) => new Map(state).set("configure.organization", ready([record("p-p1", "Parent renamed"), parents[1]])))
            return [thing("c1", "Child", "p1")]
          },
        },
      ],
    }
    await readModuleInto(store, client, module, { alive: () => true })
    assert.equal(store.getSnapshot().get("resources.inventory")?.records[0].facts.Parent, "Parent renamed", "mapped against the store as the answer lands")
    assert.deepEqual(readsChanged(store.getSnapshot(), "resources.inventory"), ["configure.organization"], "but the answer is no newer than the read")
    await readModuleInto(store, client, childrenOf([thing("c1", "Child", "p1")]), { alive: () => true })
    assert.deepEqual(readsChanged(store.getSnapshot(), "resources.inventory"), [], "and once read again, it is current")
  })

  test("a module read before the one it names is read again once that one holds the row: the order is reads, never rows", async () => {
    const store = await read(new Map(), childrenOf([thing("c1", "Child", "p1")]))
    assert.equal(store.getSnapshot().get("resources.inventory")?.records[0].facts.Parent, undefined, "its parent not read yet")
    const landed = new Map(store.getSnapshot()).set("configure.organization", ready(parents))
    assert.deepEqual(readsChanged(landed, "resources.inventory"), ["configure.organization"])
    assert.deepEqual(readsChanged(new Map(store.getSnapshot()).set("configure.access", ready([record("u-1", "Someone")])), "resources.inventory"), [], "a module holding none of what it missed")
    const again = await read(landed, childrenOf([thing("c1", "Child", "p1")]))
    assert.equal(again.getSnapshot().get("resources.inventory")?.records[0].facts.Parent, "Parent")
  })

  test("a module it scanned is read whole: any new rows there move it", async () => {
    const scanning: ServerModule = {
      ...childrenOf([]),
      resources: [{ ...thingAdapter("c", [thing("c1", "Child")]), toRecord: (candidate: Thing, context) => record(`c-${candidate.id}`, candidate.name, { facts: { Areas: String(context.resolve.filter("configure.areas", () => true).length) } }) }],
    }
    const store = await read(new Map([["configure.areas", ready([record("area-1", "Indre By")])]]), scanning)
    assert.equal(store.getSnapshot().get("resources.inventory")?.records[0].facts.Areas, "1")
    assert.deepEqual(readsChanged(new Map(store.getSnapshot()).set("configure.areas", ready([record("area-1", "Indre By"), record("area-2", "Nørrebro")])), "resources.inventory"), ["configure.areas"])
  })

  test("one not ready never counts and never loops: not granted, failed, read again and still out; nor while it is not ready itself", async () => {
    const store = await read(new Map([["configure.organization", ready(parents)]]), childrenOf([thing("c1", "Child", "p1"), thing("c2", "Orphan", "p9")]))
    const state = store.getSnapshot()
    for (const source of [notGranted("configure.organization"), loadFailed(loading(IDLE), genericProblem(503)), loading(IDLE)]) {
      assert.deepEqual(readsChanged(new Map(state).set("configure.organization", source), "resources.inventory"), [], source.status)
    }
    const keptRows = loadFailed(state.get("configure.organization") ?? IDLE, genericProblem(503))
    assert.deepEqual(readsChanged(new Map(state).set("configure.organization", keptRows), "resources.inventory"), [], "a failed read again keeps its rows: nothing new")
    assert.deepEqual(readsChanged(new Map(state).set("resources.inventory", loading(IDLE)), "resources.inventory"), [], "not ready itself")
    assert.deepEqual(readsChanged(new Map([["resources.inventory", ready([])], ["configure.organization", ready([])]]), "resources.inventory"), [], "never read")
  })

  test("a read again is asked for once per move of what it read: a failed one is not asked for again until that moves once more, whatever else does", async () => {
    const store = await read(new Map([["configure.organization", ready(parents)]]), childrenOf([thing("c1", "Child", "p1")]))
    const written = new Map(store.getSnapshot()).set("configure.organization", ready([record("p-p1", "Parent renamed"), parents[1]]))
    const asked = readSourcesNow(written, "resources.inventory")
    assert.deepEqual([...asked.keys()], ["configure.organization"])
    assert.equal(sameSources(asked, readSourcesNow(new Map(written), "resources.inventory")), true, "the same move: asked for already")
    assert.equal(sameSources(asked, readSourcesNow(new Map(written).set("route-studio.live", ready([record("route-1", "RC-1042")])), "resources.inventory")), true, "a module it never read moving")
    assert.equal(sameSources(asked, readSourcesNow(new Map(written).set("configure.organization", ready([record("p-p1", "Parent renamed again"), parents[1]])), "resources.inventory")), false, "a new move")
    assert.equal(sameSources(undefined, asked), false, "never asked")
  })

  test("a read again to no change keeps the rows the store holds, so nothing that read them moves; a moved row is the read's", async () => {
    const store = await read(new Map([["configure.organization", ready(parents)]]), childrenOf([thing("c1", "Child", "p1"), thing("c2", "Second", "p2")]))
    const before = store.getSnapshot().get("resources.inventory")?.records ?? []
    await readModuleInto(store, client, childrenOf([thing("c1", "Child", "p1"), thing("c2", "Second", "p2")]), { alive: () => true })
    assert.equal(store.getSnapshot().get("resources.inventory")?.records, before, "the same rows")
    await readModuleInto(store, client, childrenOf([thing("c1", "Child", "p1"), thing("c2", "Second renamed", "p2")]), { alive: () => true })
    const after = store.getSnapshot().get("resources.inventory")?.records ?? []
    assert.equal(after[0], before[0], "the unmoved row is the one held")
    assert.notEqual(after[1], before[1])
    assert.equal(after[1].name, "Second renamed")
  })

  test("notes the project's day on each clock it read one on, and is read again at that day's turn there", () => {
    const evening = new Date("2026-10-24T21:00:00Z") // 23:00 in Copenhagen, summer time
    const dated: ServerModule = {
      ...childrenOf([]),
      resources: [{ ...thingAdapter("c", []), toRecord: (candidate: Thing, context) => record(`c-${candidate.id}`, candidate.name, { value: todayIn(context, "Europe/Copenhagen") }) }],
    }
    const result = mapModule(dated, [[thing("c1", "Child")]], { state: new Map(), now: evening })
    assert.equal(result.records[0].value, "2026-10-24")
    assert.deepEqual([...(result.reads?.days ?? [])], [["Europe/Copenhagen", "2026-10-24"]])
    const state: ServerRecordsState = new Map([["resources.inventory", loaded(result, evening.getTime())]])
    assert.deepEqual(clocksRead(state), ["Europe/Copenhagen"])
    const keys = (modules: ServerModule[]) => modules.map((module) => `${module.workspaceId}.${module.moduleId}`)
    assert.deepEqual(keys(dayTurnRereads(state, [dated], Date.parse("2026-10-24T21:59:00Z"))), [], "still the 24th in Copenhagen")
    assert.deepEqual(keys(dayTurnRereads(state, [dated], Date.parse("2026-10-24T22:01:00Z"))), ["resources.inventory"], "the 25th there, while UTC is still on the 24th")
    const undated = mapModule(childrenOf([]), [[thing("c1", "Child")]], { state: new Map(), now: evening })
    assert.deepEqual(dayTurnRereads(new Map([["resources.inventory", loaded(undated, evening.getTime())]]), [dated], Date.parse("2026-10-26T12:00:00Z")), [], "a module that read no day")
  })

  test("a project's day has turned between two instants on its own clock, and the next turn is the first of its projects'", () => {
    const before = Date.parse("2026-10-24T21:59:00Z") // 23:59 in Copenhagen (summer time)
    const after = Date.parse("2026-10-24T22:01:00Z")
    assert.equal(dayTurned(before, after, ["Europe/Copenhagen"]), true)
    assert.equal(dayTurned(before, after, ["UTC"]), false)
    assert.equal(dayTurned(before, after, ["UTC", "Europe/Copenhagen"]), true)
    const nine = Date.parse("2026-10-24T21:00:00Z")
    assert.ok(Math.abs(untilDayTurns(nine, ["Europe/Copenhagen"]) - 60 * 60 * 1000) <= 1000, "an hour to Copenhagen's midnight")
    assert.ok(Math.abs(untilDayTurns(nine, ["UTC", "Europe/Copenhagen"]) - 60 * 60 * 1000) <= 1000, "the first of them")
  })
})

// A row keeps the web id the store holds it under across the session's reads of its module (#240): the address bar,
// the selection and every link that names a row made this session hold the id it was minted under, and a read again
// — a command's touches, the Live board's, a derived module's — maps it afresh under the adapter's id. So the mapping
// keeps the id the store holds the same server row under, and a session's first read takes the adapter's.
describe("a module read again", () => {
  const thing = (id: string, name: string, parentId?: string): Thing => ({ id, createdAt: "", updatedAt: "", name, ...(parentId === undefined ? {} : { parentId }) })
  const inventory = (...resources: ResourceAdapter<Thing>[]): ServerModule => ({ workspaceId: "resources", moduleId: "inventory", resources })
  const holding = (records: BusinessRecord[], serverIds: [string, string][]): ServerRecordsState => new Map([["resources.inventory", loaded({ records, serverIds: new Map(serverIds) }, 1)]])
  const minted = (): ServerRecordsState => {
    const [, ready] = [...holding([record("t-1", "One")], [["t-1", "1"]])][0]
    return new Map([["resources.inventory", withCreated(ready, "mint-1", record("t-new-1", "New"), "new-1")]])
  }
  const ids = (result: { serverIds: ReadonlyMap<string, string> }) => [...result.serverIds].map(([webId, serverId]) => `${serverId}:${webId}`).sort()
  /** Rows whose mapped id the test names by thing name. */
  const named = (things: Thing[], idOf: Record<string, string>): ResourceAdapter<Thing> => ({ ...thingAdapter("t", things), toRecord: (candidate) => record(idOf[candidate.name] ?? `t-${candidate.id}`, candidate.name) })
  /** Children naming their parent by the web id the resolver answers for its server id. */
  const children = (things: Thing[]): ResourceAdapter<Thing> => ({
    ...thingAdapter("c", things),
    toRecord: (candidate, context) => {
      const parent = candidate.parentId === undefined ? undefined : context.resolve.byServerId(candidate.parentId)
      return record(`c-${candidate.id}`, candidate.name, { facts: parent === undefined ? {} : { Parent: parent.name }, submittedValues: { parentId: parent?.id ?? "" } })
    },
  })

  test("keeps the web id the store holds each server row under: a row made this session stays under the id it was minted", async () => {
    const module = inventory(thingAdapter("t", [thing("1", "One"), thing("new-1", "New")]))
    const result = await loadModule(client, module, options(minted()))
    assert.deepEqual(result.records.map((row) => row.id), ["t-1", "mint-1"])
    assert.deepEqual(ids(result), ["1:t-1", "new-1:mint-1"])
    assert.deepEqual((await loadModule(client, module, options())).records.map((row) => row.id), ["t-1", "t-new-1"], "a first read takes the adapter's ids")
  })

  test("an id held for one row is never lent to another: the row it names keeps it, and a row the mapping now matches onto it takes the server's", async () => {
    // Row 1 was f-1 by its name, and is renamed; row 2 is now named as row 1 was.
    const held = holding([record("f-1", "Fixture")], [["f-1", "1"]])
    for (const order of [[thing("1", "Renamed"), thing("2", "Fixture")], [thing("2", "Fixture"), thing("1", "Renamed")]]) {
      const result = await loadModule(client, inventory(named(order, { Fixture: "f-1" })), options(held))
      assert.deepEqual(ids(result), ["1:f-1", "2:t-2"], `an open details or edit on f-1 stays on row 1 (${order.map((row) => row.id).join(",")})`)
    }
  })

  test("which id a row keeps never hangs on the list's order", async () => {
    // A swap: row 1 now maps to row 2's id, and row 2 to row 1's.
    const held = holding([record("f-1", "A"), record("t-2", "B")], [["f-1", "1"], ["t-2", "2"]])
    for (const order of [[thing("1", "B"), thing("2", "A")], [thing("2", "A"), thing("1", "B")]]) {
      const result = await loadModule(client, inventory(named(order, { A: "f-1", B: "t-2" })), options(held))
      assert.deepEqual(ids(result), ["1:f-1", "2:t-2"], order.map((row) => row.id).join(","))
    }
  })

  test("a row naming another of the read names it by the id it keeps, and as the read lists it", async () => {
    const held = holding([record("mint-p", "Parent"), record("c-c1", "Child")], [["mint-p", "p1"], ["c-c1", "c1"]])
    const module = inventory(thingAdapter("p", [thing("p1", "Parent renamed")]), children([thing("c1", "Child", "p1")]))
    const result = await loadModule(client, module, options(held))
    assert.equal(result.records[0].id, "mint-p")
    assert.equal(result.records[1].submittedValues?.parentId, "mint-p")
    assert.equal(result.records[1].facts.Parent, "Parent renamed", "the load's row, not the store's")
  })

  test("a row made while the read is out keeps its minted id, and a row of the read naming it names that id", async () => {
    const store = createExternalStore<ServerRecordsState>(holding([record("p-p1", "One")], [["p-p1", "p1"]]))
    const parents: ResourceAdapter<Thing> = {
      ...thingAdapter("p", []),
      list: async () => {
        // The create's answer lands while the read is out.
        store.set((state) => new Map(state).set("resources.inventory", withCreated(state.get("resources.inventory") ?? IDLE, "mint-p2", record("p-p2", "Two"), "p2")))
        return [thing("p1", "One"), thing("p2", "Two")]
      },
    }
    await readModuleInto(store, client, inventory(parents, children([thing("c1", "Child", "p2")])), { alive: () => true })
    const read = store.getSnapshot().get("resources.inventory")
    assert.deepEqual(read?.records.map((row) => row.id), ["p-p1", "mint-p2", "c-c1"])
    assert.equal(read?.records[2].submittedValues?.parentId, "mint-p2")
  })

  test("a create answered after a read that already holds its row takes that row's place: one server row is one row", () => {
    const [, readFirst] = [...holding([record("t-1", "One"), record("t-new-1", "New")], [["t-1", "1"], ["t-new-1", "new-1"]])][0]
    const created = withCreated(readFirst, "mint-1", record("t-new-1", "New"), "new-1")
    assert.deepEqual(created.records.map((row) => row.id), ["mint-1", "t-1"])
    assert.deepEqual([...created.serverIds].sort(), [["mint-1", "new-1"], ["t-1", "1"]])
  })

  test("after a create and a read again, the row is found by its minted id and a link naming it resolves", async () => {
    const store = createExternalStore<ServerRecordsState>(minted())
    await readModuleInto(store, client, inventory(thingAdapter("t", [thing("1", "One"), thing("new-1", "New")])), { alive: () => true })
    const state = store.getSnapshot()
    assert.deepEqual(state.get("resources.inventory")?.records.map((row) => row.id), ["t-1", "mint-1"])
    const resolve = resolverOver(state)
    assert.equal(resolve.serverIdOf("mint-1"), "new-1", "a picker value naming it still names the server's row")
    assert.equal(resolve.byServerId("new-1")?.id, "mint-1", "a row read after, linking to it by server id, names it by the minted id")
  })
})

// A write the API took whose answer could not be mapped into a record (#243) has landed: a resubmit would make the
// row a second time. So it is neither a refusal nor a rejection — the row stays as typed, under the server id the
// answer named, so a second save is a patch; the store reads the module again and says it was saved.
describe("a write the API took", () => {
  const unmappable = (): ResourceAdapter<Thing> & { calls: string[] } => ({
    ...thingAdapter("t", []),
    toRecord: () => {
      throw new TypeError("Cannot read properties of undefined (reading 'name')")
    },
  })
  const module = (resource: ResourceAdapter<Thing>): ServerModule => ({ workspaceId: "configure", moduleId: "organization", resources: [resource] })
  const typed = record("t-mint-1", "New thing")

  test("a create the API answered 201 whose answer cannot be mapped has landed, under the server id it named, never a refusal", async () => {
    const resource = unmappable()
    const outcome = await writeRecord(client, module(resource), loaded({ records: [], serverIds: new Map() }, 1), typed, options())
    assert.equal(outcome.kind, "landed")
    if (outcome.kind !== "landed") return
    assert.deepEqual([outcome.recordId, outcome.serverId], ["t-mint-1", "new-1"])
    assert.match(outcome.problem.detail ?? "", /reading 'name'/)
    assert.deepEqual(resource.calls, ['create {"name":"New thing"}'])
  })

  test("a create the API answered with no row id has landed, and the store drops its row for the module's read again to bring", async () => {
    const resource: ResourceAdapter<Thing> = { ...thingAdapter("t", []), create: async () => undefined as unknown as Thing }
    const outcome = await writeRecord(client, module(resource), loaded({ records: [], serverIds: new Map() }, 1), typed, options())
    assert.deepEqual(outcome.kind === "landed" ? [outcome.recordId, outcome.serverId] : outcome.kind, ["t-mint-1", undefined])
    const settled = withOutcome(withRecord(loaded({ records: [], serverIds: new Map() }, 1), typed), outcome, typed, undefined)
    assert.deepEqual(settled.records, [], "kept as typed with no server id, a second save would create it again")
  })

  test("a patch the API answered whose answer cannot be mapped has landed too", async () => {
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(unmappable()), current, record("t-1", "One renamed"), options())
    assert.deepEqual(outcome.kind === "landed" ? [outcome.recordId, outcome.serverId] : outcome.kind, ["t-1", "1"])
  })

  test("a write refused after part of it landed, whose part cannot be mapped, is still the refusal, and never throws", async () => {
    const resource: ResourceAdapter<Thing> = {
      ...unmappable(),
      update: async () => {
        throw new PartialWrite(new ApiProblem({ type: "about:blank", title: "Conflict", status: 409, detail: "The set moved" }), { id: "1", createdAt: "", updatedAt: "", name: "One renamed" })
      },
    }
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const outcome = await writeRecord(client, module(resource), current, record("t-1", "One renamed"), options())
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.detail, "The set moved")
    assert.equal(outcome.record, undefined, "the row as the server holds it could not be mapped; the module is read again for it")
  })

  test("the store keeps a landed row as typed under its own id with the server id behind it, so a second save is a patch and never a second create", async () => {
    const current = loaded({ records: [typed], serverIds: new Map() }, 1)
    const settled = withOutcome(current, { kind: "landed", recordId: typed.id, serverId: "new-1", problem: genericProblem(0, "boom") }, typed, undefined)
    assert.deepEqual(settled.records.map((row) => row.id), ["t-mint-1"])
    assert.equal(settled.serverIds.get("t-mint-1"), "new-1")
    assert.equal(settled.problem, null, "it was saved: no problem stands against the module")
    const resource = thingAdapter("t", [])
    const again =await writeRecord(client, module(resource), settled, record("t-mint-1", "New thing, renamed"), options())
    assert.equal(again.kind, "updated")
    assert.deepEqual(resource.calls, ['update new-1 {"name":"New thing, renamed"}'])
  })

  test("the store settles every other outcome as it did: a create under its minted id, a patch in place, nothing for nothing moved, a refusal rolled back", () => {
    const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
    const created = withOutcome(current, { kind: "created", record: record("t-new-1", "New"), serverId: "new-1", optimisticId: "t-mint-1" }, typed, undefined)
    assert.deepEqual(created.records.map((row) => row.id), ["t-mint-1", "t-1"])
    const updated = withOutcome(current, { kind: "updated", record: record("t-1", "One renamed"), serverId: "1" }, record("t-1", "One renamed"), record("t-1", "One"))
    assert.equal(updated.records[0].name, "One renamed")
    assert.equal(withOutcome(current, { kind: "unchanged", record: record("t-1", "One") }, record("t-1", "One"), record("t-1", "One")), current)
    const optimistic = withRecord(current, record("t-1", "One renamed"))
    const refused = withOutcome(optimistic, { kind: "refused", recordId: "t-1", problem: genericProblem(409, "No") }, record("t-1", "One renamed"), record("t-1", "One"))
    assert.deepEqual([refused.records[0].name, refused.problem?.detail], ["One", "No"])
    const createRefused = withOutcome(withRecord(current, typed), { kind: "refused", recordId: "t-mint-1", problem: genericProblem(400, "No") }, typed, undefined)
    assert.deepEqual(createRefused.records.map((row) => row.id), ["t-1"])
  })
})

// A write in several requests — a mutation, then the row read back, or a second mutation (#263): where one landed, the
// store tells what followed apart without the adapter's help. Where no mutation failed — a read back, a mapper, an
// answer's body — it has landed, as an unmappable answer has (#243); where a later mutation failed it is a partial
// refusal, the row kept as typed and the module read again, never put back as the server no longer holds it. A command
// whose movement landed with no mutation failing has landed too: the store reads its row again and answers done.
describe("a write or a command of several requests that fails after one landed", () => {
  const twoStep = (second: "read" | "write"): ResourceAdapter<Thing> => ({
    ...thingAdapter("t", []),
    update: async (client, serverId, body) => {
      await patch<Thing>(client, `/things/${serverId}`, body)
      return second === "read" ? get<Thing>(client, `/things/${serverId}`) : put<Thing>(client, `/things/${serverId}/set`, { ids: [] })
    },
    commands: {
      move: {
        refused: (row) => `${row.name} was not moved`,
        touches: ["resources.inventory"],
        run: async (client, serverId) => {
          await command(client, `/things/${serverId}/move`, {})
          return get<Thing>(client, `/things/${serverId}`)
        },
      },
    },
  })
  const moduleOf = (resource: ResourceAdapter<Thing>): ServerModule => ({ workspaceId: "configure", moduleId: "organization", resources: [resource] })
  const current = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 1)
  const unavailable = () => problem(503, "The API is unavailable")

  test("a patch that landed and a read back that failed has landed, under the row's server id, with the read's problem", async () => {
    const { fetch, calls } = scripted([() => json({ id: "1", createdAt: "", updatedAt: "", name: "One renamed" }), unavailable])
    const outcome = await writeRecord(clientOver(fetch), moduleOf(twoStep("read")), current, record("t-1", "One renamed"), options())
    assert.deepEqual(calls.map((call) => call.init.method), ["PATCH", "GET"])
    assert.deepEqual(outcome.kind === "landed" ? [outcome.recordId, outcome.serverId, outcome.problem.detail] : outcome.kind, ["t-1", "1", "The API is unavailable"])
  })

  test("a patch that landed and a second write refused is a partial refusal in the API's words; one refused at the first request is a refusal alone", async () => {
    const partly = scripted([() => json({ id: "1", createdAt: "", updatedAt: "", name: "One renamed" }), () => problem(409, "The set moved")])
    const outcome = await writeRecord(clientOver(partly.fetch), moduleOf(twoStep("write")), current, record("t-1", "One renamed"), options())
    assert.deepEqual(outcome.kind === "refused" ? [outcome.problem.detail, outcome.partial] : outcome.kind, ["The set moved", true])
    const refused = scripted([() => problem(409, "Taken")])
    const first = await writeRecord(clientOver(refused.fetch), moduleOf(twoStep("write")), current, record("t-1", "One renamed"), options())
    assert.deepEqual(first.kind === "refused" ? [first.problem.detail, first.partial] : first.kind, ["Taken", undefined], "nothing landed: the row goes back as it was")
  })

  test("a write whose mutation landed and whose answer the adapter's own mapping threw on has landed, never a partial refusal: no mutation failed", async () => {
    const throwing: ResourceAdapter<Thing> = {
      ...thingAdapter("t", []),
      update: async (client, serverId, body) => {
        await patch<Thing>(client, `/things/${serverId}`, body)
        throw new TypeError("Cannot read properties of undefined (reading 'body')")
      },
    }
    const { fetch } = scripted([() => json({ id: "1", createdAt: "", updatedAt: "", name: "One renamed" })])
    const outcome = await writeRecord(clientOver(fetch), moduleOf(throwing), current, record("t-1", "One renamed"), options())
    assert.deepEqual(outcome.kind === "landed" ? [outcome.recordId, outcome.serverId] : outcome.kind, ["t-1", "1"])
  })

  test("a partial refusal keeps the row as typed with the problem, so a second save sends only what moved since; the module's read again says how it stands", () => {
    const typed = record("t-1", "One renamed")
    const settled = withOutcome(current, { kind: "refused", recordId: "t-1", problem: genericProblem(409, "The set moved"), partial: true }, typed, record("t-1", "One"))
    assert.deepEqual([settled.records[0].name, settled.problem?.detail], ["One renamed", "The set moved"])
  })

  test("a command whose movement landed and whose read back failed has landed, its own module to read again with what it touches", async () => {
    const { fetch } = scripted([() => json({ id: "1", createdAt: "", updatedAt: "", name: "One" }, 201), unavailable])
    const outcome = await commandRecord(clientOver(fetch), moduleOf(twoStep("read")), current, record("t-1", "One"), "move", undefined, options())
    assert.deepEqual(outcome.kind === "landed" ? [outcome.recordId, outcome.serverId, [...outcome.touches].sort()] : outcome.kind, ["t-1", "1", ["configure.organization", "resources.inventory"]], "never refused: sending it again would make a second movement")
    const refused = scripted([() => problem(409, "Not in stock")])
    const notSent = await commandRecord(clientOver(refused.fetch), moduleOf(twoStep("read")), current, record("t-1", "One"), "move", undefined, options())
    assert.deepEqual(notSent.kind === "refused" ? [notSent.problem.detail, [...notSent.touches]] : notSent.kind, ["Not in stock", ["resources.inventory"]], "refused at the movement: what it touches is read again as before, its own row as it was")
  })
})
