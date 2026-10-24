// The server-backed half of the record store (Issue #81), without React or a
// browser: a module's states, what `getRecords` answers in each, a load
// through scripted adapters with the resolver seeing what loaded before, an
// optimistic write reconciled or rolled back, the resolver over several
// modules, and a module read into the store — the load's read, and the read
// again after a command that changed its rows (Issue #198).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { softDeletedRecord } from "@waste/domain/record-visibility"

import type { BusinessRecord } from "../../data/business-modules"
import { createExternalStore } from "../../external-store"
import type { ApiClient } from "../client"
import { ApiProblem, genericProblem, NO_ACTIVE_ACCOUNT_PROBLEM_TYPE } from "../problem"
import { NOTHING_RESOLVED, PartialWrite, type MappingContext, type Resource, type ResourceAdapter, type ServerModule } from "../records/adapter"
import {
  adapterFor,
  companyRecordIdOf,
  dayTurned,
  dayTurnRereads,
  derivedFromChanged,
  derivedSourcesNow,
  IDLE,
  loadFailed,
  loadModule,
  loaded,
  loading,
  mappedAgainstOf,
  moduleState,
  notGranted,
  paneAnswerOf,
  projectTimezonesOf,
  readModuleInto,
  recordsOf,
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
  type ModuleState,
  type ServerRecordsState,
} from "../records/server-records"

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
const options = (state: ServerRecordsState = new Map(), fixtures: BusinessRecord[] = []) => ({ fixtures, state, now: NOW })

describe("a module's state", () => {
  test("a module the store has not been asked for is idle and answers its fixtures", () => {
    const fixtures = [record("f-1", "Fixture")]
    assert.equal(moduleState(new Map(), "configure", "organization"), IDLE)
    assert.deepEqual(recordsOf(IDLE, fixtures), fixtures)
    assert.notEqual(recordsOf(IDLE, fixtures), fixtures, "a copy, never the fixture array itself")
  })

  test("loading keeps a ready module ready and moves an idle one to loading, clearing the problem", () => {
    assert.equal(loading(IDLE).status, "loading")
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    assert.equal(loading({ ...ready, problem: genericProblem(500) }).status, "ready")
    assert.equal(loading({ ...ready, problem: genericProblem(500) }).problem, null)
  })

  test("a ready module answers the server's records and never the fixtures", () => {
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    assert.deepEqual(
      recordsOf(ready, [record("f-1", "Fixture")]).map((candidate) => candidate.id),
      ["t-1"],
    )
    assert.equal(ready.loadedAt, 5)
  })

  test("a failed first read is failed and answers fixtures; a failed re-read keeps the rows and notes the problem", () => {
    const problem = genericProblem(503)
    const failed = loadFailed(loading(IDLE), problem)
    assert.equal(failed.status, "failed")
    assert.equal(failed.problem, problem)
    assert.deepEqual(recordsOf(failed, [record("f-1", "Fixture")]).map((candidate) => candidate.id), ["f-1"])
    const ready = loaded({ records: [record("t-1", "One")], serverIds: new Map([["t-1", "1"]]) }, 5)
    const stillReady = loadFailed(ready, problem)
    assert.equal(stillReady.status, "ready")
    assert.deepEqual(stillReady.records, ready.records)
    assert.equal(stillReady.problem, problem)
  })

  test("a module the person's role does not view is not granted: its fixtures, as an idle one answers, and the sentence a pane shows, with nothing read", () => {
    const fixtures = [record("f-1", "Fixture")]
    const withheld = notGranted("configure.master")
    assert.equal(withheld.status, "not-granted")
    assert.deepEqual(withheld.problem, { type: "about:blank", title: "Forbidden", status: 403, detail: "Your role does not allow view on configure.master" })
    assert.deepEqual(recordsOf(withheld, fixtures), fixtures)
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

  test("a fixture lends its id to one row: a second row mapped onto the same fixture keeps the server's id, so no two rows share a web id", async () => {
    const twins = thingAdapter("t", [
      { id: "1", createdAt: "", updatedAt: "", name: "Olivia Larsen" },
      { id: "2", createdAt: "", updatedAt: "", name: "Olivia Larsen" },
    ])
    // The way fixtureNamed maps: both rows are "the fixture" by name.
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
  const fixtures = [record("f-1", "Fixture")]

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
    const problem = await readModuleInto(store, client, module, { fixtures, alive: () => true, now: () => 7 })
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
    await readModuleInto(store, client, module, { fixtures, alive: () => true, now: () => 8 })
    assert.deepEqual(whileOut, ["t-1"], "ready with its old rows while the read is out")
    assert.deepEqual(store.getSnapshot().get("resources.inventory")?.records.map((candidate) => candidate.id), ["t-1", "t-2"])
  })

  test("a read that fails leaves a ready module its rows beside the problem, fails one that was not, and hands the problem back", async () => {
    const problem = genericProblem(503, "The API is down")
    const failing = heldModule(async () => {
      throw new ApiProblem(problem)
    })
    const ready = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    assert.deepEqual(await readModuleInto(ready, client, failing, { fixtures, alive: () => true }), problem)
    const kept = ready.getSnapshot().get("resources.inventory")
    assert.deepEqual([kept?.status, kept?.records, kept?.problem], ["ready", oldRows.records, problem])
    const first = createExternalStore<ServerRecordsState>(new Map())
    await readModuleInto(first, client, failing, { fixtures, alive: () => true })
    assert.equal(first.getSnapshot().get("resources.inventory")?.status, "failed")
  })

  test("the account's own refusal comes back and is written nowhere: the session has ended, and /login says why", async () => {
    const refusal = { type: NO_ACTIVE_ACCOUNT_PROBLEM_TYPE, title: "Forbidden", status: 403, detail: "No active account in this company is bound to this login" }
    const refused = heldModule(async () => {
      throw new ApiProblem(refusal)
    })
    const store = createExternalStore<ServerRecordsState>(new Map([["resources.inventory", oldRows]]))
    assert.deepEqual(await readModuleInto(store, client, refused, { fixtures, alive: () => true }), refusal)
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
    await readModuleInto(store, client, outlived, { fixtures, alive: () => alive })
    assert.deepEqual(store.getSnapshot().get("resources.inventory")?.records.map((candidate) => candidate.id), ["t-1"], "the old rows, not the answer")

    let asked = false
    const unasked = heldModule(async () => {
      asked = true
      return things
    })
    const before = store.getSnapshot()
    assert.equal(await readModuleInto(store, client, unasked, { fixtures, alive: () => false }), null)
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

  test("lists every record a predicate holds for once, in load order, the loaded row before the one being mapped again (#207)", () => {
    const state: ServerRecordsState = new Map([
      ["a", loaded({ records: [record("x-1", "X"), record("x-2", "X2")], serverIds: new Map() }, 1)],
      ["b", loaded({ records: [record("z-3", "Z")], serverIds: new Map() }, 1)],
    ])
    const extra = { records: [record("x-1", "X again"), record("x-4", "X4")], serverIds: new Map(), byServerId: new Map() }
    const names = resolverOver(state, extra).filter((candidate) => candidate.id.startsWith("x-")).map((candidate) => candidate.name)
    assert.deepEqual(names, ["X", "X2", "X4"])
    assert.deepEqual(NOTHING_RESOLVED.filter(() => true), [])
  })

  test("the company record's id is read off the organisation module once it is ready, by kind and not by the prefix a customer organisation shares", () => {
    const tenant = record("company-kystbyen-dk", "K", { recordKind: "Company" })
    const state: ServerRecordsState = new Map([[
      "configure.organization",
      loaded({ records: [record("project-x", "X", { recordKind: "Project" }), tenant], serverIds: new Map() }, 1),
    ]])
    assert.equal(companyRecordIdOf(state), "company-kystbyen-dk")
    assert.equal(companyRecordIdOf(new Map()), undefined)
    const customerFirst: ServerRecordsState = new Map([[
      "configure.organization",
      loaded({ records: [record("company-osterbro-housing", "Østerbro Housing", { recordKind: "Contact or Customer Organization" }), tenant], serverIds: new Map() }, 1),
    ]])
    assert.equal(companyRecordIdOf(customerFirst), "company-kystbyen-dk", "a customer organisation's company- record is not the tenant")
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

// A derived module (#232): one whose records are read through others' — a container's place, areas and serving period
// through the agreements, the properties, the points, the areas and the master data — is stamped, when its read lands,
// with those modules' rows as the snapshot its read began with held them, and is read again once one of them has new
// rows since, or its projects' day has turned since it was read.
describe("a module read through others", () => {
  const agreementRows = [record("agreement-1", "AGR-1")]
  const areaRows = [record("area-1", "Indre By")]
  const ready = (records: BusinessRecord[]) => loaded({ records, serverIds: new Map() }, 1)
  const derivedModule = (answer: () => Promise<Thing[]>): ServerModule => ({
    workspaceId: "resources",
    moduleId: "containers",
    resources: [{ ...thingAdapter("t", []), list: answer }],
    derivedFrom: ["customers.agreements", "configure.areas", "customers.shared"],
  })

  test("is stamped with those modules' rows as the snapshot it was mapped against held them, null where one was not ready", () => {
    const state: ServerRecordsState = new Map([
      ["customers.agreements", ready(agreementRows)],
      ["configure.areas", loading(IDLE)],
      ["customers.shared", notGranted("customers.shared")],
    ])
    assert.deepEqual(mappedAgainstOf(derivedModule(async () => []), state), new Map([["customers.agreements", agreementRows], ["configure.areas", null], ["customers.shared", null]]))
    assert.equal(mappedAgainstOf({ workspaceId: "resources", moduleId: "inventory", resources: [] }, state), undefined, "a module read through none")
  })

  test("its read is stamped from the snapshot it began with: a change landing while it is out is still new once it lands", async () => {
    const store = createExternalStore<ServerRecordsState>(new Map([["customers.agreements", ready(agreementRows)], ["configure.areas", ready(areaRows)]]))
    const written = [...agreementRows, record("agreement-2", "AGR-2")]
    const module = derivedModule(async () => {
      store.set((state) => new Map(state).set("customers.agreements", ready(written)))
      return []
    })
    await readModuleInto(store, client, module, { fixtures: [], alive: () => true })
    const derived = store.getSnapshot().get("resources.containers")
    assert.equal(derived?.mappedAgainst?.get("customers.agreements"), agreementRows, "the rows the read began with: the answer is no newer")
    assert.deepEqual(derivedFromChanged(derived, store.getSnapshot()), ["customers.agreements"], "so it is read again")
    await readModuleInto(store, client, derivedModule(async () => []), { fixtures: [], alive: () => true })
    assert.deepEqual(derivedFromChanged(store.getSnapshot().get("resources.containers"), store.getSnapshot()), [], "and once it is, it is current")
  })

  test("a module it is read through with new rows is a change: a write, a read again, one ready after it was read", () => {
    const derived = { ...ready([]), mappedAgainst: new Map([["customers.agreements", agreementRows], ["configure.areas", null]]) }
    const state = (agreements: BusinessRecord[], areas: ModuleState) => new Map([["customers.agreements", ready(agreements)], ["configure.areas", areas]]) as ServerRecordsState
    assert.deepEqual(derivedFromChanged(derived, state(agreementRows, loading(IDLE))), [], "nothing new")
    assert.deepEqual(derivedFromChanged(derived, state([record("agreement-1", "AGR-1 renamed")], loading(IDLE))), ["customers.agreements"])
    assert.deepEqual(derivedFromChanged(derived, state(agreementRows, ready(areaRows))), ["configure.areas"])
  })

  test("one not ready never counts and never loops: not granted, failed, read again and still out; nor while it is not ready itself", () => {
    const derived = { ...ready([]), mappedAgainst: new Map([["customers.agreements", agreementRows], ["customers.shared", null]]) }
    const failedOnce = loadFailed(loading(IDLE), genericProblem(503))
    for (const shared of [notGranted("customers.shared"), failedOnce, loading(IDLE)]) {
      assert.deepEqual(derivedFromChanged(derived, new Map([["customers.agreements", ready(agreementRows)], ["customers.shared", shared]])), [], shared.status)
    }
    const keptRows = loadFailed(ready(agreementRows), genericProblem(503))
    assert.deepEqual(derivedFromChanged({ ...derived, mappedAgainst: new Map([["customers.agreements", keptRows.records]]) }, new Map([["customers.agreements", keptRows]])), [], "a failed read again keeps its rows: nothing new")
    assert.deepEqual(derivedFromChanged({ ...derived, status: "loading" }, new Map([["customers.agreements", ready([])]])), [], "not ready itself")
    assert.deepEqual(derivedFromChanged(ready([]), new Map([["customers.agreements", ready([])]])), [], "never stamped")
  })

  test("a read again is asked for once per change of its sources: a failed one is not asked for again until they change once more", () => {
    const derived = { ...ready([]), mappedAgainst: new Map([["customers.agreements", agreementRows], ["configure.areas", null]]) }
    const written: ServerRecordsState = new Map([["customers.agreements", ready([record("agreement-2", "AGR-2")])]])
    const asked = derivedSourcesNow(derived, written)
    assert.equal(sameSources(asked, derivedSourcesNow(derived, written)), true, "the same change: asked for already")
    assert.equal(sameSources(asked, derivedSourcesNow(derived, new Map([["customers.agreements", ready([record("agreement-3", "AGR-3")])]]))), false, "a new one")
    assert.equal(sameSources(undefined, asked), false, "never asked")
  })

  test("the projects' clocks are the organisation's projects' timezones", () => {
    const organisation = ready([record("company-1", "Kystbyen"), record("project-1", "Copenhagen", { submittedValues: { timezone: "Europe/Copenhagen" } }), record("project-2", "Aarhus", { submittedValues: { timezone: "Europe/Copenhagen" } })])
    assert.deepEqual(projectTimezonesOf(new Map([["configure.organization", organisation]])), ["Europe/Copenhagen"])
    assert.deepEqual(projectTimezonesOf(new Map()), [], "none loaded: the browser's clock")
  })

  test("at the day's turn the modules read on the day are read again, one read through another that is followed by it", () => {
    const areas: ServerModule = { workspaceId: "configure", moduleId: "areas", resources: [], readsTheDay: true }
    const containers: ServerModule = { workspaceId: "resources", moduleId: "containers", resources: [], derivedFrom: ["configure.areas"], readsTheDay: true }
    const yesterday = Date.parse("2026-10-24T12:00:00Z")
    const now = Date.parse("2026-10-25T08:00:00Z")
    const readAt = (at: number) => ({ ...ready([]), loadedAt: at })
    const keys = (modules: ServerModule[]) => modules.map((module) => `${module.workspaceId}.${module.moduleId}`)
    const both = new Map([["configure.areas", readAt(yesterday)], ["resources.containers", readAt(yesterday)]])
    assert.deepEqual(keys(dayTurnRereads(both, [areas, containers], now, ["Europe/Copenhagen"])), ["configure.areas"], "the containers follow the areas' new rows")
    const areasNotGranted = new Map([["configure.areas", notGranted("configure.areas")], ["resources.containers", readAt(yesterday)]])
    assert.deepEqual(keys(dayTurnRereads(areasNotGranted, [areas, containers], now, ["Europe/Copenhagen"])), ["resources.containers"], "nothing to follow: read on their own")
    const today = new Map([["configure.areas", readAt(now)], ["resources.containers", readAt(now)]])
    assert.deepEqual(dayTurnRereads(today, [areas, containers], now, ["Europe/Copenhagen"]), [], "read today already")
    assert.deepEqual(dayTurnRereads(both, [{ ...areas, readsTheDay: undefined }], now, ["Europe/Copenhagen"]), [], "a module not read on the day")
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
  /** Rows whose mapped id the test names by thing name, as a fixture lends its id by name. */
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
    // Row 1 was the fixture's by name, and is renamed; row 2 is now named as the fixture is.
    const held = holding([record("f-1", "Fixture")], [["f-1", "1"]])
    for (const order of [[thing("1", "Renamed"), thing("2", "Fixture")], [thing("2", "Fixture"), thing("1", "Renamed")]]) {
      const result = await loadModule(client, inventory(named(order, { Fixture: "f-1" })), options(held))
      assert.deepEqual(ids(result), ["1:f-1", "2:t-2"], `an open details or edit on f-1 stays on row 1 (${order.map((row) => row.id).join(",")})`)
    }
  })

  test("which id a row keeps never hangs on the list's order", async () => {
    // A swap: row 1 now maps to row 2's id, and row 2 to row 1's fixture id.
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
    await readModuleInto(store, client, inventory(parents, children([thing("c1", "Child", "p2")])), { fixtures: [], alive: () => true })
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
    await readModuleInto(store, client, inventory(thingAdapter("t", [thing("1", "One"), thing("new-1", "New")])), { fixtures: [], alive: () => true })
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
