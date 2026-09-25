// The server-backed half of the record store (Issue #81), without React or a
// browser: a module's states, what `getRecords` answers in each, a load
// through scripted adapters with the resolver seeing what loaded before, an
// optimistic write reconciled or rolled back, and the resolver over several
// modules.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import type { ApiClient } from "../client"
import { genericProblem } from "../problem"
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
  recordsOf,
  refusalProblem,
  resolverOver,
  withCreated,
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

/** An adapter over a scripted list: `things` in, records out, writes recorded. */
function thingAdapter(prefix: string, things: Thing[], calls: string[] = []): ResourceAdapter<Thing> & { calls: string[] } {
  return {
    prefix,
    calls,
    owns: (candidate) => candidate.id.startsWith(`${prefix}-`),
    list: async () => things,
    toRecord: (thing, context) => {
      const parent = thing.parentId === undefined ? undefined : context.resolve.byServerId(thing.parentId)
      return record(`${prefix}-${thing.id}`, thing.name, { facts: parent ? { Parent: parent.name } : {}, updated: context.now?.toISOString() ?? "" })
    },
    toCreateBody: (candidate) => (candidate.name === "" ? { path: "name", message: "A thing needs a name" } : { name: candidate.name }),
    toPatchBody: (before, after) => (before.name === after.name ? null : { name: after.name }),
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

  test("a list that throws fails the load", async () => {
    const broken: ResourceAdapter<Thing> = { ...thingAdapter("b", []), list: async () => { throw new Error("boom") } }
    const module: ServerModule = { workspaceId: "configure", moduleId: "access", resources: [broken] }
    await assert.rejects(() => loadModule(client, module, options()), /boom/)
  })
})

describe("the resolver", () => {
  test("looks across every ready module and the rows being mapped, and misses cleanly", () => {
    const state: ServerRecordsState = new Map([
      ["a", loaded({ records: [record("x-1", "X")], serverIds: new Map([["x-1", "1"]]) }, 1)],
      ["b", loadFailed(IDLE, genericProblem(500))],
    ])
    const extra = { records: [record("y-2", "Y")], serverIds: new Map([["y-2", "2"]]) }
    const resolve = resolverOver(state, extra)
    assert.equal(resolve.byServerId("1")?.name, "X")
    assert.equal(resolve.byServerId("2")?.name, "Y")
    assert.equal(resolve.serverIdOf("y-2"), "2")
    assert.equal(resolve.byServerId("3"), undefined)
    assert.equal(resolve.serverIdOf("nowhere"), undefined)
    assert.equal(NOTHING_RESOLVED.byServerId("1"), undefined)
  })

  test("the company record's id is read off the organisation module once it is ready", () => {
    const state: ServerRecordsState = new Map([["configure.organization", loaded({ records: [record("project-x", "X"), record("company-kystbyen-dk", "K")], serverIds: new Map() }, 1)]])
    assert.equal(companyRecordIdOf(state), "company-kystbyen-dk")
    assert.equal(companyRecordIdOf(new Map()), undefined)
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
