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
import { NOTHING_RESOLVED, type MappingContext, type Resource, type ResourceAdapter, type ServerModule } from "../records/adapter"
import {
  adapterFor,
  companyRecordIdOf,
  IDLE,
  loadFailed,
  loadModule,
  loaded,
  loading,
  moduleState,
  notGranted,
  paneAnswerOf,
  readModuleInto,
  recordsOf,
  refusalProblem,
  rereadsOf,
  resolverOver,
  spellsStatus,
  withCreated,
  withNotGranted,
  withRecord,
  withoutRecord,
  writeRecord,
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
