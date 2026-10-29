// Ticket teams on the prototype's records (O30 of #290, row 7.20): the
// company's teams a ticket waits with, as the records of `configure.templates`,
// the prototype's Tickets & communication, whose grant the API keeps them
// under. The wire shapes are the contracts' (`@waste/contracts/ticket-teams`),
// imported as types; the routes are apps/api/src/routes/ticket-teams.ts.
//
// A team is `team-<uuid>`, named by its name, `Active` or `Inactive` — retired
// is an edit of the form, not a lifecycle move, as a decommission reason's is.
// Its members are User Accounts of Users & roles, carried by their web ids and
// named under the Members fact; a create writes the set it starts with, and
// an edit patches the name and the status and replaces the set through its own
// route, the team first. The tickets read a team's name through the store's
// resolver (records/tickets.ts), so a role that may not view this module reads
// a ticket's team as its id chip.
import type { Team, TeamCreate, TeamPatch } from "@waste/contracts/ticket-teams"

import { splitMultiValue } from "@/lib/data/business-form-records"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { NO_ONE } from "@/lib/data/properties"
import { TICKET_TEAMS_MODULE, TICKET_TEAM_PREFIX } from "@/lib/data/ticket-teams"

import { create, listAll, patch, put } from "../client"
import { inheritedPresentation, ofKind, patchOf, stampFacts, statusLabel, statusToken, typed, webIdOf, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { userAdapter } from "./organisation"
import { sameSet } from "./places"
import { nameVia, referencedServerId, webIdVia } from "./references"

/** Whether a loaded row is a ticket team: its id, or — a row made this session — its kind. */
export const isTicketTeamRecord = ofKind(TICKET_TEAM_PREFIX, ["Ticket team"])

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The members a form names, by web id, as its multiselect keeps them, the picker's None left out. */
export const memberWebIdsOf = (record: Pick<BusinessRecord, "submittedValues">): string[] => splitMultiValue(typed(record, "memberUserAccountIds") ?? "").filter((id) => id !== NO_ONE)

/** The members as server ids, each an account the API holds; a refusal at the field for one it does not. */
function memberServerIds(record: BusinessRecord, context: MappingContext): string[] | LocalRefusal {
  const ids: string[] = []
  for (const webId of memberWebIdsOf(record)) {
    const serverId = referencedServerId(webId, "user", context, { owns: userAdapter.owns })
    if (serverId === undefined) return refusal("memberUserAccountIds", "Pick accounts the API holds")
    ids.push(serverId)
  }
  return ids
}

/** The team's own fields as the form says them: the name, and the status in the wire's word. */
function teamFieldsOf(record: BusinessRecord): { name: string; status: "active" | "inactive" } | LocalRefusal {
  const name = typed(record, "name") ?? record.name.trim()
  if (name === "") return refusal("name", "Name the team")
  const status = statusToken(typed(record, "status") ?? "Active")
  if (status !== "active" && status !== "inactive") return refusal("status", "A team is active or inactive")
  return { name, status }
}

export function toTicketTeamRecord(team: Team, context: MappingContext): BusinessRecord {
  const members = team.memberUserAccountIds.map((id) => nameVia(context, "user", id))
  return {
    id: webIdOf(TICKET_TEAM_PREFIX, team.id),
    name: team.name,
    context: members.length === 1 ? "1 member" : `${members.length} members`,
    status: statusLabel(team.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(team, context.now),
    description: "A team the company's tickets wait with.",
    facts: { Members: members.length === 0 ? "None" : members.join(", "), Status: statusLabel(team.status) },
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [],
    recordKind: "Ticket team",
    submittedValues: {
      name: team.name,
      status: statusLabel(team.status),
      memberUserAccountIds: team.memberUserAccountIds.map((id) => webIdVia(context, "user", id)).join(","),
    },
  }
}

/** An edit's two halves: the team's own fields, and the whole set of members where the form changed it. */
type TeamWrite = { team?: TeamPatch; memberUserAccountIds?: string[] }

export const ticketTeamAdapter: ResourceAdapter<Team> = {
  prefix: TICKET_TEAM_PREFIX,
  auditTable: "team",
  owns: isTicketTeamRecord,
  // The status is a field of the form: retiring a team is an edit.
  statuses: undefined,
  list: (client) => listAll<Team>(client, "/teams"),
  toRecord: toTicketTeamRecord,
  toCreateBody: (record, context) => {
    const fields = teamFieldsOf(record)
    if ("path" in fields) return fields
    const memberUserAccountIds = memberServerIds(record, context)
    if ("path" in memberUserAccountIds) return memberUserAccountIds
    const body: TeamCreate = { ...fields, memberUserAccountIds }
    return body
  },
  toPatchBody: (before, after, context) => {
    const fields = teamFieldsOf(after)
    if ("path" in fields) return fields
    const team = patchOf<TeamPatch>(before, after, (record) => {
      const read = teamFieldsOf(record)
      return "path" in read ? {} : read
    })
    let memberUserAccountIds: string[] | undefined
    if (!sameSet(memberWebIdsOf(before), memberWebIdsOf(after))) {
      const ids = memberServerIds(after, context)
      if ("path" in ids) return ids
      memberUserAccountIds = ids
    }
    if (team === null && memberUserAccountIds === undefined) return null
    const write: TeamWrite = { ...(team === null ? {} : { team }), ...(memberUserAccountIds === undefined ? {} : { memberUserAccountIds }) }
    return write
  },
  create: (client, body) => create<Team>(client, "/teams", body).then((created) => created.body),
  // The team first, then the whole set through its own route; the answer is the team as it now stands.
  update: async (client, serverId, body) => {
    const write = body as TeamWrite
    let team: Team | undefined
    if (write.team !== undefined) team = await patch<Team>(client, `/teams/${serverId}`, write.team)
    if (write.memberUserAccountIds !== undefined) team = await put<Team>(client, `/teams/${serverId}/members`, { memberUserAccountIds: write.memberUserAccountIds })
    if (team === undefined) throw new Error(`ticketTeamAdapter.update: nothing to write for ${serverId}`)
    return team
  },
}

/** Settings › Operations › Ticket teams, and the module the tickets' Team picker reads: the company's teams. */
export const ticketTeamsModule: ServerModule = {
  workspaceId: TICKET_TEAMS_MODULE.workspaceId,
  moduleId: TICKET_TEAMS_MODULE.moduleId,
  resources: [ticketTeamAdapter],
}
