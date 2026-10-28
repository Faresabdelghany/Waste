// Ticket teams (O30 of #290, row 7.20): the people a kind of ticket goes to.
// `GET /teams` lists the company's, `POST /teams` adds one, `GET`/`PATCH
// /teams/:id` read and change one, and `PUT /teams/:id/members` replaces the
// accounts in it. No delete: a team the tickets it held still name is retired
// by its status, which offers it to no new ticket and keeps the ones it holds.
// `GET`/`PUT /projects/:id/ticket-team-defaults` read and replace the team a
// project's ticket of a kind goes to when its opener names none, which
// `openTicket` reads (@waste/db/commands/open-ticket).
//
// A team is the company's and no project's, like the master data, so every
// statement carries `company_id = the caller's` beside the fence (ADR-0001).
// The members are the set that travels with the record (routes/id-sets.ts): a
// create may carry the set it starts with, a patch never touches it, and the
// PUT replaces it whole, the team's own row stamped first. Each member is an
// account of this company that is not deactivated (400 at
// `memberUserAccountIds.N`); membership asks nothing of a project, since a
// team serves every project its tickets come from, and grants nothing: anyone
// with the tickets grant takes a team's ticket, member or not.
//
// The defaults are a set of their project, written in place as the SLA's are
// (routes/ticket-sla.ts): a kind the body keeps moves only its team, and only
// when it changed, so the audit log reads one row's history per kind; the
// two writes to one project's set take turns under a transaction-scoped
// advisory lock. Each team is one of this company's (400 at
// `defaults.N.teamId`) and active (409), since a status gates a new reference.
//
// The grant is `configure.templates`, the prototype's Tickets &
// communication, where the SLA is. A team and the defaults are read under
// `operate.tickets` too, since the people working tickets read which team a
// ticket waits with.
import { Page } from "@waste/contracts/pagination"
import { Team, TeamCreate, TeamListQuery, TeamMembersSet, TeamPatch, TicketTeamDefaults, TicketTeamDefaultsSet, type TeamStatus } from "@waste/contracts/ticket-teams"
import type { Tx } from "@waste/db/client"
import { team, teamMember, ticketTeamDefault } from "@waste/db/schema/resolution"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf } from "../auth/projects"
import { allows, requireGrant, requireGrantOf } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { asRead, idsFor, idsOf, replaceIdSet, writeIds, type IdSet } from "./id-sets"
import { requireTeam, requireUserAccount } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.templates"
const TICKETS = "operate.tickets"

/** A read's module: the tickets' for the people working them, the templates' for the office that keeps the teams. */
const readModuleOf = (principal: Principal) => (allows(principal.grants, TICKETS, "view") ? TICKETS : MODULE)

const TeamPage = Page(Team)

const columns = { id: team.id, name: team.name, status: team.status, createdAt: team.createdAt, updatedAt: team.updatedAt }
type Row = Pick<typeof team.$inferSelect, keyof typeof columns>

/** The members: the accounts of this company in the team, one row per pair. */
const members: IdSet<typeof teamMember> = {
  table: teamMember,
  parentId: teamMember.teamId,
  entryId: teamMember.userAccountId,
  rowOf: (userAccountId, owner) => ({ id: newId(), companyId: owner.companyId, teamId: owner.id, userAccountId }),
  // An account that is not deactivated, each in its own words; a team holds a handful.
  require: async (tx, companyId, ids) => {
    for (const [index, id] of ids.entries()) await requireUserAccount(tx, companyId, id, `memberUserAccountIds.${index}`)
  },
}

const teamOf = (row: Row, memberUserAccountIds: readonly string[]): Team => ({ id: row.id, name: row.name, status: row.status as TeamStatus, memberUserAccountIds: [...memberUserAccountIds], ...stampsOf(row) })

/** `unique (company_id, name)`: a name is one team's inside a company. */
const NAME_TAKEN = "team_name_key"
const nameTaken = (name: string) => `This company already has a team called ${JSON.stringify(name)}`

const noSuchTeam = (id: string) => problem(404, { detail: `No team ${id} in this company` })
const noSuchProject = (id: string) => problem(404, { detail: `No project ${id} in the projects this account works in` })

const scope = (principal: Principal) => eq(team.companyId, principal.companyId)

async function findTeam(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(team)
    .where(and(scope(principal), eq(team.id, id)))
    .limit(1)
  return row
}

type DefaultRow = { id: string; kind: string; teamId: string }

async function defaultsOf(tx: Tx, companyId: string, projectId: string): Promise<DefaultRow[]> {
  return await tx
    .select({ id: ticketTeamDefault.id, kind: ticketTeamDefault.kind, teamId: ticketTeamDefault.teamId })
    .from(ticketTeamDefault)
    .where(and(eq(ticketTeamDefault.companyId, companyId), eq(ticketTeamDefault.projectId, projectId)))
}

/** A project's defaults on the wire, in the vocabulary's order of kinds. */
const defaultsAnswer = (projectId: string, rows: readonly Pick<DefaultRow, "kind" | "teamId">[]): TicketTeamDefaults => ({
  projectId,
  defaults: [...rows].sort((a, b) => TICKET_KINDS.indexOf(a.kind as TicketKind) - TICKET_KINDS.indexOf(b.kind as TicketKind)).map((row) => ({ kind: row.kind as TicketKind, teamId: row.teamId })),
})

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(
    action === "view" ? `No active account here, or the caller's role allows \`view\` on neither \`${TICKETS}\` nor \`${MODULE}\`.` : `No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`,
  ),
})

export function ticketTeamRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/teams",
      describeRoute({
        operationId: "listTeams",
        summary: "The company's ticket teams",
        description:
          "One page of the teams the company's tickets wait with, oldest first (ids are time-ordered), each with its members by id. `status` narrows the page to the active or the retired. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of teams, each with its members.", TeamPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or the status is not one of the two."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrantOf(readModuleOf, "view"),
      validate("query", TeamListQuery),
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(team)
          .where(and(scope(principal), status === undefined ? undefined : eq(team.status, status), after === undefined ? undefined : gt(team.id, after)))
          .orderBy(asc(team.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await idsOf(tx, members, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => teamOf(row, held.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/teams",
      describeRoute({
        operationId: "createTeam",
        summary: "Add a ticket team",
        description:
          "Adds a team to the company. `name` is unique inside the company; `status` is `active` unless said. `memberUserAccountIds` is the set the team starts with, each an account of this company that is not deactivated (400 at `memberUserAccountIds.N`) and named once, and none when absent. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The team as it was written, with its members.", Team),
          400: describeProblem("The body is missing a field, names a member the server owns, names an account twice, or names one that is not an active account of this company."),
          ...commonProblems("create"),
          409: describeProblem("The company already has a team with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", TeamCreate),
      async (c) => {
        const { memberUserAccountIds, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await members.require(tx, principal.companyId, memberUserAccountIds)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(team)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        await writeIds(tx, members, { companyId: principal.companyId, id: row.id }, memberUserAccountIds)
        return created(c, "/teams", teamOf(row, asRead(memberUserAccountIds)))
      },
    )
    .get(
      "/teams/:id",
      describeRoute({
        operationId: "getTeam",
        summary: "One ticket team",
        description: "One team of the caller's company, with its members. Another company's team is a team that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The team, with its members.", Team),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No team with that id in this company."),
        },
      }),
      guard,
      requireGrantOf(readModuleOf, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findTeam(tx, principal, id)
        if (row === undefined) throw noSuchTeam(id)
        return c.json(teamOf(row, await idsFor(tx, members, principal.companyId, row.id)))
      },
    )
    .patch(
      "/teams/:id",
      describeRoute({
        operationId: "patchTeam",
        summary: "Rename or retire a ticket team",
        description:
          "Changes the name, or the status: `inactive` retires the team, so no new ticket and no project's default names it, while every ticket it holds keeps it; `active` offers it again. A project's default naming a retired team gives a new ticket no team. The members are a set, so they are `PUT /teams/{id}/members`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The team as it now stands, with its members.", Team),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own, the members included."),
          ...commonProblems("edit"),
          404: describeProblem("No team with that id in this company."),
          409: describeProblem("The company already has another team with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TeamPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(team)
            .set(patch)
            .where(and(scope(principal), eq(team.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchTeam(id)
        return c.json(teamOf(row, await idsFor(tx, members, principal.companyId, row.id)))
      },
    )
    .put(
      "/teams/:id/members",
      describeRoute({
        operationId: "putTeamMembers",
        summary: "Replace a ticket team's members",
        description:
          "Replaces the whole set of members with the one in the body: an account the body leaves out is not in the team afterwards, and an empty list is a team of nobody, whose queue anyone with the tickets grant still works. Every id is an account of this company that is not deactivated (400 at `memberUserAccountIds.N`), each named once (400 on `memberUserAccountIds`). The team's `updatedAt` moves, since the set is part of the team on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The team with the members it now has.", Team),
          400: describeProblem("The path does not hold an id, or the body is missing `memberUserAccountIds`, names a member it does not own, names an account twice, or names one that is not an active account of this company."),
          ...commonProblems("edit"),
          404: describeProblem("No team with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TeamMembersSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { memberUserAccountIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceIdSet(tx, members, principal.companyId, memberUserAccountIds, (stamped) =>
          tx
            .update(team)
            .set(stamped)
            .where(and(scope(principal), eq(team.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchTeam(id)
        return c.json(teamOf(row, asRead(memberUserAccountIds)))
      },
    )
    .get(
      "/projects/:id/ticket-team-defaults",
      describeRoute({
        operationId: "getTicketTeamDefaults",
        summary: "A project's default ticket teams",
        description:
          "The team a ticket of the project goes to when its opener names none, one per kind, in the vocabulary's order of kinds. A kind the project names no team for opens its tickets with none, and so does a default whose team is retired.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's defaults.", TicketTeamDefaults),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No project with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrantOf(readModuleOf, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        if (!projectIdsOf(principal).includes(id)) throw noSuchProject(id)
        return c.json(defaultsAnswer(id, await defaultsOf(c.get("tx"), principal.companyId, id)))
      },
    )
    .put(
      "/projects/:id/ticket-team-defaults",
      describeRoute({
        operationId: "putTicketTeamDefaults",
        summary: "Replace a project's default ticket teams",
        description:
          "Replaces the whole set with the one in the body: a kind the body leaves out goes to no team, and an empty list gives none a team. Each kind is named once (400 on `defaults`), and each team is one of this company's (400 at `defaults.N.teamId`) that is active (409). A kind the body keeps keeps its id and moves only its team, and one whose team did not change is not written, so the audit log reads one row's history per kind. A ticket already open keeps its team: the default names one as a ticket opens.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's defaults as they now stand.", TicketTeamDefaults),
          400: describeProblem("The path does not hold an id, or the body is missing `defaults`, names a member it does not own, names a kind twice or one the vocabulary does not hold, or names a team that is not this company's."),
          ...commonProblems("edit"),
          404: describeProblem("No project with that id in the projects this account works in."),
          409: describeProblem("A team named is retired."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketTeamDefaultsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { defaults } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (!projectIdsOf(principal).includes(id)) throw noSuchProject(id)
        for (const [index, entry] of defaults.entries()) await requireTeam(tx, principal.companyId, entry.teamId, `defaults.${index}.teamId`)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ticket-team-defaults:${principal.companyId}:${id}`}, 0))`)
        const current = new Map((await defaultsOf(tx, principal.companyId, id)).map((row) => [row.kind, row]))
        const kept = new Set<string>(defaults.map((entry) => entry.kind))
        const gone = [...current.values()].filter((row) => !kept.has(row.kind)).map((row) => row.id)
        if (gone.length > 0) await tx.delete(ticketTeamDefault).where(and(eq(ticketTeamDefault.companyId, principal.companyId), inArray(ticketTeamDefault.id, gone)))
        const added = defaults.filter((entry) => !current.has(entry.kind))
        if (added.length > 0) {
          await tx.insert(ticketTeamDefault).values(added.map((entry) => ({ id: newId(), companyId: principal.companyId, projectId: id, kind: entry.kind, teamId: entry.teamId })))
        }
        // A kind kept is written only where its team moved: one statement each, and a person moves a handful at a time.
        for (const entry of defaults) {
          const before = current.get(entry.kind)
          if (before === undefined || before.teamId === entry.teamId) continue
          await tx
            .update(ticketTeamDefault)
            .set({ teamId: entry.teamId })
            .where(and(eq(ticketTeamDefault.companyId, principal.companyId), eq(ticketTeamDefault.id, before.id)))
        }
        // The set just written is the body, each kind once: answered in kind order, not read back.
        return c.json(defaultsAnswer(id, defaults))
      },
    )
}
