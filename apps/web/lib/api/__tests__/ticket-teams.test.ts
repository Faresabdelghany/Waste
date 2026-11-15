// Ticket teams on the adapter (O30 of #290, row 7.20): a team as the Settings
// pane and the tickets' Team picker read it, its create, its edit — the name
// and the status patched, the members replaced through their own route — a
// ticket's team on the record, in the create and in the patch, the list's
// Team category, and a project's default team per kind and per type as the
// rows the Default teams tab lists, the choices a team is picked from, and the
// set one row's edit puts back (#606).
// Every body is held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { Team, TeamCreate, TeamMembersSet, TeamPatch, TicketTeamDefaultsSet } from "@waste/contracts/ticket-teams"
import { TicketPatch, type Ticket } from "@waste/contracts/tickets"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { type BusinessRecord } from "../../data/business-modules"
import { NO_ONE } from "../../data/properties"
import { createTicketTeamRecord, defaultsWithTeam, NO_TEAM, PICK_A_HELD_TEAM, pickedTeamOf, teamChoicesOf, teamDefaultRowsOf, teamOfScope, teamShownOf, updateTicketTeamRecord } from "../../data/ticket-teams"
import { ticketListReaders, updateTicketRecord } from "../../data/tickets"
import { NOTHING_RESOLVED, recordFrom, type MappingContext } from "../records/adapter"
import { isServerBacked } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { isTicketTeamRecord, ticketTeamAdapter, ticketTeamsModule } from "../records/ticket-teams"
import { ticketAdapter } from "../records/tickets"
import { moveDefaultTeam } from "../ticket-team-defaults"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-28T10:00:00Z")
const STAMPS = { createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const projectRecord = recordFrom(projectAdapter, copenhagen, { resolve: NOTHING_RESOLVED, now: NOW })

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
const context: MappingContext = { resolve: resolverOver(baseState), now: NOW }

const deskRecord = recordFrom(ticketTeamAdapter, desk, context)
const yardRecord = recordFrom(ticketTeamAdapter, yard, context)
const teamsState = loaded({ records: [deskRecord, yardRecord], serverIds: new Map([[deskRecord.id, deskId], [yardRecord.id, yardId]]) }, 1)
const state: ServerRecordsState = new Map([...baseState, ["configure.templates", teamsState]])
const withTeams: MappingContext = { ...context, resolve: resolverOver(state) }

describe("a ticket team", () => {
  test("is a record of Tickets & communication on the Pilot", () => {
    assert.ok(isServerBacked("configure", "templates"))
    assert.deepEqual(ticketTeamsModule.resources.map((adapter) => adapter.prefix), ["team", "ticket-type"], "the ticket types share the module (#545 of #544)")
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
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, teamsState, edited, { state, now: NOW })
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
    ticketTypeId: null,
    fieldValues: {},
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
    bookedPickupId: null, countedBy: null,
  }

  test("reads as the team's name once the teams are loaded, its id chip before, and No team for none", () => {
    const record = recordFrom(ticketAdapter, ticket, withTeams)
    assert.equal(record.facts.Team, "Container desk")
    assert.equal(record.submittedValues?.teamId, deskRecord.id)
    assert.equal(recordFrom(ticketAdapter, ticket, context).facts.Team, `team-${deskId}`)
    const none = recordFrom(ticketAdapter, { ...ticket, teamId: null }, withTeams)
    assert.equal(none.facts.Team, "No team")
    assert.equal(none.submittedValues?.teamId, NO_ONE)
  })

  test("the list's Team category reads it: with Open and Unassigned, the team's queue", () => {
    const readers = ticketListReaders(null)
    assert.deepEqual(readers.teams?.(recordFrom(ticketAdapter, ticket, withTeams)), ["Container desk"])
    assert.deepEqual(readers.assignees?.(recordFrom(ticketAdapter, ticket, withTeams)), ["Unassigned"])
  })

  test("the patch hands the case to another team or to none, and moves nothing when the team stands", () => {
    const record = recordFrom(ticketAdapter, ticket, withTeams)
    const handed = ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: yardRecord.id }), withTeams)
    assert.deepEqual(handed, { teamId: yardId })
    assert.ok(TicketPatch.safeParse(handed).success)
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: NO_ONE }), withTeams), { teamId: null })
    assert.equal(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { priority: "none" }), withTeams), null)
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { teamId: "team-unknown" }), withTeams), { path: "teamId", message: "Pick a team the API holds" })
    // A role that may not read the teams holds the ticket's team as its id chip, and an edit of something else moves nothing of it.
    const chipped = recordFrom(ticketAdapter, ticket, context)
    assert.deepEqual(ticketAdapter.toPatchBody?.(chipped, updateTicketRecord(chipped, { priority: "high" }), context), { priority: "high" })
  })
})

describe("a project's default team per kind and per type", () => {
  const webIdOf = (serverId: string) => (serverId === deskId ? deskRecord.id : `team-${serverId}`)
  const serverIdOf = (webId: string) => teamsState.serverIds.get(webId)

  test("is every kind a row, in the vocabulary's order, a team or none", () => {
    const rows = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: "complaint", ticketTypeId: null, teamId: deskId }] }, webIdOf)
    assert.deepEqual(rows.map((row) => row.kind), [...TICKET_KINDS])
    assert.equal(rows.find((row) => row.kind === "complaint")?.teamId, deskRecord.id)
    assert.equal(rows.find((row) => row.kind === "overflow")?.teamId, NO_TEAM)
    assert.equal(rows.find((row) => row.kind === "complaint")?.label, "Complaint")
  })

  test("then each active type, and a retired one the set names, a row of its own by its name and its kind's (#548 of #544)", () => {
    const BULKY = "01a0d2a4-a280-700a-8000-0000000000b1"
    const OLD = "01a0d2a4-a280-700a-8000-0000000000b2"
    const types = [
      { id: BULKY, name: "Bulky waste collection", kind: "container-request" as const, status: "active" as const },
      { id: OLD, name: "Old intake", kind: "complaint" as const, status: "inactive" as const },
    ]
    const rows = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: null, ticketTypeId: OLD, teamId: deskId }] }, webIdOf, types)
    assert.deepEqual(
      rows.slice(TICKET_KINDS.length).map((row) => [row.ticketTypeId, row.label, row.teamId]),
      [
        [BULKY, "Bulky waste collection (Container request)", NO_TEAM],
        [OLD, "Old intake (Complaint)", deskRecord.id],
      ],
    )
    // A type no list the role reads holds: said so, no kind made up for it and never its id; and while the types are still read, said that.
    const unread = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: null, ticketTypeId: OLD, teamId: deskId }] }, webIdOf, [])
    assert.deepEqual([unread.at(-1)?.ticketTypeId, unread.at(-1)?.label], [OLD, "A ticket type not shown to your role"])
    const reading = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: null, ticketTypeId: OLD, teamId: deskId }] }, webIdOf, null)
    assert.equal(reading.at(-1)?.label, "Reading the type…")
    // A read that failed is said as one, never as the role's.
    const failed = teamDefaultRowsOf({ projectId: copenhagen.id, defaults: [{ kind: null, ticketTypeId: OLD, teamId: deskId }] }, webIdOf, "failed")
    assert.equal(failed.at(-1)?.label, "A ticket type that could not be read")
  })

  const BULKY = "01a0d2a4-a280-700a-8000-0000000000b1"
  const set = { projectId: copenhagen.id, defaults: [{ kind: "complaint" as const, ticketTypeId: null, teamId: deskId }, { kind: null, ticketTypeId: BULKY, teamId: yardId }] }

  test("a set names a kind's or a type's team by server id, or none", () => {
    assert.equal(teamOfScope(set, { kind: "complaint", ticketTypeId: null }), deskId)
    assert.equal(teamOfScope(set, { kind: null, ticketTypeId: BULKY }), yardId)
    assert.equal(teamOfScope(set, { kind: "overflow", ticketTypeId: null }), null)
    assert.equal(teamOfScope(set, { kind: null, ticketTypeId: "01a0d2a4-a280-700a-8000-0000000000b9" }), null)
  })

  test("one row's edit puts the whole set back with that row's team moved, every other entry as it stood (#606)", () => {
    const named = defaultsWithTeam(set, { kind: "overflow", ticketTypeId: null }, yardId)
    assert.deepEqual(named, { defaults: [{ kind: "complaint", ticketTypeId: null, teamId: deskId }, { kind: null, ticketTypeId: BULKY, teamId: yardId }, { kind: "overflow", ticketTypeId: null, teamId: yardId }] })
    assert.ok(TicketTeamDefaultsSet.safeParse(named).success)
    const moved = defaultsWithTeam(set, { kind: null, ticketTypeId: BULKY }, deskId)
    assert.deepEqual(moved, { defaults: [{ kind: "complaint", ticketTypeId: null, teamId: deskId }, { kind: null, ticketTypeId: BULKY, teamId: deskId }] })
    assert.ok(TicketTeamDefaultsSet.safeParse(moved).success)
    // No team: the row is left out, a kind's tickets opening with none and a type's following its kind's.
    assert.deepEqual(defaultsWithTeam(set, { kind: "complaint", ticketTypeId: null }, null), { defaults: [{ kind: null, ticketTypeId: BULKY, teamId: yardId }] })
    assert.deepEqual(defaultsWithTeam(set, { kind: "overflow", ticketTypeId: null }, null), { defaults: set.defaults })
  })

  test("the edit reads the project's set as it stands before it puts it back, so a row another person moved meanwhile is kept", async () => {
    const meanwhile = { projectId: copenhagen.id, defaults: [...set.defaults, { kind: "overflow" as const, ticketTypeId: null, teamId: deskId }] }
    const answered = { projectId: copenhagen.id, defaults: [{ kind: "complaint", ticketTypeId: null, teamId: yardId }, meanwhile.defaults[1], meanwhile.defaults[2]] }
    const { fetch, calls } = scripted([() => json(meanwhile), () => json(answered)])
    const written = await moveDefaultTeam(clientOver(fetch), copenhagen.id, { kind: "complaint", ticketTypeId: null }, yardId)
    assert.deepEqual(calls.map((call) => [call.init.method ?? "GET", call.url]), [
      ["GET", `http://api.test/projects/${copenhagen.id}/ticket-team-defaults`],
      ["PUT", `http://api.test/projects/${copenhagen.id}/ticket-team-defaults`],
    ])
    assert.deepEqual(bodyOf(calls[1]), { defaults: [{ kind: "complaint", ticketTypeId: null, teamId: yardId }, { kind: null, ticketTypeId: BULKY, teamId: yardId }, { kind: "overflow", ticketTypeId: null, teamId: deskId }] })
    assert.deepEqual(written, answered)
  })

  test("a picker's value is the team by server id, none, or refused where the API does not hold the team", () => {
    assert.deepEqual(pickedTeamOf(deskRecord.id, serverIdOf), { teamId: deskId })
    assert.deepEqual(pickedTeamOf(NO_TEAM, serverIdOf), { teamId: null })
    assert.deepEqual(pickedTeamOf("team-unknown", serverIdOf), { message: PICK_A_HELD_TEAM })
  })

  test("a team is picked from none, the teams that take tickets, and the one already named whatever its status", () => {
    const teams = [deskRecord, yardRecord]
    assert.deepEqual(teamChoicesOf(false, teams, NO_TEAM), [{ value: NO_TEAM, label: "No team" }, { value: deskRecord.id, label: "Container desk" }])
    // A type with no team of its own goes to its kind's.
    assert.deepEqual(teamChoicesOf(true, teams, yardRecord.id), [{ value: NO_TEAM, label: "As its kind" }, { value: deskRecord.id, label: "Container desk" }, { value: yardRecord.id, label: "Yard · Inactive" }])
  })

  test("a row reads its team's name, its status once retired, and for none what its tickets do instead", () => {
    const teams = [deskRecord, yardRecord]
    const row = (teamId: string, ticketTypeId: string | null = null) => ({ teamId, ticketTypeId })
    assert.equal(teamShownOf(row(deskRecord.id), teams, false), "Container desk")
    assert.equal(teamShownOf(row(yardRecord.id), teams, false), "Yard · Inactive")
    assert.equal(teamShownOf(row(NO_TEAM), teams, false), "No team")
    assert.equal(teamShownOf(row(NO_TEAM, BULKY), teams, false), "As its kind")
    // A team the list does not hold is never read as its id: said to be on its way while the teams are read, and unlisted once they were answered or their read failed.
    assert.equal(teamShownOf(row(deskRecord.id), [], true), "Reading the team…")
    assert.equal(teamShownOf(row(deskRecord.id), [], false), "A team that is not listed")
  })
})
