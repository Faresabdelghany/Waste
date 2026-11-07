// Counting Rules (#547 of #544): a company's rules counting the completed
// emptyings at each property over a month, a quarter or a year, and the
// ticket a rule opens on a property whose count reaches its limit (the
// worker's `counting` consumer, apps/worker/src/resolution/count-emptyings.ts).
// `GET /counting-rules` lists them, `POST /counting-rules` adds one,
// `GET`/`PATCH`/`DELETE /counting-rules/:id` read, change and remove one, and
// `POST /counting-rules/simulation` counts what a rule's terms would have
// counted over past emptyings, saved or not, so a rule is tried before it is
// switched on.
//
// A rule is the company's and no project's, like the Ticket Type it opens, so
// every statement carries `company_id = the caller's` beside the fence
// (ADR-0001), and it counts every project the company runs. Its fraction and
// container type are the company's (400 at the field), its ticket type and
// team the company's (400) and active where newly named (409, a status
// gating a new reference). A rule starts inactive. One that has opened a
// ticket is never deleted (409), since each ticket names it: it is switched
// off instead.
//
// The simulation counts the caller's projects only — the emptyings of a
// project they do not work in are not theirs to read — over the window
// widened to whole periods (@waste/domain/resolution/counting-rules), with
// the stops a rule counts spelled once for the worker and for it
// (@waste/db/commands/counting-rules). The periods are the domain's, handed
// to the statement as a list, so no `date_trunc` restates the rule.
//
// The grant is `configure.templates`, where the ticket types and the teams
// are; the simulation reads stops too, so it asks `route-studio.pickups`
// beside it.
import { CountingRule, CountingRuleCreate, CountingRuleListQuery, CountingRulePatch, CountingSimulation, CountingSimulationBody, type CountingSimulationTicket } from "@waste/contracts/counting-rules"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { countedStops, stopOnItsRoute } from "@waste/db/commands/counting-rules"
import { property } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { countingRule, team, ticket } from "@waste/db/schema/resolution"
import { periodsOver, SIMULATION_TICKETS_SHOWN, wholePeriods } from "@waste/domain/resolution/counting-rules"
import { ACTIVE_TEAM_STATUSES, ACTIVE_TICKET_TYPE_STATUSES, type TeamStatus } from "@waste/domain/resolution/vocabulary"
import { retiredTeam } from "@waste/domain/resolution/teams"
import { retiredTicketType } from "@waste/domain/resolution/ticket-types"
import { refuseUnless } from "@waste/domain/status-gates"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { lockRow, refuseDuplicate, strengthFor } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { NOT_A_TEAM, requireContainerType, requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam } from "./shared"
import { findNamedType } from "./ticket-type-rules"

const MODULE = "configure.templates"
const PICKUPS = "route-studio.pickups"

const CountingRulePage = Page(CountingRule)

const columns = {
  id: countingRule.id,
  name: countingRule.name,
  status: countingRule.status,
  period: countingRule.period,
  limit: countingRule.limit,
  wasteFractionId: countingRule.wasteFractionId,
  containerTypeId: countingRule.containerTypeId,
  ticketTypeId: countingRule.ticketTypeId,
  teamId: countingRule.teamId,
  notifiesTeam: countingRule.notifiesTeam,
  createdAt: countingRule.createdAt,
  updatedAt: countingRule.updatedAt,
}
type Row = Pick<typeof countingRule.$inferSelect, keyof typeof columns>

/** `unique (company_id, name)`: a name is one rule's inside a company. */
const NAME_TAKEN = "counting_rule_name_key"
const nameTaken = (name: string) => `This company already has a counting rule called ${JSON.stringify(name)}`

/** What deleting a rule that has opened a ticket is told. */
export const ruleHasTickets = (name: string) => `The counting rule ${JSON.stringify(name)} has opened tickets, which name it; switch it off instead`

const noSuchRule = (id: string) => problem(404, { detail: `No counting rule ${id} in this company` })

const scope = (principal: Principal) => eq(countingRule.companyId, principal.companyId)

const ruleOf = (row: Row): CountingRule => ({ ...row, status: row.status, period: row.period, ...stampsOf(row) })

async function findRule(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(countingRule)
    .where(and(scope(principal), eq(countingRule.id, id)))
    .limit(1)
  return row
}

/** The team a body names: the company's, or a 400 at `teamId`; its status the caller's 409 to ask, after every 400. */
async function findNamedTeam(tx: Tx, companyId: string, id: string): Promise<{ name: string; status: TeamStatus }> {
  const [found] = await tx
    .select({ name: team.name, status: team.status })
    .from(team)
    .where(and(eq(team.companyId, companyId), eq(team.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "teamId", message: NOT_A_TEAM }])
  return { name: found.name, status: found.status }
}

/** The references a body names afresh, each the company's (400), then the type and the team active (409): a status gates a new reference, never one the rule already makes. */
async function requireReferences(tx: Tx, companyId: string, named: Partial<Pick<Row, "wasteFractionId" | "containerTypeId" | "ticketTypeId" | "teamId">>): Promise<void> {
  await requireWasteFraction(tx, companyId, named.wasteFractionId)
  await requireContainerType(tx, companyId, named.containerTypeId)
  const type = named.ticketTypeId === undefined ? undefined : await findNamedType(tx, companyId, named.ticketTypeId)
  const waitsWith = named.teamId === undefined ? undefined : await findNamedTeam(tx, companyId, named.teamId)
  if (type !== undefined) refuseUnless(type.status, ACTIVE_TICKET_TYPE_STATUSES, retiredTicketType(type.name))
  if (waitsWith !== undefined) refuseUnless(waitsWith.status, ACTIVE_TEAM_STATUSES, retiredTeam(waitsWith.name))
}

/** The fields of a patch whose value differs from the rule's: what it names afresh. */
function namedAfresh(current: Row, patch: CountingRulePatch): Partial<Pick<Row, "wasteFractionId" | "containerTypeId" | "ticketTypeId" | "teamId">> {
  const keys = ["wasteFractionId", "containerTypeId", "ticketTypeId", "teamId"] as const
  return Object.fromEntries(keys.flatMap((key) => (patch[key] === undefined || patch[key] === current[key] ? [] : [[key, patch[key]]])))
}

/** What the rule's terms would have counted over the window, in the caller's projects: the tickets it would have opened, the earliest reached first. */
async function simulate(tx: Tx, principal: Principal, body: CountingSimulationBody): Promise<CountingSimulation> {
  const window = wholePeriods(body, body.period)
  const periods = periodsOver(window, body.period)
  const periodRows = sql.join(
    periods.map((one) => sql`(${one.from}::date, ${one.to}::date)`),
    sql`, `,
  )
  // Each counted stop numbered within its property's period, by service date; the stop numbered `limit` is where the ticket would have opened.
  const counted = sql`
    select ${pickup.propertyId} as property_id, ${pickup.projectId} as project_id, periods.period_from, ${route.serviceDate} as service_date,
      row_number() over (partition by ${pickup.propertyId}, periods.period_from order by ${route.serviceDate}, ${pickup.id}) as place,
      count(*) over (partition by ${pickup.propertyId}, periods.period_from) as total
    from ${pickup}
    inner join ${route} on ${stopOnItsRoute}
    inner join (values ${periodRows}) as periods (period_from, period_to) on ${route.serviceDate} >= periods.period_from and ${route.serviceDate} < periods.period_to
    where ${countedStops(principal.companyId, body)} and ${inProjects(pickup.projectId, principal)} and ${route.serviceDate} >= ${window.from}::date and ${route.serviceDate} < ${window.to}::date`
  const reached = sql`select property_id, project_id, period_from, service_date, total from (${counted}) as counted where place = ${body.limit}`
  const [totals] = (await tx.execute(sql`select count(*)::int as tickets, count(distinct property_id)::int as properties from (${reached}) as reached`)) as unknown as { tickets: number; properties: number }[]
  const shown = (await tx.execute(sql`
    select reached.property_id, ${property.name} as property_name, reached.project_id, reached.period_from::text, reached.service_date::text as reached_on, reached.total::int
    from (${reached}) as reached
    inner join ${property} on ${property.companyId} = ${principal.companyId} and ${property.id} = reached.property_id
    order by reached.service_date, reached.property_id
    limit ${SIMULATION_TICKETS_SHOWN}`)) as unknown as { property_id: string; property_name: string; project_id: string; period_from: string; reached_on: string; total: number }[]
  return {
    from: window.from,
    to: window.to,
    tickets: totals.tickets,
    properties: totals.properties,
    shown: shown.map(
      (row): CountingSimulationTicket => ({ propertyId: row.property_id, propertyName: row.property_name, projectId: row.project_id, periodFrom: row.period_from, reachedOn: row.reached_on, count: row.total }),
    ),
  }
}

export function countingRuleRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/counting-rules",
      {
        operationId: "listCountingRules",
        summary: "The company's counting rules",
        description: "One page of the company's counting rules, oldest first (ids are time-ordered). `status` narrows the page to the active or the inactive. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: CountingRuleListQuery,
        invalid: ["the status is not one of its list"],
        responses: {
          200: describeJson("One page of counting rules.", CountingRulePage),
        },
      },
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(countingRule)
          .where(and(scope(c.get("principal")), status === undefined ? undefined : eq(countingRule.status, status), after === undefined ? undefined : gt(countingRule.id, after)))
          .orderBy(asc(countingRule.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(ruleOf), nextCursor })
      },
    )
    .post(
      "/counting-rules",
      {
        operationId: "createCountingRule",
        summary: "Add a counting rule",
        description:
          "Adds a rule counting the completed emptyings at each property over a calendar `period` — of one waste fraction or one container type where it names them — that opens one ticket of `ticketTypeId`, waiting with `teamId`, on a property whose count reaches `limit`, once per property and period. `notifiesTeam` e-mails each member of the team the ticket as it opens. `status` is `inactive` unless said, so a rule is simulated first. `name` is unique inside the company. The server mints the id.",
        module: MODULE,
        action: "create",
        body: CountingRuleCreate,
        invalid: ["the body is missing a field, names a member the server owns, sets a limit outside 1..1000, or names a fraction, a container type, a ticket type or a team that is not the company's"],
        responses: {
          201: describeCreated("The rule as it was written.", CountingRule),
          409: describeProblem("The company already has a rule with that name, or the ticket type or the team is retired."),
        },
      },
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await requireReferences(tx, principal.companyId, values)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(countingRule)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/counting-rules", ruleOf(row))
      },
    )
    .post(
      "/counting-rules/simulation",
      {
        operationId: "simulateCountingRule",
        summary: "Simulate a counting rule over past emptyings",
        description:
          "Counts what a rule's terms — its period, its limit, its fraction and container type — would have counted over the emptyings from `from` to `to` (the first day not counted, at most three years after `from`), widened to whole periods, in the projects the caller works in, and answers the tickets it would have opened: how many, at how many properties, and the first " +
          SIMULATION_TICKETS_SHOWN +
          " by the day each property's count reached the limit, with the period's whole count. A property counts its emptyings by its route's service date. Nothing is written.",
        module: MODULE,
        action: "view",
        also: [PICKUPS, "view"],
        body: CountingSimulationBody,
        invalid: ["the body is missing a field, sets a limit outside 1..1000, runs its window backwards or over three years, or names a fraction or a container type that is not the company's"],
        responses: {
          200: describeJson("The tickets the rule would have opened.", CountingSimulation),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on both \`${MODULE}\` and \`${PICKUPS}\`.`),
        },
      },
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await requireWasteFraction(tx, principal.companyId, body.wasteFractionId)
        await requireContainerType(tx, principal.companyId, body.containerTypeId)
        return c.json(await simulate(tx, principal, body))
      },
    )
    .get(
      "/counting-rules/:id",
      {
        operationId: "getCountingRule",
        summary: "One counting rule",
        description: "One rule of the caller's company. Another company's rule is a rule that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The rule.", CountingRule),
          404: describeProblem("No counting rule with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findRule(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchRule(id)
        return c.json(ruleOf(row))
      },
    )
    .patch(
      "/counting-rules/:id",
      {
        operationId: "patchCountingRule",
        summary: "Change a counting rule, or switch it on or off",
        description:
          "Changes any of the rule's fields; `status` switches it on (`active`) or off (`inactive`). A ticket type or a team named afresh is the company's and active; one the rule already names stands whatever its status. The tickets the rule has opened keep the count and the period they were opened for; a changed term counts from the next emptying on, and a property that already has its ticket for a period gets no second one. Under the rule's row lock.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: CountingRulePatch,
        invalid: ["the patch is empty, names a field the server owns, sets a limit outside 1..1000, or names a fraction, a container type, a ticket type or a team that is not the company's"],
        responses: {
          200: describeJson("The rule as it now stands.", CountingRule),
          404: describeProblem("No counting rule with that id in this company."),
          409: describeProblem("The company already has another rule with that name, or the ticket type or the team named is retired."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, countingRule, { companyId: principal.companyId, id }, strengthFor(countingRule, patch))
        const current = await findRule(tx, principal, id)
        if (current === undefined) throw noSuchRule(id)
        await requireReferences(tx, principal.companyId, namedAfresh(current, patch))
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(countingRule)
            .set(patch)
            .where(and(scope(principal), eq(countingRule.id, id)))
            .returning(columns),
        )
        return c.json(ruleOf(row))
      },
    )
    .delete(
      "/counting-rules/:id",
      {
        operationId: "deleteCountingRule",
        summary: "Remove a counting rule that has opened no ticket",
        description: "Removes a rule set up wrongly, while no ticket names it; the audit trail keeps what it was. A rule that has opened a ticket is switched off instead (409). Answers 204 with no body.",
        module: MODULE,
        action: "delete",
        params: IdParam,
        responses: {
          204: { description: "The rule is removed." },
          404: describeProblem("No counting rule with that id in this company."),
          409: describeProblem("The rule has opened a ticket."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The delete's own strength: a ticket the worker is opening holds the rule's key share until it commits, and is then read below; one it opens after waits on this lock and finds no rule.
        await lockRow(tx, countingRule, { companyId: principal.companyId, id }, "update")
        const current = await findRule(tx, principal, id)
        if (current === undefined) throw noSuchRule(id)
        const [opened] = await tx
          .select({ id: ticket.id })
          .from(ticket)
          .where(and(eq(ticket.companyId, principal.companyId), eq(ticket.countingRuleId, id)))
          .limit(1)
        if (opened !== undefined) throw problem(409, { detail: ruleHasTickets(current.name) })
        await tx.delete(countingRule).where(and(scope(principal), eq(countingRule.id, id)))
        return c.body(null, 204)
      },
    )
}
