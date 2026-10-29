// Ticket teams on the wire (O30 of #290, row 7.20). A Team is the company's —
// "Customer service", "Container desk" — with its members, accounts of the
// company by id, replaced whole through `PUT /teams/:id/members`, and a
// status: an inactive team is offered to no new ticket and keeps the ones it
// holds. A ticket names its team beside its assignee (`Ticket.teamId`); the
// team's queue is a reading, its open tickets with no assignee
// (`GET /tickets?teamId=…&open=true&unassigned=true`), and anyone with the
// tickets grant takes one, member or not. A project's defaults name the team
// a ticket of a kind goes to when its opener names none, one per kind,
// replaced whole through `PUT /projects/:id/ticket-team-defaults`.
import { TEAM_STATUSES, TICKET_KINDS } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { TicketKind } from "./resolution"
import { changesSomething, eachOnce, eachOnceSentence, somethingToChange, stamped } from "./resource"
import { Label } from "./text"

/** The most members a set body may name: a form's list, not an import. */
const MEMBERS_MAX = 200

export const TeamStatus = z.enum(TEAM_STATUSES)
export type TeamStatus = z.infer<typeof TeamStatus>

export const EACH_MEMBER_ONCE = eachOnceSentence("account")
const eachMemberOnce = { message: EACH_MEMBER_ONCE, path: ["memberUserAccountIds"] }

const MemberIds = z.array(Id)
const MemberIdsBody = MemberIds.max(MEMBERS_MAX)

export const Team = z.object({
  ...stamped,
  /** What a person reads; unique per company. */
  name: Label,
  status: TeamStatus,
  /** The accounts in the team, by id; replaced whole through its own route. */
  memberUserAccountIds: MemberIds,
})
export type Team = z.infer<typeof Team>

export const TeamCreate = z
  .strictObject({
    name: Label,
    status: TeamStatus.default("active"),
    memberUserAccountIds: MemberIdsBody.default([]).describe("The accounts the team starts with; none when absent."),
  })
  .refine((body) => eachOnce(body.memberUserAccountIds), eachMemberOnce)
export type TeamCreate = z.infer<typeof TeamCreate>

/** The name and the status; the members have a route of their own. */
export const TeamPatch = z
  .strictObject({
    name: Label.optional(),
    status: TeamStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type TeamPatch = z.infer<typeof TeamPatch>

/** The whole set of members, replacing what the team had; an empty set is a team of nobody, whose queue anyone with the grant still works. */
export const TeamMembersSet = z.strictObject({ memberUserAccountIds: MemberIdsBody }).refine((body) => eachOnce(body.memberUserAccountIds), eachMemberOnce)
export type TeamMembersSet = z.infer<typeof TeamMembersSet>

/** A page of teams: every one of the company's, or one status's. */
export const TeamListQuery = PageRequest.extend({ status: TeamStatus.optional() })
export type TeamListQuery = z.infer<typeof TeamListQuery>

export const TicketTeamDefault = z.object({ kind: TicketKind, teamId: Id })
export type TicketTeamDefault = z.infer<typeof TicketTeamDefault>

/** A project's defaults, in the vocabulary's order of kinds. */
export const TicketTeamDefaults = z.object({ projectId: Id, defaults: z.array(TicketTeamDefault) })
export type TicketTeamDefaults = z.infer<typeof TicketTeamDefaults>

/** What a set naming a kind twice is told. */
export const EACH_KIND_ONCE = eachOnceSentence("kind", "a ticket of a kind goes to one team")

/** `PUT /projects/:id/ticket-team-defaults`: the whole set, each kind once; a kind left out goes to no team. */
export const TicketTeamDefaultsSet = z
  .strictObject({ defaults: z.array(z.strictObject({ kind: TicketKind, teamId: Id })).max(TICKET_KINDS.length) })
  // zod 4 runs a check on a body whose fields failed: read the entries with care.
  .refine((body) => eachOnce(body.defaults.filter((entry) => entry !== undefined).map((entry) => entry.kind)), { message: EACH_KIND_ONCE, path: ["defaults"] })
export type TicketTeamDefaultsSet = z.infer<typeof TicketTeamDefaultsSet>
