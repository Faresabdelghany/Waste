import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { EACH_KIND_ONCE, EACH_MEMBER_ONCE, Team, TeamCreate, TeamMembersSet, TeamPatch, TicketTeamDefaultsSet } from "../ticket-teams"
import { TicketCreate, TicketListQuery, TicketPatch } from "../tickets"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = "2026-10-28T09:00:00.000Z"

describe("Team", () => {
  test("is the company's, by a name, active or retired, with its members by id", () => {
    const team = { id: ID, name: "Customer service", status: "active", memberUserAccountIds: [OTHER], createdAt: STAMP, updatedAt: STAMP }
    assert.deepEqual(Team.parse(team), team)
    assert.equal(Team.safeParse({ ...team, status: "archived" }).success, false)
  })

  test("a create starts active with no members unless it says, each account once, and refuses what the server owns", () => {
    assert.deepEqual(TeamCreate.parse({ name: "Container desk" }), { name: "Container desk", status: "active", memberUserAccountIds: [] })
    assert.deepEqual(refusal(TeamCreate.safeParse({ name: "Container desk", memberUserAccountIds: [ID, ID] })), [{ path: "memberUserAccountIds", message: EACH_MEMBER_ONCE }])
    refusesWhatTheServerOwns(TeamCreate, { name: "Container desk" })
  })

  test("a patch moves the name or the status, never the members, and something", () => {
    assert.deepEqual(TeamPatch.parse({ status: "inactive" }), { status: "inactive" })
    assert.equal(TeamPatch.safeParse({ memberUserAccountIds: [] }).success, false)
    refusesAnEmptyPatch(TeamPatch)
  })

  test("the members are a set, each account once, empty allowed", () => {
    assert.deepEqual(TeamMembersSet.parse({ memberUserAccountIds: [] }), { memberUserAccountIds: [] })
    assert.deepEqual(refusal(TeamMembersSet.safeParse({ memberUserAccountIds: [OTHER, OTHER] })).map((issue) => issue.path), ["memberUserAccountIds"])
  })
})

describe("TicketTeamDefaultsSet", () => {
  test("names one team per kind of the vocabulary, each kind once", () => {
    const body = { defaults: [{ kind: "complaint", teamId: ID }, { kind: "container-request", teamId: OTHER }] }
    assert.deepEqual(TicketTeamDefaultsSet.parse(body), body)
    assert.deepEqual(TicketTeamDefaultsSet.parse({ defaults: [] }), { defaults: [] })
    assert.deepEqual(refusal(TicketTeamDefaultsSet.safeParse({ defaults: [{ kind: "complaint", teamId: ID }, { kind: "complaint", teamId: OTHER }] })), [{ path: "defaults", message: EACH_KIND_ONCE }])
    assert.equal(TicketTeamDefaultsSet.safeParse({ defaults: [{ kind: "deviation", teamId: ID }] }).success, false)
    assert.equal(TicketTeamDefaultsSet.safeParse({ defaults: TICKET_KINDS.map((kind) => ({ kind, teamId: ID })) }).success, true)
  })
})

describe("a ticket's team", () => {
  test("a create names it, or none, or leaves it to the project's default; a patch hands the case on", () => {
    const create = TicketCreate.parse({ projectId: ID, subject: "Bin not emptied", description: "The bin was left full.", kind: "missed-collection", teamId: OTHER })
    assert.equal(create.teamId, OTHER)
    assert.equal(TicketCreate.parse({ projectId: ID, subject: "Bin not emptied", description: "The bin was left full.", kind: "missed-collection" }).teamId, undefined, "absent: the project's default for the kind")
    assert.deepEqual(TicketPatch.parse({ teamId: null }), { teamId: null })
  })

  test("the list narrows by team and by whether anybody works the ticket: together with open, the team's queue", () => {
    assert.deepEqual(TicketListQuery.parse({ teamId: ID, open: "true", unassigned: "true" }), { limit: 50, teamId: ID, open: true, unassigned: true })
    assert.equal(TicketListQuery.parse({ unassigned: "false" }).unassigned, false)
    assert.equal(TicketListQuery.safeParse({ unassigned: "yes" }).success, false)
  })
})
