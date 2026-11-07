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
import { eachOnce } from "@waste/domain/requests"
import { EACH_KIND_ONCE, EACH_MEMBER_ONCE, TEAM_MEMBERS_MAX } from "@waste/domain/resolution/teams"
import { KIND_OR_TYPE, kindOrTypeKey, TICKET_TYPE_SETTINGS_MAX } from "@waste/domain/resolution/ticket-types"
import { TEAM_STATUSES, TICKET_KINDS } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { TicketKind } from "./resolution"
import { resourceBodies, stamped } from "./resource"
import { Label } from "./text"

export const TeamStatus = z.enum(TEAM_STATUSES)
export type TeamStatus = z.infer<typeof TeamStatus>

const eachMemberOnce = { message: EACH_MEMBER_ONCE, path: ["memberUserAccountIds"] }

const MemberIds = z.array(Id)
const MemberIdsBody = MemberIds.max(TEAM_MEMBERS_MAX)

export const Team = z.object({
  ...stamped,
  /** What a person reads; unique per company. */
  name: Label,
  status: TeamStatus,
  /** The accounts in the team, by id; replaced whole through its own route. */
  memberUserAccountIds: MemberIds,
})
export type Team = z.infer<typeof Team>

/** A patch takes the name and the status; the members have a route of their own. */
const teamBodies = resourceBodies(
  {
    name: Label,
    status: TeamStatus.default("active"),
    memberUserAccountIds: MemberIdsBody.default([]).describe("The accounts the team starts with; none when absent."),
  },
  { keys: ["memberUserAccountIds"] },
)

export const TeamCreate = teamBodies.create.refine((body) => eachOnce(body.memberUserAccountIds), eachMemberOnce)
export type TeamCreate = z.infer<typeof TeamCreate>

export const TeamPatch = teamBodies.patch
export type TeamPatch = z.infer<typeof TeamPatch>

/** The whole set of members, replacing what the team had; an empty set is a team of nobody, whose queue anyone with the grant still works. */
export const TeamMembersSet = z.strictObject({ memberUserAccountIds: MemberIdsBody }).refine((body) => eachOnce(body.memberUserAccountIds), eachMemberOnce)
export type TeamMembersSet = z.infer<typeof TeamMembersSet>

/** A page of teams: every one of the company's, or one status's. */
export const TeamListQuery = PageRequest.extend({ status: TeamStatus.optional() })
export type TeamListQuery = z.infer<typeof TeamListQuery>

/** The team a ticket of one kind, or of one Ticket Type (#548 of #544), goes to when its opener names none: exactly one of the two, the type's own winning over its kind's. */
export const TicketTeamDefault = z.object({ kind: TicketKind.nullable(), ticketTypeId: Id.nullable(), teamId: Id })
export type TicketTeamDefault = z.infer<typeof TicketTeamDefault>

/** A project's defaults, in the vocabulary's order of kinds, then the types'. */
export const TicketTeamDefaults = z.object({ projectId: Id, defaults: z.array(TicketTeamDefault) })
export type TicketTeamDefaults = z.infer<typeof TicketTeamDefaults>

/** `PUT /projects/:id/ticket-team-defaults`: the whole set, each kind or type once and each entry exactly one of the two; one left out goes to no team, or a type to its kind's. */
export const TicketTeamDefaultsSet = z
  .strictObject({
    defaults: z
      .array(z.strictObject({ kind: TicketKind.nullable().default(null), ticketTypeId: Id.nullable().default(null).describe("Null when absent: a kind's default."), teamId: Id }))
      .max(TICKET_KINDS.length + TICKET_TYPE_SETTINGS_MAX),
  })
  // zod 4 runs a check on a body whose fields failed: read the entries with care.
  .superRefine((body, context) => {
    const entries = body.defaults.filter((entry) => entry !== undefined)
    for (const [index, entry] of body.defaults.entries()) {
      if (entry !== undefined && (entry.kind === null) === (entry.ticketTypeId === null)) context.addIssue({ code: "custom", message: KIND_OR_TYPE, path: ["defaults", index] })
    }
    if (!eachOnce(entries.map(kindOrTypeKey))) context.addIssue({ code: "custom", message: EACH_KIND_ONCE, path: ["defaults"] })
  })
export type TicketTeamDefaultsSet = z.infer<typeof TicketTeamDefaultsSet>
