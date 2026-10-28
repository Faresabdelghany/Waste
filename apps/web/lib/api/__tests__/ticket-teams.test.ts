// Ticket teams on the adapter (O30 of #290, row 7.20): a team as the Settings
// pane and the tickets' Team picker read it, its create, its edit — the name
// and the status patched, the members replaced through their own route — a
// ticket's team on the record, in the create and in the patch, the list's
// Team category, and a project's default team per kind as rows and a body.
// Every body is held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { Team, TeamCreate, TeamMembersSet, TeamPatch, TicketTeamDefaultsSet } from "@waste/contracts/ticket-teams"
import { TicketPatch, type Ticket } from "@waste/contracts/tickets"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NO_ONE } from "../../data/properties"
import { createTicketTeamRecord, NO_TEAM, PICK_A_HELD_TEAM, teamDefaultRowsOf, teamDefaultsBodyOf, updateTicketTeamRecord } from "../../data/ticket-teams"
import { ticketListReaders, updateTicketRecord } from "../../data/tickets"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { isTicketTeamRecord, ticketTeamAdapter, ticketTeamsModule } from "../records/ticket-teams"
import { ticketAdapter } from "../records/tickets"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-28T10:00:00Z")
const STAMPS = { createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const oliviaId = "01a0d2a4-a280-7004-8000-000000000001"
const larsId = "01a0d2a4-a280-7004-8000-000000000002"
const deskId = "01a0d2a4-a280-7042-8000-000000000001"
const yardId = "01a0d2a4-a280-7042-8000-000000000002"

const row = (id: string, name: string, recordKind: string): BusinessRecord => ({ ...projectRecord, id, name, recordKind, facts: {}, submittedValues: {} })
const olivia = row(`user-${oliviaId}`, "Olivia Larsen", "User")
const lars = row(`user-${larsId}`, "Lars Holm", "User")

const desk: Team = { id: deskId, ...STAMPS, name: "Container desk", status: "active", memberUserAccountIds: [oliviaId] }
const yard: Team = { id: yardId, ...STAMPS, name: "Yard", status: "inactive", memberUserAccountIds: [] }

const accessState = loaded({ records: [olivia, lars], serverIds: new Map([[olivia.id, oliviaId], [lars.id, larsId]]) }, 1)
const baseState: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["configure.access", accessState],
])
const context: MappingContext = { fixtures: [], resolve: resolverOver(baseState), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const deskRecord = ticketTeamAdapter.toRecord(desk, context)
const yardRecord = ticketTeamAdapter.toRecord(yard, context)
const teamsState = loaded({ records: [deskRecord, yardRecord], serverIds: new Map([[deskRecord.id, deskId], [yardRecord.id, yardId]]) }, 1)
const state: ServerRecordsState = new Map([...baseState, ["configure.templates", teamsState]])
const withTeams: MappingContext = { ...context, resolve: resolverOver(state) }

describe("a ticket team", () => {
  test("is a record of Tickets & communication on the Pilot, loaded before the tickets that name it", () => {
    assert.ok(isServerBacked("configure", "templates"))
    assert.deepEqual(ticketTeamsModule.resources.map((adapter) => adapter.prefix), ["team"])
    assert.ok(SERVER_MODULE_KEYS.indexOf("configure.templates") < SERVER_MODULE_KEYS.indexOf("operate.tickets"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("configure.access") < SERVER_MODULE_KEYS.indexOf("configure.templates"))
  })

  test("reads its name, its status and its members by name, and carries the members by web id", () => {
    assert.equal(deskRecord.id, `team-${deskId}`)
    assert.equal(deskRecord.name, "Container desk")
    assert.equal(deskRecord.status, "Active")
    assert.equal(deskRecord.facts.Members, "Olivia Larsen")
    assert.equal(deskRecord.context, "1 member")
    assert.equal(deskRecord.submittedValues?.memberUserAccountIds, olivia.id)
    assert.equal(yardRecord.status, "Inactive")
    assert.equal(yardRecord.facts.Members, "None")
    assert.ok(isTicketTeamRecord(deskRecord))
  })

  test("a create is the contracts' body: the name, the status, the members by server id", () => {
    const made = createTicketTeamRecord({ name: " Phones ", memberUserAccountIds: `${olivia.id},${lars.id}` }, { now: 1 })
    assert.ok(isTicketTeamRecord(made))
    const body = ticketTeamAdapter.toCreateBody?.(made, context)
    assert.deepEqual(body, { name: "Phones", status: "active", memberUserAccountIds: [oliviaId, larsId] })
    assert.ok(TeamCreate.safeParse(body).success)
    assert.deepEqual(ticketTeamAdapter.toCreateBody?.(createTicketTeamRecord({ name: "Night", memberUserAccountIds: "user-unknown" }, { now: 2 }), context), { path: "memberUserAccountIds", message: "Pick accounts the API holds" })
    assert.deepEqual(ticketTeamAdapter.toCreateBody?.(createTicketTeamRecord({ name: "  " }, { now: 3 }), context), { path: "name", message: "Name the team" })
  })

  test("an edit patches what moved of the team and replaces the members whole, the team first", async () => {
    const edited = updateTicketTeamRecord(deskRecord, { name: "Containers", status: "Inactive", memberUserAccountIds: `${olivia.id},${lars.id}` })
    const body = ticketTeamAdapter.toPatchBody?.(deskRecord, edited, context) as { team: unknown; memberUserAccountIds: string[] }
    assert.deepEqual(body, { team: { name: "Containers", status: "inactive" }, memberUserAccountIds: [oliviaId, larsId] })
    assert.ok(TeamPatch.safeParse(body.team).success)
    assert.ok(TeamMembersSet.safeParse({ memberUserAccountIds: body.memberUserAccountIds }).success)
    assert.equal(ticketTeamAdapter.toPatchBody?.(deskRecord, updateTicketTeamRecord(deskRecord, {}), context), null, "nothing moved")
    assert.deepEqual(ticketTeamAdapter.toPatchBody?.(deskRecord, updateTicketTeamRecord(deskRecord, { memberUserAccountIds: olivia.id }), context), null, "the same set in any order is no change")

    const answered: Team = { ...desk, name: "Containers", status: "inactive", memberUserAccountIds: [oliviaId, larsId] }
    const { fetch, calls } = scripted([() => json({ ...answered, memberUserAccountIds: [oliviaId] }), () => json(answered)])
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, teamsState, edited, { fixtures: [], state, now: NOW })
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
      ["PATCH", `http://api.test/teams/${deskId}`],
      ["PUT", `http://api.test/teams/${deskId}/members`],
    ])
    assert.deepEqual(bodyOf(calls[1]), { memberUserAccountIds: [oliviaId, larsId] })
    assert.equal(outcome.kind, "updated")
  })
})

describe("a ticket's team", () => {
  const ticket: Ticket = {
    id: "01a0d2a4-a280-7040-8000-000000000001",
    ...STAMPS,
    projectId: copenhagen.id,
    number: 1001,
    label: "T-1001",
    kind: "complaint",
    status: "open",
    priority: "none",
    source: "office",
    subject: "Bin left out",
    description: "Reported by phone",
    occurredAt: STAMPS.createdAt,
    dueAt: null,
    assigneeUserAccountId: null,
    teamId: deskId,
    createdBy: oliviaId,
    sourceEventId: null,
    links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
    resolution: null,
    recollectionRouteId: null,
    recollectionPickupId: null,
    chargeProductId: null,
    closedAt: null,
    bookedRouteId: null,
    bookedPickupId: null,
  }

  test("reads as the team's name once the teams are loaded, its id chip before, and No team for none", () => {
    const record = ticketAdapter.toRecord(ticket, withTeams)
    assert.equal(record.facts.Team, "Container desk")
    assert.equal(record.submittedValues?.teamId, deskRecord.id)
    assert.equal(ticketAdapter.toRecord(ticket, context).facts.Team, `team-${deskId}`)
    const none = ticketAdapter.toRecord({ ...ticket, teamId: null }, withTeams)
    assert.equal(none.facts.Team, "No team")
    assert.equal(none.submittedValues?.teamId, NO_ONE)
  })

  test("the list's Team category reads it: with Open and Unassigned, the team's queue", () => {
    const readers = ticketListReaders(null)
    assert.deepEqual(readers.teams?.(ticketAdapter.toRecord(ticket, withTeams)), ["Container desk"])
    assert.deepEqual(readers.assignees?.(ticketAdapter.toRecord(ticket, withTeams)), ["Unassigned"])
  })

  test("the patch hands the case to another team or to none, and moves nothing when the team stands", () => {
    const record = ticketAdapter.toRecord(ticket, withTeams)
    const handed = ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: yardRecord.id }), withTeams)
    assert.deepEqual(handed, { teamId: yardId })
    assert.ok(TicketPatch.safeParse(handed).success)
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: NO_ONE }), withTeams), { teamId: null })
    assert.equal(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { priority: "none" }), withTeams), null)
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: "team-unknown" }), withTeams), { path: "teamId", message: "Pick a team the API holds" })
    // A role that may not read the teams holds the ticket's team as its id chip, and an edit of something else moves nothing of it.
    const chipped = ticketAdapter.toRecord(ticket, context)
    assert.deepEqual(ticketAdapter.toPatchBody?.(chipped, updateTicketRecord(chipped, { priority: "high" }), context), { priority: "high" })
  })
})

describe("a project's default team per kind", () => {
  const webIdOf = (serverId: string) => (serverId === deskId ? deskRecord.id : `team-${serverId}`)
  const serverIdOf = (webId: string) => teamsState.serverIds.get(webId)

  test("is every kind a row, in the vocabulary's order, a team or none", () => {
    const rows = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: "complaint", teamId: deskId }] }, webIdOf)
    assert.deepEqual(rows.map((row) => row.kind), [...TICKET_KINDS])
    assert.equal(rows.find((row) => row.kind === "complaint")?.teamId, deskRecord.id)
    assert.equal(rows.find((row) => row.kind === "overflow")?.teamId, NO_TEAM)
    assert.equal(rows.find((row) => row.kind === "complaint")?.label, "Complaint")
  })

  test("its body names each kind with a team by server id, and refuses a team the API does not hold", () => {
    const rows = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [] }, webIdOf).map((row) => (row.kind === "overflow" ? { ...row, teamId: yardRecord.id } : row.kind === "complaint" ? { ...row, teamId: deskRecord.id } : row))
    const body = teamDefaultsBodyOf(rows, serverIdOf)
    assert.deepEqual(body, { defaults: [{ kind: "overflow", teamId: yardId }, { kind: "complaint", teamId: deskId }] })
    assert.ok(TicketTeamDefaultsSet.safeParse(body).success)
    assert.deepEqual(teamDefaultsBodyOf([{ kind: "other", label: "Other", teamId: "team-unknown" }], serverIdOf), { kind: "other", message: PICK_A_HELD_TEAM })
  })
})
