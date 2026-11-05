// Ticket Types (#545 of #544): `/ticket-types` under `configure.templates`,
// each kind's default type, a type's fields and permissions replaced whole;
// and what a ticket is held to by its type — the type `POST /tickets` names
// or takes from the kind, the fields' values a create and a patch hold to the
// type, the patch that moves a ticket to another type, the roles a status
// command is theirs alone, the fields a completion needs, and
// `GET /tickets?ticketTypeId=`; and a type's automation (#546 of #544), its
// actions replaced whole and run as the system on opening and on a status.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { Team } from "@waste/contracts/ticket-teams"
import { DEFAULT_TYPE_OFFERED, TicketType } from "@waste/contracts/ticket-types"
import { Ticket, TicketEvent } from "@waste/contracts/tickets"
import { createDb, type Database } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { ticketEvent } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { AUTOMATION_ACTIONS_MAX, AUTOMATION_DEPTH_MAX, AUTOMATION_SPENT, AUTOMATION_STOPPED } from "@waste/domain/resolution/automation"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, inArray } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_TEAM, NOT_A_USER_ACCOUNT } from "../routes/references"
import { retiredTicketType } from "../routes/statuses"
import { NOT_A_TICKET_TYPE } from "../routes/ticket-type-rules"
import { NOT_A_ROLE, retiredDefault } from "../routes/ticket-types"
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
const EventPage = Page(TicketEvent)

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
    test("lists a company's default type per kind, named after the kind, with no fields and no permissions (provisioning and the migration giving them are the database suite's)", async () => {
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
      const retired = await newType("Retired overflow", "overflow", { status: "inactive" })
      assert.equal((await refused(await olivia(`/ticket-types/${retired.id}`, { method: "PATCH", body: { isDefault: true } }), 409)).detail, retiredDefault("Retired overflow"))
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
      await putPermissions(olivia, type.id, [{ command: "reject", roleIds: [a.roles.administrator.id] }])
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=ticket_type&rowId=${type.id}`)).json()).items
      assert.ok(history.some((event) => event.table === "ticket_type_field" && event.action === "insert"), "a field's row is a set of its type")
      assert.ok(history.some((event) => event.table === "ticket_type_permission" && event.action === "insert"), "a permission's row is a set of its type")
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

    test("a value its field no longer takes is no value: a ticket moved to a type where the key means another thing is short of it at its completion", async () => {
      const typed = await newType("Sack order", "other")
      await ok(await putFields(olivia, typed.id, [{ key: "sacks", label: "Sacks", input: "text" }]), TicketType)
      const counted = await newType("Sack count", "other")
      await ok(await putFields(olivia, counted.id, [{ key: "sacks", label: "Sacks", input: "number", requirement: "to-complete" }]), TicketType)
      const ticket = await opened({ ticketTypeId: typed.id, fieldValues: { sacks: "two" } })
      await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { ticketTypeId: counted.id } }), Ticket)
      const short = await refused(await olivia(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "serviced", note: "Delivered" } }), 409)
      assert.equal(short.detail, `Ticket ${ticket.label} needs Sacks before it is completed`)
    })
  })
  describe("a type's automation (#546 of #544)", () => {
    const newTeam = async (name: string): Promise<Team> => created(olivia, "/teams", await olivia("/teams", { method: "POST", body: { name, memberUserAccountIds: [] } }), Team)
    const putActions = (call: Call, id: string, actions: unknown) => call(`/ticket-types/${id}/actions`, { method: "PUT", body: { actions } })
    const historyOf = async (id: string): Promise<TicketEvent[]> => (await ok(await olivia(`/tickets/${id}/events?limit=100`), EventPage)).items
    const linesOf = async (id: string): Promise<(string | null)[]> => (await historyOf(id)).filter((event) => event.recordedBy === null).map((event) => event.body)
    const ofType = async (id: string): Promise<Ticket[]> => (await ok(await olivia(`/tickets?ticketTypeId=${id}&limit=50`), TicketPage)).items
    const outboxOf = (id: string) =>
      withCompany(pool.db, a.companyId, (tx) =>
        tx
          .select({ kind: outboxEvent.kind, payload: outboxEvent.payload })
          .from(outboxEvent)
          .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, id)))
          .orderBy(asc(outboxEvent.id)),
      )

    test("the actions are replaced whole and read by trigger, each trigger's in the order they run; each names what its kind needs, moves to no status its trigger is, and names the company's team, person and type", async () => {
      const desk = await newTeam("Container desk")
      const type = await newType("Container swap")
      const set = await ok(
        await putActions(olivia, type.id, [
          { trigger: "completed", kind: "send-message", messageTemplateName: "Swap done", recipient: "ticket-customer" },
          { trigger: "opened", kind: "assign-team", teamId: desk.id },
          { trigger: "opened", kind: "set-priority", priority: "high" },
        ]),
        TicketType,
      )
      assert.deepEqual(
        set.actions.map((action) => [action.trigger, action.kind, action.teamId, action.priority, action.messageTemplateName]),
        [
          ["opened", "assign-team", desk.id, null, null],
          ["opened", "set-priority", null, "high", null],
          ["completed", "send-message", null, null, "Swap done"],
        ],
      )
      assert.deepEqual((await ok(await olivia(`/ticket-types/${type.id}`), TicketType)).actions, set.actions)

      const errorsOf = async (actions: unknown) => (await refused(await putActions(olivia, type.id, actions), 400)).errors?.map((error) => [error.path, error.message])
      assert.deepEqual(await errorsOf([{ trigger: "opened", kind: "assign-team" }]), [["actions.0.teamId", "An action to assign to a team names a team"]])
      assert.deepEqual(await errorsOf([{ trigger: "opened", kind: "set-priority", priority: "low", teamId: desk.id }]), [["actions.0.teamId", "An action to set the priority names no team"]])
      assert.deepEqual(await errorsOf([{ trigger: "opened", kind: "set-status", command: "start", resolution: "answered" }]), [["actions.0.resolution", "Only a completion names a resolution"]])
      assert.deepEqual(await errorsOf([{ trigger: "on-hold", kind: "set-status", command: "hold" }]), [["actions.0.command", "A ticket reaching on hold is on hold already; move it to another status"]])
      assert.deepEqual(await errorsOf([{ trigger: "completed", kind: "assign-team", teamId: desk.id }]), [["actions.0.teamId", "A ticket reaching completed is closed and keeps its team"]], "the office's own assign refuses a closed ticket too")
      const [theirs] = (await ok(await other("/ticket-types?kind=other"), TypePage)).items
      assert.deepEqual(
        await errorsOf([
          { trigger: "opened", kind: "assign-team", teamId: a.users.olivia.id },
          { trigger: "opened", kind: "assign-person", userAccountId: a.users.deactivated.id },
          { trigger: "completed", kind: "open-follow-up", followUpTypeId: theirs.id },
        ]),
        [
          ["actions.0.teamId", NOT_A_TEAM],
          ["actions.1.userAccountId", NOT_A_USER_ACCOUNT],
          ["actions.2.followUpTypeId", NOT_A_TICKET_TYPE],
        ],
      )
      assert.deepEqual((await ok(await olivia(`/ticket-types/${type.id}`), TicketType)).actions, set.actions, "a refused set changes nothing")
      assert.deepEqual((await ok(await putActions(olivia, type.id, []), TicketType)).actions, [])
      await refused(await putActions(agent, type.id, []), 403)
    })

    test("on opening the actions run in order as the system, held to none of the type's roles: a move runs its own status's actions before the next, and each leaves its line", async () => {
      const desk = await newTeam("Swap desk")
      const type = await newType("Bin swap request")
      // Olivia may not start one: the system does.
      await ok(await putPermissions(olivia, type.id, [{ command: "start", roleIds: [a.roles.viewer.id] }]), TicketType)
      await ok(
        await putActions(olivia, type.id, [
          { trigger: "opened", kind: "assign-team", teamId: desk.id },
          { trigger: "opened", kind: "set-status", command: "start" },
          { trigger: "in-progress", kind: "set-priority", priority: "critical" },
          { trigger: "opened", kind: "set-priority", priority: "high" },
        ]),
        TicketType,
      )
      const answered = await opened({ ticketTypeId: type.id, priority: "low" })
      assert.deepEqual([answered.teamId, answered.status, answered.priority], [desk.id, "in-progress", "high"], "the 201 answers the ticket as its actions left it")
      assert.deepEqual(await linesOf(answered.id), [
        "Automation of Bin swap request on opening: handed to team Swap desk.",
        "Automation of Bin swap request on opening: moved to in progress.",
        "Automation of Bin swap request on reaching in progress: priority set to critical.",
        "Automation of Bin swap request on opening: priority set to high.",
      ])
    })

    test("a person's completion runs the completion's actions: a follow-up of another type as the ticket's child, which runs its own opening actions; an action that cannot run leaves its line and the rest run", async () => {
      const old = await newType("Old check", "internal-task")
      const check = await newType("Delivery check", "internal-task")
      await ok(await putActions(olivia, check.id, [{ trigger: "opened", kind: "set-priority", priority: "low" }]), TicketType)
      const type = await newType("Container delivery")
      await ok(
        await putActions(olivia, type.id, [
          { trigger: "completed", kind: "open-follow-up", followUpTypeId: old.id },
          { trigger: "completed", kind: "open-follow-up", followUpTypeId: check.id },
          { trigger: "completed", kind: "send-message", messageTemplateName: "Container delivered", recipient: "ticket-customer" },
        ]),
        TicketType,
      )
      assert.equal((await ok(await olivia(`/ticket-types/${old.id}`, { method: "PATCH", body: { status: "inactive" } }), TicketType)).status, "inactive")
      const ticket = await opened({ ticketTypeId: type.id, priority: "medium" })
      assert.deepEqual(await linesOf(ticket.id), [], "no action on opening")
      const completed = await ok(await olivia(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "serviced", note: "Delivered" } }), Ticket)
      assert.equal(completed.status, "completed")
      const [followUp] = await ofType(check.id)
      assert.ok(followUp !== undefined, "the follow-up is opened")
      assert.deepEqual([followUp.kind, followUp.status, followUp.priority, followUp.links.parentTicketId, followUp.createdBy, followUp.subject], ["internal-task", "open", "low", ticket.id, a.users.olivia.id, `Follow-up of ${ticket.label}: A sofa to collect`])
      assert.deepEqual(await linesOf(ticket.id), [
        'Automation of Container delivery on completion: no follow-up opened: the ticket type "Old check" is retired.',
        `Automation of Container delivery on completion: follow-up ${followUp.label} (Delivery check) opened.`,
        'Automation of Container delivery on completion: not sent: this ticket\'s project has no active message template "Container delivered".',
      ])
      assert.deepEqual(await linesOf(followUp.id), ["Automation of Delivery check on opening: priority set to low."])
    })

    test("the body's assignee hears of the ticket as it opened and an action's assignee of its own, once each; a ticket an opening action closed keeps its priority", async () => {
      const handed = await newType("Handed over", "other")
      await ok(await putActions(olivia, handed.id, [{ trigger: "opened", kind: "assign-person", userAccountId: a.users.olivia.id }]), TicketType)
      const ticket = await opened({ ticketTypeId: handed.id, assigneeUserAccountId: a.users.invited.id })
      assert.equal(ticket.assigneeUserAccountId, a.users.olivia.id)
      const news = await outboxOf(ticket.id)
      assert.deepEqual(
        news.map((event) => [event.kind, event.kind === "ticket-assigned" ? Ticket.parse(event.payload).assigneeUserAccountId : null]),
        [
          ["ticket-opened", null],
          ["ticket-assigned", a.users.invited.id],
          ["ticket-assigned", a.users.olivia.id],
        ],
      )

      const closing = await newType("Closed at once", "other")
      await ok(
        await putActions(olivia, closing.id, [
          { trigger: "opened", kind: "set-status", command: "complete", resolution: "no-action" },
          { trigger: "opened", kind: "set-priority", priority: "high" },
        ]),
        TicketType,
      )
      const closed = await opened({ ticketTypeId: closing.id, priority: "low" })
      assert.deepEqual([closed.status, closed.resolution, closed.priority], ["completed", "no-action", "low"])
      assert.deepEqual(await linesOf(closed.id), [
        "Automation of Closed at once on opening: completed, no action.",
        "Automation of Closed at once on opening: priority not set to high: the ticket is completed and keeps its priority.",
      ])
    })

    test("rules that set each other off stop five levels deep and say so", async () => {
      const echo = await newType("Echo", "other")
      await ok(await putActions(olivia, echo.id, [{ trigger: "opened", kind: "open-follow-up", followUpTypeId: echo.id }]), TicketType)
      const first = await opened({ ticketTypeId: echo.id })
      const chain = await ofType(echo.id)
      assert.equal(chain.length, 1 + AUTOMATION_DEPTH_MAX, "the ticket and one follow-up a level")
      const parents = new Set(chain.map((one) => one.links.parentTicketId))
      const last = chain.filter((one) => !parents.has(one.id))
      assert.equal(last.length, 1)
      assert.ok(parents.has(first.id))
      assert.deepEqual(await linesOf(last[0].id), [AUTOMATION_STOPPED])
    })

    test("rules opening several follow-ups each stop at one change's last action, before their tickets multiply", async () => {
      const fan = await newType("Fan-out", "other")
      await ok(
        await putActions(olivia, fan.id, [
          { trigger: "opened", kind: "open-follow-up", followUpTypeId: fan.id },
          { trigger: "opened", kind: "open-follow-up", followUpTypeId: fan.id },
        ]),
        TicketType,
      )
      await opened({ ticketTypeId: fan.id })
      const chain = await ofType(fan.id)
      assert.equal(chain.length, 1 + AUTOMATION_ACTIONS_MAX, "a follow-up an action, and no action past the budget")
      const spent = await withCompany(pool.db, a.companyId, (tx) =>
        tx
          .select({ ticketId: ticketEvent.ticketId })
          .from(ticketEvent)
          .where(and(eq(ticketEvent.companyId, a.companyId), inArray(ticketEvent.ticketId, chain.map((one) => one.id)), eq(ticketEvent.body, AUTOMATION_SPENT))),
      )
      assert.ok(spent.length > 0, "the chain says where it stopped")
    })
  })
})
