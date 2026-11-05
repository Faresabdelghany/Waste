// Ticket Types (#545 of #544): `/ticket-types` under `configure.templates`,
// each kind's default type, a type's fields and permissions replaced whole;
// and what a ticket is held to by its type — the type `POST /tickets` names
// or takes from the kind, the fields' values a create and a patch hold to the
// type, the patch that moves a ticket to another type, the roles a status
// command is theirs alone, the fields a completion needs, and
// `GET /tickets?ticketTypeId=`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { DEFAULT_TYPE_OFFERED, TicketType } from "@waste/contracts/ticket-types"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database } from "@waste/db/client"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { createApp } from "../app"
import { retiredTicketType } from "../routes/statuses"
import { NOT_A_TICKET_TYPE } from "../routes/ticket-type-rules"
import { NOT_A_ROLE } from "../routes/ticket-types"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ticket history the suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const TypePage = Page(TicketType)
const TicketPage = Page(Ticket)
const AuditPage = Page(AuditEvent)

describe("ticket types", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** On a custom role with `view` and `edit` on the tickets alone, in Copenhagen: works tickets, keeps no type. */
  let agent: Call

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async <T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const newType = async (name: string, kind = "container-request", values: Record<string, unknown> = {}): Promise<TicketType> =>
    created(olivia, "/ticket-types", await olivia("/ticket-types", { method: "POST", body: { name, kind, ...values } }), TicketType)
  const putFields = (call: Call, id: string, fields: unknown) => call(`/ticket-types/${id}/fields`, { method: "PUT", body: { fields } })
  const putPermissions = (call: Call, id: string, permissions: unknown) => call(`/ticket-types/${id}/permissions`, { method: "PUT", body: { permissions } })
  const open = (call: Call, values: Record<string, unknown>) => call("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "A sofa to collect", description: "Reported by phone", ...values } })
  const opened = async (values: Record<string, unknown>): Promise<Ticket> => created(olivia, "/tickets", await open(olivia, values), Ticket)
  const defaultOf = async (kind: string): Promise<TicketType> => {
    const [found] = (await ok(await olivia(`/ticket-types?kind=${kind}`), TypePage)).items.filter((type) => type.isDefault)
    assert.ok(found !== undefined, `${kind} has a default type`)
    return found
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "operate.tickets", actions: ["view", "edit"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    agent = callingAs(app, keys, a.users.viewer, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("the types", () => {
    test("a company starts with a default type per kind, named after the kind, with no fields and no permissions", async () => {
      const types = (await ok(await olivia("/ticket-types?limit=200"), TypePage)).items.filter((type) => type.isDefault)
      assert.deepEqual(types.map((type) => [type.kind, type.name]).sort(), TICKET_KINDS.map((kind) => [kind, DEFAULT_TICKET_TYPE_NAMES[kind]]).sort())
      assert.ok(types.every((type) => type.status === "active" && type.fields.length === 0 && type.permissions.length === 0))
    })

    test("a type is created of a kind, read, listed by kind and by status, renamed, described and retired; a name is one type's", async () => {
      const bulky = await newType("Bulky waste collection")
      assert.deepEqual([bulky.kind, bulky.status, bulky.isDefault, bulky.description, bulky.fields, bulky.permissions], ["container-request", "active", false, null, [], []])
      assert.deepEqual(await ok(await olivia(`/ticket-types/${bulky.id}`), TicketType), bulky)
      assert.ok((await ok(await olivia("/ticket-types?kind=container-request"), TypePage)).items.some((type) => type.id === bulky.id))
      assert.ok(!(await ok(await olivia("/ticket-types?kind=complaint"), TypePage)).items.some((type) => type.id === bulky.id))
      const described = await ok(await olivia(`/ticket-types/${bulky.id}`, { method: "PATCH", body: { name: "Bulky waste", description: "A resident's bulky items, collected at the kerb" } }), TicketType)
      assert.deepEqual([described.name, described.description], ["Bulky waste", "A resident's bulky items, collected at the kerb"])
      const retired = await ok(await olivia(`/ticket-types/${bulky.id}`, { method: "PATCH", body: { status: "inactive" } }), TicketType)
      assert.equal(retired.status, "inactive")
      assert.ok((await ok(await olivia("/ticket-types?status=inactive"), TypePage)).items.some((type) => type.id === bulky.id))
      const taken = await refused(await olivia("/ticket-types", { method: "POST", body: { name: "Bulky waste", kind: "other" } }), 409)
      assert.equal(taken.detail, 'This company already has a ticket type called "Bulky waste"')
      await refused(await olivia(`/ticket-types/${bulky.id}`, { method: "PATCH", body: { kind: "other" } }), 400)
    })

    test("making a type its kind's default unmakes the one that was; a default is never retired nor unmade", async () => {
      const before = await defaultOf("overflow")
      const made = await newType("Overflowing bin", "overflow", { isDefault: true })
      assert.equal(made.isDefault, true)
      assert.equal((await ok(await olivia(`/ticket-types/${before.id}`), TicketType)).isDefault, false, "the default that was")
      assert.equal((await refused(await olivia(`/ticket-types/${made.id}`, { method: "PATCH", body: { status: "inactive" } }), 409)).detail, DEFAULT_TYPE_OFFERED)
      await refused(await olivia(`/ticket-types/${made.id}`, { method: "PATCH", body: { isDefault: false } }), 400)
      const back = await ok(await olivia(`/ticket-types/${before.id}`, { method: "PATCH", body: { isDefault: true } }), TicketType)
      assert.equal(back.isDefault, true)
      assert.equal((await ok(await olivia(`/ticket-types/${made.id}`), TicketType)).isDefault, false)
      const kindOpened = await opened({ kind: "overflow" })
      assert.equal(kindOpened.ticketTypeId, before.id, "a ticket opened by kind alone is of its kind's default")
    })

    test("the fields are replaced whole in order, each key once and choices on a choice alone; the permissions name the company's roles", async () => {
      const type = await newType("Container size change")
      const fields = [
        { key: "new-size", label: "New size", input: "choice", choices: ["140 L", "240 L", "370 L"], requirement: "to-open" },
        { key: "note", label: "Note", helpText: "What the driver should know", input: "paragraph" },
      ]
      const withFields = await ok(await putFields(olivia, type.id, fields), TicketType)
      assert.deepEqual(
        withFields.fields.map((field) => [field.key, field.requirement, field.helpText]),
        [
          ["new-size", "to-open", null],
          ["note", "optional", "What the driver should know"],
        ],
      )
      assert.ok(withFields.updatedAt >= type.updatedAt)
      const twice = await refused(await putFields(olivia, type.id, [fields[1], fields[1]]), 400)
      assert.deepEqual(twice.errors, [{ path: "fields.1.key", message: "Name each field's key once" }])
      await refused(await putFields(olivia, type.id, [{ key: "size", label: "Size", input: "choice" }]), 400)
      assert.deepEqual((await ok(await putFields(olivia, type.id, [fields[1]]), TicketType)).fields.map((field) => field.key), ["note"], "a field left out is gone")

      const permitted = await ok(await putPermissions(olivia, type.id, [{ command: "complete", roleIds: [a.roles.administrator.id] }, { command: "reject", roleIds: [] }]), TicketType)
      assert.deepEqual(permitted.permissions, [{ command: "complete", roleIds: [a.roles.administrator.id] }], "a command naming no role is anyone's, and not held")
      const theirs = await refused(await putPermissions(olivia, type.id, [{ command: "complete", roleIds: [a.roles.administrator.id, b.roles.administrator.id] }]), 400)
      assert.deepEqual(theirs.errors, [{ path: "permissions.0.roleIds.1", message: NOT_A_ROLE }])
      await refused(await putPermissions(olivia, type.id, [{ command: "complete", roleIds: [] }, { command: "complete", roleIds: [] }]), 400)
    })

    test("the history of a type, its fields and its permissions is read under the templates' grant", async () => {
      const type = await newType("Audited type")
      await putFields(olivia, type.id, [{ key: "note", label: "Note", input: "text" }])
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=ticket_type&rowId=${type.id}`)).json()).items
      assert.ok(history.some((event) => event.table === "ticket_type_field" && event.action === "insert"), "a field's row is a set of its type")
    })

    test("another company's type is no type here; the people working tickets read the types and keep none", async () => {
      const type = await newType("Phones")
      await refused(await other(`/ticket-types/${type.id}`), 404)
      await refused(await other(`/ticket-types/${type.id}`, { method: "PATCH", body: { name: "Mine" } }), 404)
      await refused(await putFields(other, type.id, []), 404)
      await refused(await putPermissions(other, type.id, []), 404)
      assert.equal((await ok(await agent(`/ticket-types/${type.id}`), TicketType)).name, "Phones")
      await refused(await agent("/ticket-types", { method: "POST", body: { name: "Agents", kind: "other" } }), 403)
      await refused(await putFields(agent, type.id, []), 403)
    })
  })

  describe("a ticket of a type", () => {
    test("a create names its type and takes its kind, or names a kind for its default; a type of another kind, another company's or a retired one is refused", async () => {
      const bulky = await newType("Sofa collection")
      const typed = await opened({ ticketTypeId: bulky.id })
      assert.deepEqual([typed.kind, typed.ticketTypeId, typed.fieldValues], ["container-request", bulky.id, {}])
      assert.equal((await opened({ ticketTypeId: bulky.id, kind: "container-request" })).ticketTypeId, bulky.id, "both, agreeing")
      assert.equal((await opened({ kind: "complaint" })).ticketTypeId, (await defaultOf("complaint")).id)
      const otherKind = await refused(await open(olivia, { ticketTypeId: bulky.id, kind: "complaint" }), 400)
      assert.deepEqual(otherKind.errors, [{ path: "kind", message: "Sofa collection is a type of container request; name that kind or none" }])
      const theirs = await refused(await open(olivia, { ticketTypeId: (await ok(await other("/ticket-types?kind=other"), TypePage)).items[0]?.id }), 400)
      assert.deepEqual(theirs.errors, [{ path: "ticketTypeId", message: NOT_A_TICKET_TYPE }])
      await ok(await olivia(`/ticket-types/${bulky.id}`, { method: "PATCH", body: { status: "inactive" } }), TicketType)
      assert.equal((await refused(await open(olivia, { ticketTypeId: bulky.id }), 409)).detail, retiredTicketType("Sofa collection"))
      await refused(await open(olivia, {}), 400)
    })

    test("a create's values are the type's fields, each one its field takes, with every field required to open", async () => {
      const type = await newType("Garden waste order")
      await ok(
        await putFields(olivia, type.id, [
          { key: "requested-date", label: "Requested date", input: "date", requirement: "to-open" },
          { key: "bags", label: "Bags", input: "number" },
          { key: "decision", label: "Decision", input: "choice", choices: ["Granted", "Refused"], requirement: "to-complete" },
        ]),
        TicketType,
      )
      const missing = await refused(await open(olivia, { ticketTypeId: type.id }), 400)
      assert.deepEqual(missing.errors, [{ path: "fieldValues.requested-date", message: "Fill in Requested date: a ticket of type Garden waste order is opened with it" }])
      const wrong = await refused(await open(olivia, { ticketTypeId: type.id, fieldValues: { "requested-date": "2026-02-30", bags: "two", colour: "green" } }), 400)
      assert.deepEqual(
        wrong.errors?.map((error) => error.path),
        ["fieldValues.requested-date", "fieldValues.bags", "fieldValues.colour"],
      )
      const ticket = await opened({ ticketTypeId: type.id, fieldValues: { "requested-date": "2026-11-12", bags: 4 } })
      assert.deepEqual(ticket.fieldValues, { "requested-date": "2026-11-12", bags: 4 })
      const listed = (await ok(await olivia(`/tickets?projectId=${a.projects.copenhagen.id}&ticketTypeId=${type.id}`), TicketPage)).items.map((item) => item.id)
      assert.deepEqual(listed, [ticket.id])
    })

    test("a patch merges the values, null clearing one, and moves the ticket to another type, its kind following, keeping what it holds", async () => {
      const type = await newType("Missing bin")
      await ok(await putFields(olivia, type.id, [{ key: "bin-size", label: "Bin size", input: "choice", choices: ["140 L", "240 L"] }, { key: "gate-code", label: "Gate code", input: "text" }]), TicketType)
      const ticket = await opened({ ticketTypeId: type.id, fieldValues: { "bin-size": "140 L" } })
      const merged = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { fieldValues: { "gate-code": "1234", "bin-size": null } } }), Ticket)
      assert.deepEqual(merged.fieldValues, { "gate-code": "1234" })
      const unknown = await refused(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { fieldValues: { colour: "red" } } }), 400)
      assert.deepEqual(unknown.errors, [{ path: "fieldValues.colour", message: "Missing bin has no field colour" }])
      const complaint = await defaultOf("complaint")
      const moved = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { ticketTypeId: complaint.id } }), Ticket)
      assert.deepEqual([moved.kind, moved.ticketTypeId, moved.fieldValues], ["complaint", complaint.id, { "gate-code": "1234" }], "a type moved keeps the values the ticket holds")
      const cleared = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { fieldValues: { "gate-code": null } } }), Ticket)
      assert.deepEqual(cleared.fieldValues, {}, "a value no field of the type holds is cleared with null")
      const byKind = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { kind: "access-issue" } }), Ticket)
      assert.deepEqual([byKind.kind, byKind.ticketTypeId], ["access-issue", (await defaultOf("access-issue")).id], "a kind alone is that kind's default type")
    })

    test("a status command a type names roles for is theirs alone, and a completion needs the fields its type requires", async () => {
      const type = await newType("Permit application", "other")
      await ok(await putFields(olivia, type.id, [{ key: "decision", label: "Decision", input: "choice", choices: ["Granted", "Refused"], requirement: "to-complete" }]), TicketType)
      await ok(await putPermissions(olivia, type.id, [{ command: "complete", roleIds: [a.roles.administrator.id] }]), TicketType)
      const ticket = await opened({ ticketTypeId: type.id })
      assert.equal((await ok(await agent(`/tickets/${ticket.id}/start`, { method: "POST", body: {} }), Ticket)).status, "in-progress", "a command the type names no roles for is anyone's who works tickets")
      const notTheirs = await refused(await agent(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "answered", note: "Decided" } }), 403)
      assert.equal(notTheirs.detail, "Only Company Administrator may complete a ticket of type Permit application")
      const short = await refused(await olivia(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "answered", note: "Decided" } }), 409)
      assert.equal(short.detail, `Ticket ${ticket.label} needs Decision before it is completed`)
      await ok(await agent(`/tickets/${ticket.id}`, { method: "PATCH", body: { fieldValues: { decision: "Granted" } } }), Ticket)
      const completed = await ok(await olivia(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "answered", note: "Decided" } }), Ticket)
      assert.equal(completed.status, "completed")
    })
  })
})
