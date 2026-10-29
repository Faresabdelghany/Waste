// Ticket teams (O30 of #290, row 7.20): `/teams` and its members under
// `configure.templates`, a project's default team per kind, the team
// `POST /tickets` names or takes from the default, the patch that hands a
// ticket on, and `GET /tickets?teamId=&unassigned=`, the team's queue.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { Team, TicketTeamDefaults } from "@waste/contracts/ticket-teams"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { NOT_A_TEAM, NOT_A_USER_ACCOUNT } from "../routes/references"
import { retiredTeam } from "../routes/statuses"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ticket history the suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const TeamPage = Page(Team)
const TicketPage = Page(Ticket)
const AuditPage = Page(AuditEvent)

describe("ticket teams", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** On a custom role with `view` and `edit` on the tickets alone, in Copenhagen: works tickets, keeps no team. */
  let agent: Call

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async <T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const newTeam = async (name: string, memberUserAccountIds: string[] = []): Promise<Team> => created(olivia, "/teams", await olivia("/teams", { method: "POST", body: { name, memberUserAccountIds } }), Team)
  const putDefaults = (call: Call, projectId: string, defaults: unknown) => call(`/projects/${projectId}/ticket-team-defaults`, { method: "PUT", body: { defaults } })
  const open = async (values: Record<string, unknown>): Promise<Ticket> =>
    created(olivia, "/tickets", await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "Bin left out", description: "Reported by phone", kind: "complaint", ...values } }), Ticket)
  const listed = async (call: Call, query: string): Promise<string[]> =>
    (await ok(await call(`/tickets?projectId=${a.projects.copenhagen.id}&${query}`), TicketPage)).items.map((ticket) => ticket.id)

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

  describe("the teams", () => {
    test("a team is created with its members, read, listed, renamed and retired; its members are replaced whole", async () => {
      const desk = await newTeam("Container desk", [a.users.viewer.id, a.users.olivia.id])
      assert.deepEqual(desk.memberUserAccountIds, [a.users.viewer.id, a.users.olivia.id].sort())
      assert.equal(desk.status, "active")
      assert.deepEqual(await ok(await olivia(`/teams/${desk.id}`), Team), desk)
      assert.ok((await ok(await olivia("/teams"), TeamPage)).items.some((team) => team.id === desk.id))
      const renamed = await ok(await olivia(`/teams/${desk.id}`, { method: "PATCH", body: { name: "Containers" } }), Team)
      assert.equal(renamed.name, "Containers")
      assert.deepEqual(renamed.memberUserAccountIds, desk.memberUserAccountIds, "a patch leaves the members")
      const replaced = await ok(await olivia(`/teams/${desk.id}/members`, { method: "PUT", body: { memberUserAccountIds: [a.users.viewer.id] } }), Team)
      assert.deepEqual(replaced.memberUserAccountIds, [a.users.viewer.id])
      assert.deepEqual((await ok(await olivia(`/teams/${desk.id}`), Team)).memberUserAccountIds, [a.users.viewer.id])
      const retired = await ok(await olivia(`/teams/${desk.id}`, { method: "PATCH", body: { status: "inactive" } }), Team)
      assert.equal(retired.status, "inactive")
      assert.ok((await ok(await olivia("/teams?status=inactive"), TeamPage)).items.some((team) => team.id === desk.id))
      assert.ok(!(await ok(await olivia("/teams?status=active"), TeamPage)).items.some((team) => team.id === desk.id))
    })

    test("a name is one team's; a member is an active account of this company, each once", async () => {
      await newTeam("Billing")
      const taken = await refused(await olivia("/teams", { method: "POST", body: { name: "Billing" } }), 409)
      assert.equal(taken.detail, 'This company already has a team called "Billing"')
      const deactivated = await refused(await olivia("/teams", { method: "POST", body: { name: "Night shift", memberUserAccountIds: [a.users.deactivated.id] } }), 400)
      assert.deepEqual(deactivated.errors, [{ path: "memberUserAccountIds.0", message: NOT_A_USER_ACCOUNT }])
      const theirs = await refused(await olivia("/teams", { method: "POST", body: { name: "Night shift", memberUserAccountIds: [a.users.olivia.id, b.users.olivia.id] } }), 400)
      assert.deepEqual(theirs.errors?.map((error) => error.path), ["memberUserAccountIds.1"])
      await refused(await olivia("/teams", { method: "POST", body: { name: "Night shift", memberUserAccountIds: [a.users.olivia.id, a.users.olivia.id] } }), 400)
    })

    test("the history of a team and of its members is read under the templates' grant", async () => {
      const team = await newTeam("Audited", [a.users.olivia.id])
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=team&rowId=${team.id}`)).json()).items
      assert.ok(history.some((event) => event.table === "team_member" && event.action === "insert"), "a member's row is a set of its team")
    })

    test("another company's team is no team here; the people working tickets read the teams and keep none", async () => {
      const team = await newTeam("Phones")
      await refused(await other(`/teams/${team.id}`), 404)
      await refused(await other(`/teams/${team.id}`, { method: "PATCH", body: { name: "Mine" } }), 404)
      await refused(await other(`/teams/${team.id}/members`, { method: "PUT", body: { memberUserAccountIds: [] } }), 404)
      assert.equal((await ok(await agent(`/teams/${team.id}`), Team)).name, "Phones")
      await refused(await agent("/teams", { method: "POST", body: { name: "Agents" } }), 403)
      await refused(await agent(`/teams/${team.id}`, { method: "PATCH", body: { name: "Agents" } }), 403)
    })
  })

  describe("a project's defaults", () => {
    test("a project without defaults answers none; PUT replaces them in the vocabulary's order of kinds, and GET reads the same", async () => {
      const harbor = a.projects.harbor.id
      assert.deepEqual(await ok(await olivia(`/projects/${harbor}/ticket-team-defaults`), TicketTeamDefaults), { projectId: harbor, defaults: [] })
      const service = await newTeam("Customer service")
      const containers = await newTeam("Container yard")
      const answer = await ok(await putDefaults(olivia, harbor, [{ kind: "complaint", teamId: service.id }, { kind: "container-request", teamId: containers.id }]), TicketTeamDefaults)
      assert.deepEqual(answer.defaults, [
        { kind: "container-request", teamId: containers.id },
        { kind: "complaint", teamId: service.id },
      ])
      assert.deepEqual(await ok(await olivia(`/projects/${harbor}/ticket-team-defaults`), TicketTeamDefaults), answer)
      const moved = await ok(await putDefaults(olivia, harbor, [{ kind: "complaint", teamId: containers.id }]), TicketTeamDefaults)
      assert.deepEqual(moved.defaults, [{ kind: "complaint", teamId: containers.id }])
    })

    test("a kind twice is a 400, another company's team a 400 at its entry, a retired team a 409; another company's project is none here", async () => {
      const harbor = a.projects.harbor.id
      const team = await newTeam("Weekend")
      await refused(await putDefaults(olivia, harbor, [{ kind: "complaint", teamId: team.id }, { kind: "complaint", teamId: team.id }]), 400)
      const theirs = await newTeamOf(other, "Theirs")
      const foreign = await refused(await putDefaults(olivia, harbor, [{ kind: "overflow", teamId: team.id }, { kind: "complaint", teamId: theirs.id }]), 400)
      assert.deepEqual(foreign.errors, [{ path: "defaults.1.teamId", message: NOT_A_TEAM }])
      await olivia(`/teams/${team.id}`, { method: "PATCH", body: { status: "inactive" } })
      const retired = await refused(await putDefaults(olivia, harbor, [{ kind: "overflow", teamId: team.id }]), 409)
      assert.equal(retired.detail, retiredTeam("Weekend"))
      await refused(await putDefaults(other, harbor, []), 404)
      await refused(await putDefaults(agent, a.projects.copenhagen.id, []), 403)
    })
  })

  describe("a ticket's team", () => {
    let service: Team
    let yard: Team

    before(async () => {
      service = await newTeam("Front desk")
      yard = await newTeam("Yard")
      await ok(await putDefaults(olivia, a.projects.copenhagen.id, [{ kind: "complaint", teamId: service.id }, { kind: "overflow", teamId: yard.id }]), TicketTeamDefaults)
    })

    test("a ticket opened without one waits with the project's default for its kind; null is none, and a team named is the opener's", async () => {
      assert.equal((await open({})).teamId, service.id)
      assert.equal((await open({ kind: "overflow" })).teamId, yard.id)
      assert.equal((await open({ kind: "access-issue" })).teamId, null, "a kind without a default")
      assert.equal((await open({ teamId: null })).teamId, null)
      assert.equal((await open({ teamId: yard.id })).teamId, yard.id)
    })

    test("a retired team is named by no new ticket, and its default gives a new ticket none", async () => {
      const retiring = await newTeam("Retiring")
      await ok(await putDefaults(olivia, a.projects.copenhagen.id, [{ kind: "complaint", teamId: service.id }, { kind: "overflow", teamId: yard.id }, { kind: "proof-follow-up", teamId: retiring.id }]), TicketTeamDefaults)
      await olivia(`/teams/${retiring.id}`, { method: "PATCH", body: { status: "inactive" } })
      assert.equal((await open({ kind: "proof-follow-up" })).teamId, null)
      const named = await refused(await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "Photo unclear", description: "Ask the driver", kind: "proof-follow-up", teamId: retiring.id } }), 409)
      assert.equal(named.detail, retiredTeam("Retiring"))
      const foreign = await refused(await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "Photo unclear", description: "Ask the driver", kind: "proof-follow-up", teamId: (await newTeamOf(other, "Elsewhere")).id } }), 400)
      assert.deepEqual(foreign.errors, [{ path: "teamId", message: NOT_A_TEAM }])
    })

    test("the patch hands a ticket to another team or to none; a ticket keeps a team retired after it was named", async () => {
      const ticket = await open({})
      const handed = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { teamId: yard.id } }), Ticket)
      assert.equal(handed.teamId, yard.id)
      const later = await newTeam("Later retired")
      await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { teamId: later.id } }), Ticket)
      await olivia(`/teams/${later.id}`, { method: "PATCH", body: { status: "inactive" } })
      const kept = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { teamId: later.id, subject: "Bin left out again" } }), Ticket)
      assert.equal(kept.teamId, later.id, "the team it waits with is no new reference")
      const gone = await newTeam("Gone")
      await olivia(`/teams/${gone.id}`, { method: "PATCH", body: { status: "inactive" } })
      const moving = await refused(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { teamId: gone.id } }), 409)
      assert.equal(moving.detail, retiredTeam("Gone"))
      const cleared = await ok(await olivia(`/tickets/${ticket.id}`, { method: "PATCH", body: { teamId: null } }), Ticket)
      assert.equal(cleared.teamId, null)
    })

    test("the team's queue is its open tickets nobody works, and anyone with the tickets grant takes one, member or not", async () => {
      const queue = await newTeam("Queue")
      const waiting = await open({ teamId: queue.id })
      const taken = await open({ teamId: queue.id, assigneeUserAccountId: a.users.olivia.id })
      const done = await open({ teamId: queue.id })
      await olivia(`/tickets/${done.id}/reject`, { method: "POST", body: { reason: "Duplicate" } })
      assert.deepEqual(await listed(olivia, `teamId=${queue.id}`), [waiting.id, taken.id, done.id])
      assert.deepEqual(await listed(olivia, `teamId=${queue.id}&open=true&unassigned=true`), [waiting.id])
      assert.deepEqual(await listed(olivia, `teamId=${queue.id}&unassigned=false`), [taken.id])
      // The agent is in no team, and works the queue all the same.
      assert.deepEqual(await listed(agent, `teamId=${queue.id}&open=true&unassigned=true`), [waiting.id])
      const took = await ok(await agent(`/tickets/${waiting.id}/assign`, { method: "POST", body: { assigneeUserAccountId: a.users.viewer.id } }), Ticket)
      assert.equal(took.teamId, queue.id, "taking a ticket leaves its team")
      assert.deepEqual(await listed(olivia, `teamId=${queue.id}&open=true&unassigned=true`), [])
    })
  })

  const newTeamOf = async (call: Call, name: string): Promise<Team> => created(call, "/teams", await call("/teams", { method: "POST", body: { name } }), Team)
})
