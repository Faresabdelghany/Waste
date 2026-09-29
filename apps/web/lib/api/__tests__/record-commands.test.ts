// A command on a server-backed row (Issue #163): `POST /users/:id/deactivate`
// and `/reactivate` sent through the user adapter's commands and the record
// store's seam, `commandRecord` — the path, the empty body, the answer put
// back under the row's own web id, and a refusal handed back as the API's
// problem with the sentence the person is told it under.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Role, User } from "@waste/contracts/access"

import { getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type ServerModule } from "../records/adapter"
import { accessModule, DEACTIVATE_USER, REACTIVATE_USER, roleAdapter, userAdapter } from "../records/organisation"
import { commandRecord, loaded, resolverOver, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, problem, scripted } from "./scripted-fetch"

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
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, DEACTIVATE_USER, options)
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
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, deactivated, REACTIVATE_USER, options)
    assert.equal(calls[0].url, `http://api.test/users/${viewer.id}/reactivate`)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Active")
  })

  test("a row the workspace minted this session keeps its minted id when the answer comes back", async () => {
    const minted: BusinessRecord = { ...viewerRecord, id: "access-user-mint-1" }
    const held = loaded({ records: [minted], serverIds: new Map([["access-user-mint-1", viewer.id]]) }, 1)
    const { fetch } = scripted([() => json({ ...viewer, status: "deactivated", deactivatedAt: "2026-09-25T10:00:00.000Z" })])
    const outcome = await commandRecord(clientOver(fetch), accessModule, held, minted, DEACTIVATE_USER, { ...options, state: new Map([["configure.access", held]]) })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, "access-user-mint-1")
    assert.equal(outcome.serverId, viewer.id)
  })

  test("the primary administrator's 409 comes back as the API words it, under a heading naming the person", async () => {
    const detail = "The primary administrator cannot be deactivated: it is the company's last way in"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, oliviaRecord, DEACTIVATE_USER, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 409)
    assert.equal(problemSentence(outcome.problem), detail)
    assert.equal(outcome.what, "Olivia Larsen was not deactivated")
    assert.equal(outcome.recordId, oliviaRecord.id)
  })

  test("a permission 403 is a refusal like any other: the sentence is the API's and the session is nobody's business here", async () => {
    const { fetch } = scripted([() => problem(403, "Your role does not allow edit on configure.access")])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, REACTIVATE_USER, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.type, "about:blank")
    assert.equal(outcome.what, "Viewer Person was not reactivated")
  })

  test("a row the server does not hold yet is refused before any request", async () => {
    const minted: BusinessRecord = { ...viewerRecord, id: "access-user-mint-2" }
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, minted, DEACTIVATE_USER, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.match(outcome.problem.detail ?? "", /not on the API yet/)
    assert.equal(outcome.what, "Viewer Person was not deactivated")
  })

  test("a command the adapter does not have is refused before any request", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, viewerRecord, "vanish", options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.match(outcome.problem.detail ?? "", /has no "vanish" for a user/)
  })

  test("a record no adapter owns is refused with a sentence", async () => {
    const { fetch, calls } = scripted([])
    const stranger: BusinessRecord = { ...viewerRecord, id: "elsewhere-1", recordKind: undefined }
    const outcome = await commandRecord(clientOver(fetch), accessModule, current, stranger, DEACTIVATE_USER, options)
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
