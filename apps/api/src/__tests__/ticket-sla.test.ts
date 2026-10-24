// A project's ticket SLA (O4 of #290): `GET` and `PUT /projects/:id/ticket-sla`
// under `configure.templates`, the due date `POST /tickets` takes from it when
// its body names none, and `GET /tickets?overdue=`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { TicketSla } from "@waste/contracts/ticket-sla"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ticket history the suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const TicketPage = Page(Ticket)
const AuditPage = Page(AuditEvent)

const NOON = new Date("2026-10-24T12:00:00.000Z")
const HOUR = 60 * 60 * 1000
const at = (hours: number) => new Date(NOON.getTime() + hours * HOUR).toISOString()

describe("a project's ticket SLA", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** On a custom role with `view` on the templates and on the tickets, in Copenhagen alone. */
  let viewer: Call

  const sla = (call: Call, projectId: string) => call(`/projects/${projectId}/ticket-sla`)
  const put = (call: Call, projectId: string, targets: unknown, headers: Record<string, string> = {}) => call(`/projects/${projectId}/ticket-sla`, { method: "PUT", body: { targets }, headers })
  const read = async (response: Response): Promise<TicketSla> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketSla.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const open = async (values: Record<string, unknown>): Promise<Ticket> =>
    created(olivia, "/tickets", await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "Bin left out", description: "Reported by phone", kind: "complaint", ...values } }), Ticket)
  const listed = async (query: string): Promise<string[]> => {
    const response = await olivia(`/tickets?projectId=${a.projects.copenhagen.id}&${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketPage.parse(await response.json()).items.map((ticket) => ticket.id)
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "configure.templates", actions: ["view"] },
      { moduleKey: "operate.tickets", actions: ["view"] },
    ])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("the targets", () => {
    test("a project without targets answers an empty set", async () => {
      assert.deepEqual(await read(await sla(olivia, a.projects.cairo.id)), { projectId: a.projects.cairo.id, targets: [] })
    })

    test("PUT replaces the set and answers it by priority, every kind before the kinds; GET reads the same", async () => {
      const answer = await read(
        await put(olivia, a.projects.harbor.id, [
          { kind: null, priority: "low", hours: 168 },
          { kind: "overflow", priority: "high", hours: 4 },
          { kind: null, priority: "high", hours: 24 },
        ]),
      )
      assert.deepEqual(
        answer.targets.map(({ kind, priority, hours }) => [kind, priority, hours]),
        [
          [null, "high", 24],
          ["overflow", "high", 4],
          [null, "low", 168],
        ],
      )
      assert.deepEqual(await read(await sla(olivia, a.projects.harbor.id)), answer)
    })

    test("a target kept keeps its id and moves its hours, one left out is gone, and the audit log reads each with the reason", async () => {
      const harbor = a.projects.harbor.id
      const first = await read(await put(olivia, harbor, [{ kind: null, priority: "medium", hours: 72 }, { kind: "complaint", priority: "medium", hours: 48 }]))
      const kept = first.targets.find((target) => target.kind === null)
      assert.ok(kept)
      const second = await read(await put(olivia, harbor, [{ kind: null, priority: "medium", hours: 96 }, { kind: null, priority: "critical", hours: 2 }], { "waste-change-reason": "Contract addendum 3" }))
      assert.deepEqual(
        second.targets.map(({ kind, priority, hours }) => [kind, priority, hours]),
        [
          [null, "critical", 2],
          [null, "medium", 96],
        ],
      )
      assert.equal(second.targets.find((target) => target.priority === "medium")?.id, kept.id, "the kept target is the same row")
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=ticket_sla&rowId=${kept.id}`)).json()).items
      assert.deepEqual(
        history.map((event) => [event.action, event.changed.hours, event.reason]),
        [
          ["update", [72, 96], "Contract addendum 3"],
          ["insert", [null, 72], null],
        ],
      )
      // A set of its project: the project's history reads its targets' changes beside its own.
      const projectHistory = AuditPage.parse(await (await olivia(`/audit-events?table=project&rowId=${harbor}`)).json()).items
      assert.ok(projectHistory.some((event) => event.table === "ticket_sla" && event.rowId === kept.id && event.action === "update"))
    })

    test("an unchanged target writes nothing, and an empty set clears the project", async () => {
      const harbor = a.projects.harbor.id
      const before = await read(await put(olivia, harbor, [{ kind: null, priority: "low", hours: 8 }]))
      const again = await read(await put(olivia, harbor, [{ kind: null, priority: "low", hours: 8 }]))
      assert.deepEqual(again, before)
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=ticket_sla&rowId=${before.targets[0].id}`)).json()).items
      assert.deepEqual(history.map((event) => event.action), ["insert"])
      assert.deepEqual((await read(await put(olivia, harbor, []))).targets, [])
    })

    test("a kind and a priority twice, or hours out of range, are 400s at the entry", async () => {
      const twice = await refused(await put(olivia, a.projects.harbor.id, [{ kind: null, priority: "low", hours: 8 }, { kind: null, priority: "low", hours: 9 }]), 400)
      assert.deepEqual(twice.errors?.map((error) => error.path), ["targets.1"])
      const long = await refused(await put(olivia, a.projects.harbor.id, [{ kind: null, priority: "low", hours: 8761 }]), 400)
      assert.deepEqual(long.errors?.map((error) => error.path), ["targets.0.hours"])
    })

    test("another company's project and one the caller does not work in are no project here; view alone cannot PUT", async () => {
      await refused(await sla(other, a.projects.copenhagen.id), 404)
      await refused(await put(other, a.projects.copenhagen.id, []), 404)
      await refused(await sla(viewer, a.projects.harbor.id), 404)
      assert.deepEqual((await read(await sla(viewer, a.projects.copenhagen.id))).targets, [])
      await refused(await put(viewer, a.projects.copenhagen.id, []), 403)
    })
  })

  describe("a ticket's due date", () => {
    before(async () => {
      await read(
        await put(olivia, a.projects.copenhagen.id, [
          { kind: null, priority: "high", hours: 24 },
          { kind: "overflow", priority: "high", hours: 4 },
        ]),
      )
    })

    test("opening without one takes the kind's target, else every kind's, from when it happened: the request's clock when the body names no time", async () => {
      assert.equal((await open({ kind: "overflow", priority: "high" })).dueAt, at(4))
      assert.equal((await open({ kind: "complaint", priority: "high" })).dueAt, at(24))
    })

    test("a complaint made yesterday and recorded today is due by the hours since it was made", async () => {
      const recorded = await open({ kind: "complaint", priority: "high", occurredAt: at(-30) })
      assert.equal(recorded.dueAt, at(-6))
    })

    test("a priority without a target, an explicit null and an explicit date are the opener's", async () => {
      assert.equal((await open({ priority: "medium" })).dueAt, null)
      assert.equal((await open({ kind: "overflow", priority: "high", dueAt: null })).dueAt, null)
      assert.equal((await open({ kind: "overflow", priority: "high", dueAt: at(1) })).dueAt, at(1))
    })

    test("another project's targets are not this one's", async () => {
      const response = await olivia("/tickets", { method: "POST", body: { projectId: a.projects.cairo.id, subject: "Lid broken", description: "Seen on the round", kind: "overflow", priority: "high" } })
      assert.equal(Ticket.parse(await response.json()).dueAt, null)
    })
  })

  describe("the overdue filter", () => {
    test("true is an open ticket past its due date; false is every other — not yet due, without one, or closed", async () => {
      const late = await open({ priority: "low", dueAt: at(-1) })
      const due = await open({ priority: "low", dueAt: at(1) })
      const undated = await open({ priority: "low", dueAt: null })
      const closedLate = await open({ priority: "low", dueAt: at(-2) })
      const rejected = await olivia(`/tickets/${closedLate.id}/reject`, { method: "POST", body: { reason: "Duplicate of an earlier call" } })
      assert.equal(rejected.status, 200)
      const overdue = await listed("overdue=true")
      const notOverdue = await listed("overdue=false")
      assert.ok(overdue.includes(late.id))
      for (const id of [due.id, undated.id, closedLate.id]) {
        assert.ok(!overdue.includes(id), id)
        assert.ok(notOverdue.includes(id), id)
      }
      assert.ok(!notOverdue.includes(late.id))
    })
  })
})
