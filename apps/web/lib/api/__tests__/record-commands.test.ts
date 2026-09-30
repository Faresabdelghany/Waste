// A command on a server-backed row (Issue #163): `POST /users/:id/deactivate`
// and `/reactivate` sent through the user adapter's commands and the record
// store's seam, `commandRecord` — the path, the empty body, the answer put
// back under the row's own web id, and a refusal handed back as the API's
// problem with the sentence the person is told it under. A command that says
// something (Issue #181: a container received into a warehouse, an
// allocation released with a reason) maps the dialog's input to its body
// through the adapter's `toBody`, web ids through the resolver, and a body
// the adapter refuses never leaves the browser.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Role, User } from "@waste/contracts/access"

import { getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { command } from "../client"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type LocalRefusal, type MappingContext, type ResourceAdapter, type Resource, type ServerModule } from "../records/adapter"
import { accessModule, DEACTIVATE_USER, REACTIVATE_USER, roleAdapter, userAdapter } from "../records/organisation"
import { commandRecord, loaded, resolverOver, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-25T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const fixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "access" })?.records ?? []
const context = (resolve = NOTHING_RESOLVED): MappingContext => ({ fixtures, resolve, now: NOW })

const administrator: Role = {
  id: "01a0d2a4-a280-7004-8000-000000000001",
  ...STAMPS,
  key: "company-administrator",
  name: "Company Administrator",
  scope: "Company",
  description: "Company, projects, users, and settings",
  system: true,
  grants: [],
}
const olivia: User = {
  id: "01a0d2a4-a280-7005-8000-000000000001",
  ...STAMPS,
  email: "olivia.larsen@kystbyen.example",
  fullName: "Olivia Larsen",
  status: "active",
  roleId: administrator.id,
  allProjects: true,
  projectIds: [],
  serviceProviderId: null,
  primaryAdministrator: true,
  deactivatedAt: null,
}
const viewer: User = { ...olivia, id: "019995e0-0000-7000-8000-0000000000bb", email: "viewer@kystbyen.example", fullName: "Viewer Person", primaryAdministrator: false }

const administratorRecord = roleAdapter.toRecord(administrator, context())
const roleState: ServerRecordsState = new Map([["configure.access", loaded({ records: [administratorRecord], serverIds: new Map([[administratorRecord.id, administrator.id]]) }, 1)]])
const resolve = resolverOver(roleState)
const oliviaRecord = userAdapter.toRecord(olivia, context(resolve))
const viewerRecord = userAdapter.toRecord(viewer, context(resolve))

const current = loaded(
  {
    records: [administratorRecord, oliviaRecord, viewerRecord],
    serverIds: new Map([
      [administratorRecord.id, administrator.id],
      [oliviaRecord.id, olivia.id],
      [viewerRecord.id, viewer.id],
    ]),
  },
  1,
)
const state: ServerRecordsState = new Map([["configure.access", current]])
const options = { fixtures, state, now: NOW }

describe("deactivate and reactivate", () => {
  test("deactivate posts to the row's own command path with no body, and the answer replaces the row, deactivated", async () => {
    const { fetch, calls } = scripted([() => json({ ...viewer, status: "deactivated", deactivatedAt: "2026-09-25T10:00:00.000Z" })])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, DEACTIVATE_USER, undefined, options)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `http://api.test/users/${viewer.id}/deactivate`)
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.body, undefined, "a command carries no body")
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, viewerRecord.id)
    assert.equal(outcome.record.status, "Deactivated")
    assert.equal(outcome.record.facts.Roles, "Company Administrator", "the answer is mapped like a read, its role resolved")
    assert.equal(outcome.serverId, viewer.id)
  })

  test("reactivate posts to its path and the row is active again", async () => {
    const { fetch, calls } = scripted([() => json({ ...viewer, status: "active", deactivatedAt: null })])
    const deactivated = { ...viewerRecord, status: "Deactivated" }
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, deactivated, REACTIVATE_USER, undefined, options)
    assert.equal(calls[0].url, `http://api.test/users/${viewer.id}/reactivate`)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Active")
  })

  test("a row the workspace minted this session keeps its minted id when the answer comes back", async () => {
    const minted: BusinessRecord = { ...viewerRecord, id: "access-user-mint-1" }
    const held = loaded({ records: [minted], serverIds: new Map([["access-user-mint-1", viewer.id]]) }, 1)
    const { fetch } = scripted([() => json({ ...viewer, status: "deactivated", deactivatedAt: "2026-09-25T10:00:00.000Z" })])
    const outcome = await commandRecord(clientOver(fetch), accessModule, held, minted, DEACTIVATE_USER, undefined, { ...options, state: new Map([["configure.access", held]]) })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, "access-user-mint-1")
    assert.equal(outcome.serverId, viewer.id)
  })

  test("the primary administrator's 409 comes back as the API words it, under a heading naming the person", async () => {
    const detail = "The primary administrator cannot be deactivated: it is the company's last way in"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, oliviaRecord, DEACTIVATE_USER, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 409)
    assert.equal(problemSentence(outcome.problem), detail)
    assert.equal(outcome.what, "Olivia Larsen was not deactivated")
    assert.equal(outcome.recordId, oliviaRecord.id)
  })

  test("a permission 403 is a refusal like any other: the sentence is the API's and the session is nobody's business here", async () => {
    const { fetch } = scripted([() => problem(403, "Your role does not allow edit on configure.access")])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, REACTIVATE_USER, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.type, "about:blank")
    assert.equal(outcome.what, "Viewer Person was not reactivated")
  })

  test("a row the server does not hold yet is refused before any request", async () => {
    const minted: BusinessRecord = { ...viewerRecord, id: "access-user-mint-2" }
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, minted, DEACTIVATE_USER, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.match(outcome.problem.detail ?? "", /not on the API yet/)
    assert.equal(outcome.what, "Viewer Person was not deactivated")
  })

  test("a command the adapter does not have is refused before any request", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, "vanish", undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.match(outcome.problem.detail ?? "", /has no "vanish" for a user/)
  })

  test("a record no adapter owns is refused with a sentence", async () => {
    const { fetch, calls } = scripted([])
    const stranger: BusinessRecord = { ...viewerRecord, id: "elsewhere-1", recordKind: undefined }
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, stranger, DEACTIVATE_USER, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.match(outcome.problem.detail ?? "", /has no server resource for elsewhere-1/)
  })

  test("the user adapter has exactly the two commands the pane offers, and the role adapter none", () => {
    assert.deepEqual(Object.keys(userAdapter.commands ?? {}).sort(), [DEACTIVATE_USER, REACTIVATE_USER].sort())
    assert.equal(roleAdapter.commands, undefined)
    const module: ServerModule = accessModule
    assert.deepEqual(module.resources.map((resource) => resource.prefix), ["role", "user"])
  })
})

describe("a command that says something", () => {
  // A resource of the test's own, so the seam is held apart from any one
  // module's adapter: a thing tagged with a label and the user it is for.
  type Thing = Resource & { label: string; tag: string | null; forUserId: string | null }
  const thing: Thing = { id: "019995e0-0000-7000-8000-0000000000cc", ...STAMPS, label: "Thing one", tag: null, forUserId: null }
  const TAG = "tag"
  const thingAdapter: ResourceAdapter<Thing> = {
    prefix: "thing",
    owns: (record) => record.id.startsWith("thing-"),
    list: null,
    toRecord: (resource) => ({ ...viewerRecord, id: `thing-${resource.id}`, name: resource.label, facts: { Tag: resource.tag ?? "", For: resource.forUserId ?? "" }, recordKind: "Thing" }),
    toPatchBody: () => null,
    update: () => Promise.reject(new Error("no patch here")),
    commands: {
      [TAG]: {
        toBody: (input, _record, context): unknown | LocalRefusal => {
          // A mapper that trusts its input: a stray object throws here.
          if (typeof input.tag === "object" && input.tag !== null) (input.tag as unknown as string).trim()
          const tag = typeof input.tag === "string" ? input.tag.trim() : ""
          if (tag === "") return { path: "tag", message: "A tag says something" }
          const forUserId = typeof input.forUserId === "string" ? context.resolve.serverIdOf(input.forUserId) : undefined
          if (forUserId === undefined) return { path: "forUserId", message: "Pick a user the API holds" }
          return { tag, forUserId }
        },
        run: (client, serverId, body) => command<Thing>(client, `/things/${serverId}/tag`, body),
        refused: (record) => `${record.name} was not tagged`,
      },
      touch: {
        run: (client, serverId, body) => command<Thing>(client, `/things/${serverId}/touch`, body),
        refused: (record) => `${record.name} was not touched`,
      },
    },
  }
  const thingModule: ServerModule = { workspaceId: "configure", moduleId: "things", resources: [thingAdapter] }
  const thingRecord = thingAdapter.toRecord(thing, context())
  const held = loaded({ records: [thingRecord], serverIds: new Map([[thingRecord.id, thing.id]]) }, 1)
  const withUsers = { fixtures, state: new Map([["configure.access", current], ["configure.things", held]]), now: NOW }

  test("the dialog's input becomes the body through toBody, its web ids resolved, and run posts it", async () => {
    const { fetch, calls } = scripted([() => json({ ...thing, tag: "urgent", forUserId: viewer.id })])
    const outcome = await commandRecord(clientOver(fetch), thingModule, held, thingRecord, TAG, { tag: " urgent ", forUserId: viewerRecord.id }, withUsers)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `http://api.test/things/${thing.id}/tag`)
    assert.deepEqual(bodyOf(calls[0]), { tag: "urgent", forUserId: viewer.id })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, thingRecord.id)
    assert.equal(outcome.record.facts.Tag, "urgent")
  })

  test("a body the adapter refuses never leaves the browser: the refusal names the field, in the API's shape", async () => {
    const { fetch, calls } = scripted([])
    const blank = await commandRecord(clientOver(fetch), thingModule, held, thingRecord, TAG, { tag: " ", forUserId: viewerRecord.id }, withUsers)
    const unknown = await commandRecord(clientOver(fetch), thingModule, held, thingRecord, TAG, { tag: "urgent", forUserId: "user-nobody" }, withUsers)
    assert.deepEqual(calls, [])
    for (const [outcome, path, message] of [[blank, "tag", "A tag says something"], [unknown, "forUserId", "Pick a user the API holds"]] as const) {
      assert.equal(outcome.kind, "refused")
      if (outcome.kind !== "refused") continue
      assert.equal(outcome.problem.status, 400)
      assert.deepEqual(outcome.problem.errors, [{ path, message }])
      assert.equal(outcome.what, "Thing one was not tagged")
    }
  })

  test("a toBody that throws is a refusal under the command's heading, and nothing is sent", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), thingModule, held, thingRecord, TAG, { tag: { not: "a string" }, forUserId: 7 } as unknown as Record<string, unknown>, withUsers)
    assert.deepEqual(calls, [])
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "Thing one was not tagged")
  })

  test("a command with no toBody runs with no body, whatever the caller handed in", async () => {
    const { fetch, calls } = scripted([() => json(thing)])
    const outcome = await commandRecord(clientOver(fetch), thingModule, held, thingRecord, "touch", { stray: "input" }, withUsers)
    assert.equal(calls[0].url, `http://api.test/things/${thing.id}/touch`)
    assert.equal(calls[0].init.body, undefined)
    assert.equal(outcome.kind, "done")
  })
})
