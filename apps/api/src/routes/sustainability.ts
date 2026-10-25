// The customer sustainability report (M13 of #293,
// @waste/domain/insight/sustainability): one Customer's collected waste over
// a window of operating days, by site and fraction — how much, how it was
// weighed, how much of it was recycled, and what it emitted and avoided.
// `GET /reports/sustainability` answers it and `GET
// /reports/sustainability.csv` files it. Like every report it counts rows and
// stores nothing, under two grants: the customers' module it is read in and
// the stops' module whose rows it counts.
//
// A completed stop is the Customer's when its container served one of the
// Customer's agreements on the stop's operating day: the container's
// placement in force that day, its subscription, its agreement. The stops are
// weighed with their routes' every completed stop and unloaded kilograms, so
// a route's weighbridge kilograms are shared over all its stops of a fraction,
// whoever's they are; the report then keeps the Customer's. A stop at one of
// the Customer's sites with no container is no agreement's, and is counted
// there as not attributed. Fraction density is #290's O10, which this report
// reads nothing of until it lands: no stop is estimated before then.
import { SustainabilityFileQuery, SustainabilityReport, SustainabilityReportQuery } from "@waste/contracts/sustainability"
import type { Tx } from "@waste/db/client"
import { reviewStatus, weightReviewOf } from "@waste/db/query/weight-review"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, proofOfService, route, unload } from "@waste/db/schema/execution"
import { wasteFractionEmissionFactor } from "@waste/db/schema/sustainability"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"
import { unloadStanding } from "@waste/domain/insight/readings"
import { sustainabilityCsv, sustainabilityLines, weighStops, type CustomerStop, type RouteUnloaded, type StopToWeigh } from "@waste/domain/insight/sustainability"
import type { WasteTreatment } from "@waste/domain/registry/vocabulary"
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { describeProblem, validate } from "../problem"
import { requireCustomer } from "./references"
import { byName, routesOfWindow } from "./reports"
import { describeJson } from "./shared"

const CUSTOMERS = "customers.contacts"
const STOPS = "route-studio.pickups"

const DESCRIBE_401 = describeProblem("No usable token (see WWW-Authenticate).")
const DESCRIBE_403 = describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${CUSTOMERS}\` and \`view\` on \`${STOPS}\`, the rows this report counts.`)
const QUERY_REFUSED = "the customer is not one of the company's, a day is not a calendar day or comes before the reports' first, the window runs backwards or is longer than the reports' bound"

/** A placement in force on its stop's route's operating day, half-open (ADR-0005). */
const placementOnRouteDay = sql`${containerServicePlacement.validFrom} <= ${route.operatingDate} and (${containerServicePlacement.validTo} is null or ${containerServicePlacement.validTo} > ${route.operatingDate})`

/** A stop's site as one key: its property, or its shared collection point. */
const siteKeyOf = (stop: { propertyId: string | null; sharedCollectionPointId: string | null }): string => (stop.propertyId !== null ? `property:${stop.propertyId}` : `point:${stop.sharedCollectionPointId}`)

const unique = <T,>(values: readonly (T | null)[]): T[] => [...new Set(values.filter((value): value is T => value !== null))]

async function sustainabilityReport(tx: Tx, principal: Principal, query: SustainabilityReportQuery): Promise<SustainabilityReport> {
  const { customerId } = query
  const window = { from: query.from, to: query.to }
  const { companyId } = principal
  await requireCustomer(tx, companyId, customerId, "customerId", "query")
  // A collection, as the service report counts one: a completed emptying, never a work order's delivery, removal or swap.
  const collections = and(eq(pickup.companyId, companyId), inProjects(pickup.projectId, principal), eq(pickup.status, "completed"), eq(pickup.service, "empty"), routesOfWindow(window))

  // The Customer's collections: their containers' placements on the day, under the Customer's agreements.
  const mine = await tx
    .select({ id: pickup.id, routeId: pickup.routeId, wasteFractionId: pickup.wasteFractionId, propertyId: pickup.propertyId, sharedCollectionPointId: pickup.sharedCollectionPointId, day: route.operatingDate })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .innerJoin(containerServicePlacement, and(eq(containerServicePlacement.companyId, pickup.companyId), eq(containerServicePlacement.containerId, pickup.containerId), placementOnRouteDay))
    .innerJoin(subscription, and(eq(subscription.companyId, pickup.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
    .innerJoin(agreement, and(eq(agreement.companyId, pickup.companyId), eq(agreement.id, subscription.agreementId)))
    .where(and(collections, eq(agreement.customerId, customerId)))
  const routeIds = unique(mine.map((stop) => stop.routeId))
  const fractionIds = unique(mine.map((stop) => stop.wasteFractionId))

  // Every collection of the Customer's fractions on those routes, whoever's: what a route's unloads are shared over, in the stop list's order so a share's odd kilogram always goes to the same stop.
  const latestWeight = tx
    .selectDistinctOn([proofOfService.pickupId], { pickupId: proofOfService.pickupId, weightKg: proofOfService.weightKg })
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), inProjects(proofOfService.projectId, principal), eq(proofOfService.kind, "weight"), routeIds.length === 0 ? sql`false` : inArray(proofOfService.routeId, routeIds)))
    .orderBy(proofOfService.pickupId, desc(proofOfService.id))
    .as("latest_weight")
  const onRoutes =
    routeIds.length === 0
      ? []
      : await tx
          .select({ id: pickup.id, routeId: pickup.routeId, wasteFractionId: pickup.wasteFractionId, volumeLitres: containerType.volumeLitres, measuredKg: latestWeight.weightKg })
          .from(pickup)
          .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
          .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
          .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
          .leftJoin(latestWeight, eq(latestWeight.pickupId, pickup.id))
          .where(and(collections, inArray(pickup.routeId, routeIds), inArray(pickup.wasteFractionId, fractionIds)))
          .orderBy(asc(pickup.routeId), asc(pickup.position), asc(pickup.id))

  // The routes' unloads that count: tipped — no load the station refused (O9 of #290), which stays on board — and neither rejected nor superseded by a correction, whose own row counts.
  const review = weightReviewOf(tx, companyId, unload.id)
  const unloads =
    routeIds.length === 0
      ? []
      : await tx
          .select({ routeId: unload.routeId, wasteFractionId: unload.wasteFractionId, netKg: unload.netKg, status: reviewStatus(review.decision) })
          .from(unload)
          .leftJoinLateral(review, sql`true`)
          .where(and(eq(unload.companyId, companyId), inProjects(unload.projectId, principal), inArray(unload.routeId, routeIds), inArray(unload.wasteFractionId, fractionIds), isNull(unload.refusalReason)))
  const counted: RouteUnloaded[] = unloads.filter((row) => {
    const standing = unloadStanding(row.status as WeightReviewStatus)
    return standing !== "rejected" && standing !== "superseded"
  })

  // Densities are #290's O10, recorded nowhere yet: nothing is estimated before then.
  const weights = weighStops(onRoutes.map((stop) => ({ ...stop, densityKgPerM3: null }) satisfies StopToWeigh), counted)
  const stops: CustomerStop[] = mine.map((stop) => ({ siteKey: siteKeyOf(stop), wasteFractionId: stop.wasteFractionId, day: stop.day, weight: weights.get(stop.id) ?? { kg: null, basis: "unmeasured" } }))

  // The fractions' treatments and names, and their factors.
  const fractions =
    fractionIds.length === 0
      ? []
      : await tx
          .select({ id: wasteFraction.id, name: wasteFraction.name, treatment: wasteFraction.treatment })
          .from(wasteFraction)
          .where(and(eq(wasteFraction.companyId, companyId), inArray(wasteFraction.id, fractionIds)))
  const factors =
    fractionIds.length === 0
      ? []
      : await tx
          .select({
            wasteFractionId: wasteFractionEmissionFactor.wasteFractionId,
            footprintKgPerTonne: wasteFractionEmissionFactor.footprintKgPerTonne,
            avoidedKgPerTonne: wasteFractionEmissionFactor.avoidedKgPerTonne,
            validFrom: wasteFractionEmissionFactor.validFrom,
            validTo: wasteFractionEmissionFactor.validTo,
          })
          .from(wasteFractionEmissionFactor)
          .where(and(eq(wasteFractionEmissionFactor.companyId, companyId), inArray(wasteFractionEmissionFactor.wasteFractionId, fractionIds)))
  const names = new Map(fractions.map((fraction) => [fraction.id, fraction.name]))
  const { lines, totals, warnings } = sustainabilityLines(stops, new Map(fractions.map((fraction) => [fraction.id, fraction.treatment as WasteTreatment | null])), factors)

  // The Customer's sites: where their collections were, and where their subscriptions in force over the window serve.
  const subscribed = await tx
    .select({ propertyId: subscription.propertyId, sharedCollectionPointId: subscription.sharedCollectionPointId })
    .from(subscription)
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .where(
      and(
        eq(subscription.companyId, companyId),
        inProjects(subscription.projectId, principal),
        eq(agreement.customerId, customerId),
        sql`${subscription.validFrom} <= ${window.to}::date and (${subscription.validTo} is null or ${subscription.validTo} > ${window.from}::date)`,
      ),
    )
  const propertyIds = unique([...mine, ...subscribed].map((site) => site.propertyId))
  const pointIds = unique([...mine, ...subscribed].map((site) => site.sharedCollectionPointId))
  const places = [
    ...(propertyIds.length === 0
      ? []
      : (
          await tx
            .select({ id: property.id, name: property.name, address: property.address })
            .from(property)
            .where(and(eq(property.companyId, companyId), inProjects(property.projectId, principal), inArray(property.id, propertyIds)))
        ).map((row) => ({ ...row, key: `property:${row.id}`, propertyId: row.id, sharedCollectionPointId: null }))),
    ...(pointIds.length === 0
      ? []
      : (
          await tx
            .select({ id: sharedCollectionPoint.id, name: sharedCollectionPoint.name, address: sharedCollectionPoint.address })
            .from(sharedCollectionPoint)
            .where(and(eq(sharedCollectionPoint.companyId, companyId), inProjects(sharedCollectionPoint.projectId, principal), inArray(sharedCollectionPoint.id, pointIds)))
        ).map((row) => ({ ...row, key: `point:${row.id}`, propertyId: null, sharedCollectionPointId: row.id }))),
  ]

  // The window's collections at those sites with no container: no agreement's, counted where they were.
  const unattributed =
    places.length === 0
      ? []
      : await tx
          .select({ propertyId: pickup.propertyId, sharedCollectionPointId: pickup.sharedCollectionPointId })
          .from(pickup)
          .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
          .where(and(collections, isNull(pickup.containerId), or(propertyIds.length === 0 ? undefined : inArray(pickup.propertyId, propertyIds), pointIds.length === 0 ? undefined : inArray(pickup.sharedCollectionPointId, pointIds))))
  const notAttributed = new Map<string, number>()
  for (const stop of unattributed) notAttributed.set(siteKeyOf(stop), (notAttributed.get(siteKeyOf(stop)) ?? 0) + 1)

  const sites = places
    .map((place) => ({
      key: place.key,
      propertyId: place.propertyId,
      sharedCollectionPointId: place.sharedCollectionPointId,
      name: place.name,
      address: place.address,
      lines: lines
        .filter((line) => line.siteKey === place.key)
        .map((line) => ({ wasteFractionId: line.wasteFractionId, name: names.get(line.wasteFractionId) ?? "", treatment: line.treatment, kg: line.kg, stops: line.stops, footprintGrams: line.footprintGrams, avoidedGrams: line.avoidedGrams }))
        .sort((a, b) => byName(a.name, b.name) || a.wasteFractionId.localeCompare(b.wasteFractionId)),
      notAttributedStops: notAttributed.get(place.key) ?? 0,
    }))
    // A site with nothing to report — subscribed, but no collection in the window — is left out; two of one name keep one order.
    .filter((site) => site.lines.length > 0 || site.notAttributedStops > 0)
    .sort((a, b) => byName(a.name, b.name) || a.key.localeCompare(b.key))
    .map(({ key: _key, ...site }) => site)
  return {
    window: { customerId, ...window },
    sites,
    totals,
    warnings: warnings.map((warning) => ({ ...warning, name: names.get(warning.wasteFractionId) ?? "" })),
  }
}

const SEPARATORS = { comma: ",", semicolon: ";" } as const

export function sustainabilityRoutes(guard: MiddlewareHandler<AuthEnv>) {
  const reportFor = (c: Context<AuthEnv>, query: SustainabilityReportQuery) => sustainabilityReport(c.get("tx"), c.get("principal"), query)
  return new Hono<AuthEnv>()
    .get(
      "/reports/sustainability",
      describeRoute({
        operationId: "getSustainabilityReport",
        summary: "A customer's sustainability report",
        description:
          "One Customer's collected waste over a window of operating days, both ends inclusive, in the projects the caller works in: a site at a time — the property or shared collection point its stops were at — and a waste fraction at a time, the kilograms by how each stop was weighed (`measured`, its own weight; `apportioned`, its share by container volume of its route's unloaded kilograms of the fraction less the measured stops'; `estimated`, by volume and density, empty until fraction densities are recorded) and the stops so counted, `unmeasured` ones counted and never weighed as zero; the fraction's treatment; and the CO₂e in whole grams its weighed kilograms emitted once treated and avoided, null where a stop had no factor in force on its day. A stop is the Customer's when its container served one of the Customer's agreements that day; a stop at one of their sites with no container is counted there as not attributed. The totals sum the lines; the recycling rate is the reused and recycled kilograms over every weighed one, a fraction with no treatment counting as not recycled. The warnings name a fraction with no treatment, and one without a factor. A regeneration's cancelled routes are left out.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The report.", SustainabilityReport),
          400: describeProblem(`The query does not parse: ${QUERY_REFUSED}.`),
          401: DESCRIBE_401,
          403: DESCRIBE_403,
        },
      }),
      guard,
      requireGrant(CUSTOMERS, "view"),
      requireGrant(STOPS, "view"),
      validate("query", SustainabilityReportQuery),
      async (c) => c.json(await reportFor(c, c.req.valid("query"))),
    )
    .get(
      "/reports/sustainability.csv",
      describeRoute({
        operationId: "getSustainabilityFile",
        summary: "A customer's sustainability report as a file",
        description:
          "The sustainability report as a plain CSV for the office to send the Customer: UTF-8 behind a byte-order mark, CRLF records, the columns `period_from`, `period_to`, `site`, `address`, `fraction`, `treatment`, `kg_measured`, `kg_apportioned`, `kg_estimated`, `stops_unmeasured`, `co2e_footprint_kg`, `co2e_avoided_kg` (kilograms with three decimals, blank where unknown) and `note`; a row per site and fraction, a row per site whose stops had no container, and a row per warning, its sentence in `note`. `separator=semicolon` writes it for a spreadsheet under a Danish locale. The query is the report's.",
        security: BEARER_SECURITY,
        responses: {
          200: { description: "The file, as an attachment.", content: { "text/csv": { schema: { type: "string" as const } } } },
          400: describeProblem(`The query does not parse: ${QUERY_REFUSED}, or \`separator\` is neither \`comma\` nor \`semicolon\`.`),
          401: DESCRIBE_401,
          403: DESCRIBE_403,
        },
      }),
      guard,
      requireGrant(CUSTOMERS, "view"),
      requireGrant(STOPS, "view"),
      validate("query", SustainabilityFileQuery),
      async (c) => {
        const { separator, ...query } = c.req.valid("query")
        const report = await reportFor(c, query)
        const file = {
          from: report.window.from,
          to: report.window.to,
          sites: report.sites.map((site) => ({ ...site, lines: site.lines.map((line) => ({ ...line, fractionName: line.name })) })),
          warnings: report.warnings.map((warning) => ({ kind: warning.kind, fractionName: warning.name })),
        }
        return c.body(sustainabilityCsv(file, SEPARATORS[separator]), 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="sustainability-${query.from}-${query.to}.csv"`,
        })
      },
    )
}
