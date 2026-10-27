// The Site Visit ledger (Issue #393, M4 of #293), under `operate.site-visits`:
// the attendant's check-in at a recycling centre, the ledger read back, a
// mistake voided, and the likely trades.
//
// `POST /site-visits` is the attendant's door into `recordVisit`
// (@waste/db/commands/site-visits), the one the gate's inbound read (M8 of
// #293) calls too, with `source: "gate"` and its `externalId`: this route
// passes `staff` and the person. The site is a recycling centre of a project
// the caller works in (400 at `siteId`); the instant is the request's clock
// unless the body names one, which may run ahead of it by the skew alone.
// The answer is the visit — admitted or refused with the reason, recorded
// either way — and, for an admitted one, what its project's Visit Rule says
// it costs, priced as its billable event will be, so the attendant can say
// "visit 3 this year: 70 kr". The charge itself is the Finance consumer's,
// at `site-visit-recorded`.
//
// A visit is voided, never deleted: `POST /site-visits/:id/void` stamps it
// with the person and the reason and emits `site-visit-voided`, on which the
// consumer cancels its charge, or reverses it once invoiced. A later visit's
// step is not re-tiered: each was judged at its own event.
import { Page } from "@waste/contracts/pagination"
import { FrequentVisitors, FrequentVisitorsQuery, SiteVisit, SiteVisitCheckIn, SiteVisitCheckInAnswer, SiteVisitListQuery, SiteVisitVoid, type VisitChargeReading } from "@waste/contracts/site-visits"
import type { Tx } from "@waste/db/client"
import { fractionsOf, likelyTradesOf, NOT_A_CENTRE, priceVisitCharge, recordVisit, siteVisitOf, visitById, visitColumns } from "@waste/db/commands/site-visits"
import { projectToday } from "@waste/db/commands/project-clock"
import { dropOffPoint } from "@waste/db/schema/drop-off-points"
import { siteVisit } from "@waste/db/schema/site-visits"
import type { VisitCharge } from "@waste/domain/visits/charges"
import { and, desc, eq, gte, lt, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { describeCreated, describeJson, IdParam, lockRow, requireNotAhead } from "./shared"

const MODULE = "operate.site-visits"

const VisitPage = Page(SiteVisit)

type ClockOptions = { now?: () => Date }

/** What a void of a voided visit is told. */
export const ALREADY_VOIDED = "The visit is already voided"

const noSuchVisit = (id: string) => problem(404, { detail: `No site visit ${id} in the projects this account works in` })

const visitScope = (principal: Principal) => and(eq(siteVisit.companyId, principal.companyId), inProjects(siteVisit.projectId, principal))

/** The project of a recycling centre in the projects the caller works in; the 400 at `siteId` otherwise. */
async function siteProject(tx: Tx, principal: Principal, siteId: string): Promise<string> {
  const [found] = await tx
    .select({ projectId: dropOffPoint.projectId })
    .from(dropOffPoint)
    .where(and(eq(dropOffPoint.companyId, principal.companyId), inProjects(dropOffPoint.projectId, principal), eq(dropOffPoint.id, siteId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "siteId", message: NOT_A_CENTRE }])
  return found.projectId
}

/** A charge as the attendant reads it: the domain's, with its step priced under the visit's Agreement on its day. */
async function readingOf(tx: Tx, scope: { companyId: string; projectId: string }, visit: SiteVisit, charge: VisitCharge): Promise<VisitChargeReading> {
  const priced = await priceVisitCharge(tx, scope, visit.agreementId, charge, visit.serviceDate)
  const price = priced?.price ?? null
  return {
    ruleId: charge.ruleId,
    basis: charge.basis,
    counted: charge.counted,
    n: charge.n,
    productId: charge.productId,
    price: price === null ? null : { unitPriceMinor: price.unitPriceMinor, netMinor: price.netMinor, vatPercent: price.vatPercent, vatMinor: price.vatMinor, currency: price.currency },
    blockReason: charge.productId === null ? null : visit.agreementId === null ? "no-subscription" : (priced?.blockReason ?? null),
  }
}

const problems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function siteVisitRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return (
    new Hono<AuthEnv>()
      .get(
        "/site-visits",
        describeRoute({
          operationId: "listSiteVisits",
          summary: "The recycling centres' visit ledger",
          description:
            "One page of the Site Visits of the projects the caller works in, newest first (ids are time-ordered), admitted and refused alike, voided ones included with their stamps. `projectId`, `siteId`, `propertyId`, `customerId`, `source` and `outcome` narrow it; `from` and `to` are a window of the visits' days, both inclusive. Hand `nextCursor` back as `cursor` for the next page.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("One page of visits.", VisitPage),
            400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window ends before it starts, or `projectId` is not a project this account works in."),
            ...problems("view"),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("query", SiteVisitListQuery),
        async (c) => {
          const { limit, cursor, projectId, siteId, from, to, propertyId, customerId, source, outcome } = c.req.valid("query")
          const after = afterCursor(cursor)
          const tx = c.get("tx")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const rows = await tx
            .select(visitColumns)
            .from(siteVisit)
            .where(
              and(
                visitScope(principal),
                projectId === undefined ? undefined : eq(siteVisit.projectId, projectId),
                siteId === undefined ? undefined : eq(siteVisit.siteId, siteId),
                from === undefined ? undefined : gte(siteVisit.serviceDate, from),
                to === undefined ? undefined : lte(siteVisit.serviceDate, to),
                propertyId === undefined ? undefined : eq(siteVisit.propertyId, propertyId),
                customerId === undefined ? undefined : eq(siteVisit.customerId, customerId),
                source === undefined ? undefined : eq(siteVisit.source, source),
                outcome === undefined ? undefined : eq(siteVisit.outcome, outcome),
                after === undefined ? undefined : lt(siteVisit.id, after),
              ),
            )
            .orderBy(desc(siteVisit.id))
            .limit(fetchLimit(limit))
          const page = pageOf(rows, limit)
          const fractions = await fractionsOf(
            tx,
            principal.companyId,
            page.items.map((row) => row.id),
          )
          return c.json({ ...page, items: page.items.map((row) => siteVisitOf(row, fractions.get(row.id) ?? [])) })
        },
      )
      .post(
        "/site-visits",
        describeRoute({
          operationId: "checkInSiteVisit",
          summary: "Check a visitor in at a recycling centre",
          description:
            "The attendant's check-in: the site, a recycling centre of a project the caller works in (400 at `siteId`) and active (409); what identified the visitor — a plate or a card as read, or the Property found by its address (400 at `identifier.propertyId` where it is not the project's); the fractions brought, each one the site takes (400 at `wasteFractionIds.N`); a note; and the instant, the request's own when absent, which may run ahead of the clock by the skew alone. The visit is identified in order — the credential in force on the day, else `unknown-identifier`; a blocked one `credential-blocked`; a household admitted where it pays for collection, else `not-fee-paying` — and recorded admitted or refused. The answer carries, for an admitted visit, what the project's Visit Rule says it costs: the basis, the household's n-th counted visit this calendar year, the product and its price under the visit's Agreement, as the Finance consumer will charge it. Emits `site-visit-recorded`.",
          security: BEARER_SECURITY,
          responses: {
            201: describeCreated("The visit as recorded, and what it costs.", SiteVisitCheckInAnswer),
            400: describeProblem("The body is missing a field, names a member the server owns, a site that is no recycling centre of a project this account works in, a fraction the site does not take or one twice, a Property not of the site's project, or an instant past the clock's skew."),
            ...problems("create"),
            409: describeProblem("The recycling centre is not active."),
          },
        }),
        guard,
        requireGrant(MODULE, "create"),
        validate("json", SiteVisitCheckIn),
        async (c) => {
          const body = c.req.valid("json")
          const tx = c.get("tx")
          const principal = c.get("principal")
          const at = now()
          const occurredAt = body.occurredAt === undefined ? at : new Date(body.occurredAt)
          requireNotAhead(occurredAt, at)
          const projectId = await siteProject(tx, principal, body.siteId)
          const scope = { companyId: principal.companyId, projectId }
          const recorded = await recordVisit(tx, {
            ...scope,
            siteId: body.siteId,
            occurredAt,
            source: "staff",
            externalId: null,
            identifier: body.identifier,
            wasteFractionIds: body.wasteFractionIds,
            note: body.note ?? null,
            recordedBy: principal.user.id,
            newId,
          })
          const answer: SiteVisitCheckInAnswer = { visit: recorded.visit, charge: recorded.charge === null ? null : await readingOf(tx, scope, recorded.visit, recorded.charge) }
          return c.json(answer, 201, { location: `/site-visits/${recorded.visit.id}` })
        },
      )
      // The likely trades before `/:id`, whose validator would refuse `frequent` as an id.
      .get(
        "/site-visits/frequent",
        describeRoute({
          operationId: "listFrequentVisitors",
          summary: "The likely trades",
          description:
            "The Properties of one project the caller works in whose counted visits — admitted, not voided, bringing something other than free fractions — reach the threshold of the Visit Rule in force on `on` within its window of days up to and including `on` (the project's today when absent), most visits first. A reading, never stored; empty where no rule is in force or the rule flags none.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The likely trades on the day.", FrequentVisitors),
            400: describeProblem("`projectId` is missing, malformed or not a project this account works in, or `on` is not a calendar day."),
            ...problems("view"),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("query", FrequentVisitorsQuery),
        async (c) => {
          const { projectId, on } = c.req.valid("query")
          const tx = c.get("tx")
          const principal = c.get("principal")
          requireProject(principal, projectId, "projectId", "query")
          const scope = { companyId: principal.companyId, projectId }
          const day = on ?? (await projectToday(tx, scope, now)())
          const { rule, items } = await likelyTradesOf(tx, scope, day)
          const answer: FrequentVisitors = { projectId, on: day, ruleId: rule?.id ?? null, threshold: rule?.tradeThreshold ?? null, windowDays: rule?.tradeWindowDays ?? null, items }
          return c.json(answer)
        },
      )
      .get(
        "/site-visits/:id",
        describeRoute({
          operationId: "getSiteVisit",
          summary: "One site visit",
          description: "One visit of a project the caller works in, with the fractions it brought. A visit of another company, or of a project this account does not work in, is one that does not exist here.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The visit.", SiteVisit),
            400: describeProblem("The path does not hold an id."),
            ...problems("view"),
            404: describeProblem("No visit with that id in the projects this account works in."),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("param", IdParam),
        async (c) => {
          const { id } = c.req.valid("param")
          const principal = c.get("principal")
          const found = await visitById(c.get("tx"), principal.companyId, id)
          if (found === undefined || !principal.projects.some((project) => project.id === found.row.projectId)) throw noSuchVisit(id)
          return c.json(found.visit)
        },
      )
      .post(
        "/site-visits/:id/void",
        describeRoute({
          operationId: "voidSiteVisit",
          summary: "Void a site visit",
          description:
            "Voids one visit recorded by mistake, with the reason, under its row lock: the visit stays in the ledger with the person and the instant, as the bookkeeping evidence its charge was, and is never deleted. Emits `site-visit-voided`, on which the Finance consumer cancels the visit's charge, or reverses it once a line names it. A later visit keeps the step it was charged at. A voided visit is voided once (409).",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The visit as it now stands.", SiteVisit),
            400: describeProblem("The path does not hold an id, or the body gives no reason."),
            ...problems("edit"),
            404: describeProblem("No visit with that id in the projects this account works in."),
            409: describeProblem("The visit is already voided."),
          },
        }),
        guard,
        requireGrant(MODULE, "edit"),
        validate("param", IdParam),
        validate("json", SiteVisitVoid),
        async (c) => {
          const { id } = c.req.valid("param")
          const { reason } = c.req.valid("json")
          const tx = c.get("tx")
          const principal = c.get("principal")
          await lockRow(tx, siteVisit, { companyId: principal.companyId, id })
          const [current] = await tx
            .select({ projectId: siteVisit.projectId, voidedAt: siteVisit.voidedAt })
            .from(siteVisit)
            .where(and(visitScope(principal), eq(siteVisit.id, id)))
            .limit(1)
          if (current === undefined) throw noSuchVisit(id)
          if (current.voidedAt !== null) throw problem(409, { detail: ALREADY_VOIDED })
          const at = now()
          await tx
            .update(siteVisit)
            .set({ voidedAt: at, voidedBy: principal.user.id, voidReason: reason })
            .where(and(visitScope(principal), eq(siteVisit.id, id)))
          const found = await visitById(tx, principal.companyId, id)
          if (found === undefined) throw noSuchVisit(id)
          await emit(tx, principal, { aggregate: "site-visit", aggregateId: id, kind: "site-visit-voided", payload: found.visit, projectId: current.projectId, occurredAt: at })
          return c.json(found.visit)
        },
      )
  )
}
