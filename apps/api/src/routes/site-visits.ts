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
import { FrequentVisitors, FrequentVisitorsQuery, SiteVisit, SiteVisitCheckIn, SiteVisitCheckInAnswer, SiteVisitListQuery, SiteVisitVoid, VisitAddresses, VisitAddressQuery, VisitSites, VisitSitesQuery, type VisitChargeQuoted, type VisitChargeReading } from "@waste/contracts/site-visits"
import type { Tx } from "@waste/db/client"
import { likelyTradesOf, NOT_A_CENTRE, priceVisitCharge, recordVisit } from "@waste/db/commands/site-visits"
import { projectToday } from "@waste/db/query/project-clock"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { property } from "@waste/db/schema/customers"
import { dropOffPoint, dropOffPointFraction } from "@waste/db/schema/drop-off-points"
import { siteVisit } from "@waste/db/schema/site-visits"
import { VISIT_ADDRESS_MAX } from "@waste/domain/visits/charges"
import { and, asc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { emit } from "@waste/db/commands/outbox"
import { fractionsOf, siteVisitOf, visitById, visitColumns } from "@waste/db/shapes/site-visits"
import { lockRow } from "@waste/db/commands/shared"

import type { Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { scoped } from "../scoped"
import { requireNotAhead } from "./shared"

const MODULE = "operate.site-visits"

const VisitPage = Page(SiteVisit)

/** What a void of a voided visit is told. */
export const ALREADY_VOIDED = "The visit is already voided"

const { scope: visitScope, noSuch: noSuchVisit, list: listVisits } = scoped(siteVisit, { noun: "site visit", reach: "projects", columns: visitColumns, order: "desc" })

async function siteProject(tx: Tx, principal: Principal, siteId: string): Promise<string> {
  const [found] = await tx
    .select({ projectId: dropOffPoint.projectId })
    .from(dropOffPoint)
    .where(and(eq(dropOffPoint.companyId, principal.companyId), inProjects(dropOffPoint.projectId, principal), eq(dropOffPoint.id, siteId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "siteId", message: NOT_A_CENTRE }])
  return found.projectId
}

/** A charge as the attendant reads it: what the visit was charged at, stored with it, and that product priced under the visit's Agreement on its day. */
async function readingOf(tx: Tx, scope: { companyId: string; projectId: string }, visit: SiteVisit, charge: VisitChargeQuoted): Promise<VisitChargeReading> {
  const priced = await priceVisitCharge(tx, scope, visit.agreementId, charge.productId, visit.serviceDate)
  const price = priced?.price ?? null
  return {
    ...charge,
    price: price === null ? null : { unitPriceMinor: price.unitPriceMinor, netMinor: price.netMinor, vatPercent: price.vatPercent, vatMinor: price.vatMinor, currency: price.currency },
    blockReason: charge.productId === null ? null : visit.agreementId === null ? "no-subscription" : (priced?.blockReason ?? null),
  }
}

export function siteVisitRoutes(deps: RouteDeps) {
  const { now } = deps
  return (
    routes(deps)
      .get(
        "/site-visits",
        {
          operationId: "listSiteVisits",
          summary: "The recycling centres' visit ledger",
          description:
            "One page of the Site Visits of the projects the caller works in, newest first (ids are time-ordered), admitted and refused alike, voided ones included with their stamps. `projectId`, `siteId`, `propertyId`, `customerId`, `source` and `outcome` narrow it; `from` and `to` are a window of the visits' days, both inclusive. Hand `nextCursor` back as `cursor` for the next page.",
          module: MODULE,
          action: "view",
          query: SiteVisitListQuery,
          invalid: ["a filter is malformed", "the window ends before it starts", "`projectId` is not a project this account works in"],
          responses: {
            200: describeJson("One page of visits.", VisitPage),
          },
        },
        async (c) => {
          const { limit, cursor, projectId, siteId, from, to, propertyId, customerId, source, outcome } = c.req.valid("query")
          const at = pageAt({ cursor, limit })
          const tx = c.get("tx")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const page = await listVisits(
            tx,
            principal,
            at,
            projectId === undefined ? undefined : eq(siteVisit.projectId, projectId),
            siteId === undefined ? undefined : eq(siteVisit.siteId, siteId),
            from === undefined ? undefined : gte(siteVisit.serviceDate, from),
            to === undefined ? undefined : lte(siteVisit.serviceDate, to),
            propertyId === undefined ? undefined : eq(siteVisit.propertyId, propertyId),
            customerId === undefined ? undefined : eq(siteVisit.customerId, customerId),
            source === undefined ? undefined : eq(siteVisit.source, source),
            outcome === undefined ? undefined : eq(siteVisit.outcome, outcome),
          )
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
        {
          operationId: "checkInSiteVisit",
          summary: "Check a visitor in at a recycling centre",
          description:
            "The attendant's check-in: the site, a recycling centre of a project the caller works in (400 at `siteId`) and active (409); what identified the visitor — a plate or a card as read, or the Property found by its address (400 at `identifier.propertyId` where it is not the project's); the fractions brought, each one the site takes (400 at `wasteFractionIds.N`); a note; and the instant, the request's own when absent, which may run ahead of the clock by the skew alone. The visit is identified in order — the credential in force on the day, else `unknown-identifier`; a blocked one `credential-blocked`; a household admitted where it pays for collection, else `not-fee-paying` — and recorded admitted or refused. The answer carries, for an admitted visit, what the project's Visit Rule says it costs: the basis, the household's n-th counted visit this calendar year, the product and its price under the visit's Agreement, as the Finance consumer will charge it. Emits `site-visit-recorded`.",
          module: MODULE,
          action: "create",
          body: SiteVisitCheckIn,
          invalid: ["the body is missing a field, names a member the server owns, a site that is no recycling centre of a project this account works in, a fraction the site does not take or one twice, a Property not of the site's project, or an instant past the clock's skew"],
          responses: {
            201: describeCreated("The visit as recorded, and what it costs.", SiteVisitCheckInAnswer),
            409: describeProblem("The recycling centre is not active."),
          },
        },
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
          const answer: SiteVisitCheckInAnswer = { visit: recorded.visit, charge: recorded.visit.charge === null ? null : await readingOf(tx, scope, recorded.visit, recorded.visit.charge) }
          return c.json(answer, 201, { location: `/site-visits/${recorded.visit.id}` })
        },
      )
      // The attendant's two lookups and the likely trades before `/:id`, whose validator would refuse their names as ids.
      .get(
        "/site-visits/sites",
        {
          operationId: "listVisitSites",
          summary: "The recycling centres a visitor is checked in at",
          description:
            "One project's active recycling centres, by name, each with the fractions it takes by name: what the check-in's site picker and its fraction chips are drawn from, under `operate.site-visits` so the Site attendant needs no grant on the Drop-off Points or the master data themselves. Nothing of the office's — no notes, hours or exceptions. `projectId` is a project the caller works in (400 on the query otherwise).",
          module: MODULE,
          action: "view",
          query: VisitSitesQuery,
          invalid: ["`projectId` is missing, malformed or not a project this account works in"],
          responses: {
            200: describeJson("The project's active recycling centres.", VisitSites),
          },
        },
        async (c) => {
          const { projectId } = c.req.valid("query")
          const tx = c.get("tx")
          const principal = c.get("principal")
          requireProject(principal, projectId, "projectId", "query")
          const sites = await tx
            .select({ id: dropOffPoint.id, projectId: dropOffPoint.projectId, code: dropOffPoint.code, name: dropOffPoint.name })
            .from(dropOffPoint)
            .where(and(eq(dropOffPoint.companyId, principal.companyId), eq(dropOffPoint.projectId, projectId), eq(dropOffPoint.kind, "recycling-centre"), eq(dropOffPoint.status, "active")))
            .orderBy(asc(dropOffPoint.name))
          const fractions =
            sites.length === 0
              ? []
              : await tx
                  .select({ siteId: dropOffPointFraction.dropOffPointId, id: wasteFraction.id, name: wasteFraction.name })
                  .from(dropOffPointFraction)
                  .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, dropOffPointFraction.companyId), eq(wasteFraction.id, dropOffPointFraction.wasteFractionId)))
                  .where(and(eq(dropOffPointFraction.companyId, principal.companyId), inArray(dropOffPointFraction.dropOffPointId, sites.map((site) => site.id))))
                  .orderBy(asc(wasteFraction.name), asc(wasteFraction.id))
          const answer: VisitSites = { items: sites.map((site) => ({ ...site, wasteFractions: fractions.filter((row) => row.siteId === site.id).map(({ id, name }) => ({ id, name })) })) }
          return c.json(answer)
        },
      )
      .get(
        "/site-visits/addresses",
        {
          operationId: "searchVisitAddresses",
          summary: "Find a household by its address for a check-in",
          description: `One project's Properties whose name or address holds \`q\` (at least two characters, case-insensitive), at most ${VISIT_ADDRESS_MAX} by name: what a check-in by address names, under \`operate.site-visits\` so the Site attendant needs no grant on the Properties themselves. Each answers its id, its name and its address and nothing else — no parties, notes or subscriptions: whether it pays for collection is the check-in's to judge. \`projectId\` is a project the caller works in (400 on the query otherwise).`,
          module: MODULE,
          action: "view",
          query: VisitAddressQuery,
          invalid: ["`projectId` is missing, malformed or not a project this account works in, or `q` is shorter than two characters or longer than a hundred"],
          responses: {
            200: describeJson("The Properties that match, at most twenty.", VisitAddresses),
          },
        },
        async (c) => {
          const { projectId, q } = c.req.valid("query")
          const tx = c.get("tx")
          const principal = c.get("principal")
          requireProject(principal, projectId, "projectId", "query")
          // The pattern's own wildcards are the person's literal text.
          const pattern = `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
          const rows = await tx
            .select({ propertyId: property.id, projectId: property.projectId, name: property.name, address: property.address })
            .from(property)
            .where(and(eq(property.companyId, principal.companyId), eq(property.projectId, projectId), or(ilike(property.name, pattern), ilike(property.address, pattern))))
            .orderBy(asc(property.name), asc(property.id))
            .limit(VISIT_ADDRESS_MAX)
          const answer: VisitAddresses = { items: rows }
          return c.json(answer)
        },
      )
      .get(
        "/site-visits/frequent",
        {
          operationId: "listFrequentVisitors",
          summary: "The likely trades",
          description:
            "The Properties of one project the caller works in whose counted visits — admitted, not voided, bringing something other than free fractions — reach the threshold of the Visit Rule in force on `on` within its window of days up to and including `on` (the project's today when absent), most visits first. A reading, never stored; empty where no rule is in force or the rule flags none.",
          module: MODULE,
          action: "view",
          query: FrequentVisitorsQuery,
          invalid: ["`projectId` is missing, malformed or not a project this account works in, or `on` is not a calendar day"],
          responses: {
            200: describeJson("The likely trades on the day.", FrequentVisitors),
          },
        },
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
        {
          operationId: "getSiteVisit",
          summary: "One site visit",
          description: "One visit of a project the caller works in, with the fractions it brought. A visit of another company, or of a project this account does not work in, is one that does not exist here.",
          module: MODULE,
          action: "view",
          params: IdParam,
          responses: {
            200: describeJson("The visit.", SiteVisit),
            404: describeProblem("No visit with that id in the projects this account works in."),
          },
        },
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
        {
          operationId: "voidSiteVisit",
          summary: "Void a site visit",
          description:
            "Voids one visit recorded by mistake, with the reason, under its row lock: the visit stays in the ledger with the person and the instant, as the bookkeeping evidence its charge was, and is never deleted. Emits `site-visit-voided`, on which the Finance consumer cancels the visit's charge, or reverses it once a line names it. A later visit keeps the step it was charged at. A voided visit is voided once (409).",
          module: MODULE,
          action: "edit",
          params: IdParam,
          body: SiteVisitVoid,
          invalid: ["the body gives no reason"],
          responses: {
            200: describeJson("The visit as it now stands.", SiteVisit),
            404: describeProblem("No visit with that id in the projects this account works in."),
            409: describeProblem("The visit is already voided."),
          },
        },
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
          await emit(tx, principal, { aggregateId: id, kind: "site-visit-voided", payload: found.visit, projectId: current.projectId, occurredAt: at })
          return c.json(found.visit)
        },
      )
  )
}
