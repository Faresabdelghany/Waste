// A project's ticket SLA (O4 of #290): the targets a ticket is due by, each
// the hours from opening to the due date for a priority, for every kind or for
// one kind (@waste/domain/resolution/sla). `GET /projects/:id/ticket-sla`
// reads them and `PUT` replaces them whole, under `configure.templates`, the
// prototype's Tickets & communication, whose ticket types carry the SLA.
// `openTicket` reads them as it opens a ticket whose opener names no due date
// (@waste/db/commands/open-ticket), the office's and the consumer's alike.
//
// The set is written in place rather than deleted and inserted again: a
// target the body keeps moves only its hours, and only when they changed, so
// it keeps its id and the audit log (sql/audit-trail.ts) reads one row's
// history per kind and priority with the reason its request gave; a target
// the body leaves out is deleted; the new ones go in one insert. Two writes
// to one project's set take turns under a transaction-scoped advisory lock on
// the set, so neither merges into the other. Not `lockRow` on the project,
// as a set whose parent the API locks would be: `FOR UPDATE` on a project
// row blocks every insert whose key names it — a ticket, a route, a stop —
// until the set is saved, and the set's rule is the set's alone.
//
// The project is a path's row: one the caller does not work in, or another
// company's, is the family's 404, as a read of the project would be.
import { TicketSla, TicketSlaSet, type TicketSlaTarget } from "@waste/contracts/ticket-sla"
import type { Tx } from "@waste/db/client"
import { ticketSla } from "@waste/db/schema/resolution"
import { slaTargetKey } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES, type TicketKind, type TicketPriority } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, problem, validate } from "../problem"
import { describeJson, IdParam } from "./shared"

const MODULE = "configure.templates"

const columns = { id: ticketSla.id, kind: ticketSla.kind, priority: ticketSla.priority, hours: ticketSla.hours }
type Row = { id: string; kind: string | null; priority: string; hours: number }

const noSuchProject = (id: string) => problem(404, { detail: `No project ${id} in the projects this account works in` })

/** The project of the path, held to the caller's: a 404 otherwise. */
function requireOwnProject(principal: Principal, id: string): void {
  if (!projectIdsOf(principal).includes(id)) throw noSuchProject(id)
}

/** By priority in the vocabulary's order, every kind before the kinds, the kinds in theirs. */
const order = (target: { kind: string | null; priority: string }): number =>
  TICKET_PRIORITIES.indexOf(target.priority as TicketPriority) * (TICKET_KINDS.length + 1) + (target.kind === null ? 0 : TICKET_KINDS.indexOf(target.kind as TicketKind) + 1)

const targetOf = (row: Row): TicketSlaTarget => ({ id: row.id, kind: row.kind as TicketKind | null, priority: row.priority as TicketPriority, hours: row.hours })

const slaOf = (projectId: string, rows: readonly Row[]): TicketSla => ({ projectId, targets: [...rows].sort((a, b) => order(a) - order(b)).map(targetOf) })

async function targetsOf(tx: Tx, companyId: string, projectId: string): Promise<Row[]> {
  return await tx
    .select(columns)
    .from(ticketSla)
    .where(and(eq(ticketSla.companyId, companyId), eq(ticketSla.projectId, projectId)))
}

export function ticketSlaRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/projects/:id/ticket-sla",
      describeRoute({
        operationId: "getTicketSla",
        summary: "A project's ticket SLA",
        description:
          "The targets a ticket of the project is due by: each the hours from opening to the due date for a priority, for every kind (`kind` null) or for one kind, which wins over every kind's. By priority in the vocabulary's order, every kind first. A project without targets answers an empty list, and its tickets open with no due date unless the opener names one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's targets.", TicketSla),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No project with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        requireOwnProject(principal, id)
        return c.json(slaOf(id, await targetsOf(c.get("tx"), principal.companyId, id)))
      },
    )
    .put(
      "/projects/:id/ticket-sla",
      describeRoute({
        operationId: "putTicketSla",
        summary: "Replace a project's ticket SLA",
        description:
          "Replaces the whole set with the one in the body: a target the body leaves out is gone, and an empty list leaves the project without an SLA. Each kind and priority is named once, every kind counting as one (400 at `targets.N`), and the hours run from 1 to 8760, a year (400 at `targets.N.hours`). A target the body keeps keeps its id and moves only its hours, and a target whose hours did not change is not written, so the audit log reads one row's history per kind and priority, with the `Waste-Change-Reason` the request gave. A ticket already open keeps its due date: the SLA sets one as a ticket opens.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's targets as they now stand.", TicketSla),
          400: describeProblem("The path does not hold an id, or the body is missing `targets`, names a member it does not own, names a kind and a priority twice, carries more targets than every kind and each kind at each priority, or gives hours outside 1..8760."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
          404: describeProblem("No project with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketSlaSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { targets } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireOwnProject(principal, id)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ticket-sla:${principal.companyId}:${id}`}, 0))`)
        const current = new Map((await targetsOf(tx, principal.companyId, id)).map((row) => [slaTargetKey(row), row]))
        const kept = new Set(targets.map(slaTargetKey))
        const gone = [...current.values()].filter((row) => !kept.has(slaTargetKey(row))).map((row) => row.id)
        if (gone.length > 0) await tx.delete(ticketSla).where(and(eq(ticketSla.companyId, principal.companyId), inArray(ticketSla.id, gone)))
        const rows: Row[] = []
        const added = targets.filter((target) => !current.has(slaTargetKey(target)))
        if (added.length > 0) {
          rows.push(
            ...(await tx
              .insert(ticketSla)
              .values(added.map((target) => ({ id: newId(), companyId: principal.companyId, projectId: id, kind: target.kind, priority: target.priority, hours: target.hours })))
              .returning(columns)),
          )
        }
        // A target kept is written only where its hours moved: one statement each, and a person moves a handful at a time.
        for (const target of targets) {
          const before = current.get(slaTargetKey(target))
          if (before === undefined) continue
          if (before.hours === target.hours) {
            rows.push(before)
            continue
          }
          const [row] = await tx
            .update(ticketSla)
            .set({ hours: target.hours })
            .where(and(eq(ticketSla.companyId, principal.companyId), eq(ticketSla.id, before.id)))
            .returning(columns)
          rows.push(row)
        }
        return c.json(slaOf(id, rows))
      },
    )
}
