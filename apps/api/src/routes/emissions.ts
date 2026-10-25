// The fleet's emissions report (M10 of #293): `GET /reports/emissions`, what
// the routes operating in a window planned to emit, measured by
// @waste/domain/resources/emissions. Like the other reports (reports.ts) it
// stores nothing and is read under two grants, both `view`: Improve's
// Performance, where the Dashboard reads it, and the routes' module, whose
// rows it measures. Every statement carries the tenant and `inProjects` on
// the route it starts from; a `projectId` the caller does not work in is a
// 400 on the query.
//
// A route is measured once, whole, from its active Plan's distance, its
// planned vehicle's fuel and type, its type's consumption of that fuel and
// the factor in force on its operating date — the day it drives — and is
// otherwise unmeasured by its first gap, counted and never summed as zero. A
// cancelled route never drove and is left out, a regeneration's
// cancellations with it. The totals by vehicle and by project are the routes'
// figures summed; the totals by fraction share each route's grams over its
// stops' fractions by count (`splitByStops`), the stops a dispatcher or a
// regeneration withdrew left out, an approximation the wire names. A route
// whose active Plan is the optimiser's is counted in the saving against the
// baseline it was optimised from: the latest measured one made no later than
// it. The window is at most a year, so its routes are
// read as rows and measured here, a handful of columns each, while the stops
// are counted by route and fraction in the statement.
import { EmissionsReport, EmissionsReportQuery, type EmissionGap } from "@waste/contracts/emissions"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { fuelEmissionFactor, vehicleTypeConsumption } from "@waste/db/schema/emissions"
import { pickup, route } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { plan } from "@waste/db/schema/routing"
import type { PickupReason, PickupStatus } from "@waste/domain/execution/vocabulary"
import { pickupStanding } from "@waste/domain/insight/readings"
import { factorInForce, routeEmission, savingOf, splitByStops, type EmissionFactorPeriod } from "@waste/domain/resources/emissions"
import { EMISSION_GAPS, type FuelType } from "@waste/domain/resources/vocabulary"
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { describeProblem, validate } from "../problem"
import { describeJson } from "./shared"

const PERFORMANCE = "improve.performance"
const ROUTES = "route-studio.routes"

/** Names in one order wherever the API runs, as the other reports sort them. */
const byName = new Intl.Collator("en").compare

/** The routes the report measures: of the caller's projects (or the one asked), operating in the window, never cancelled. */
function routesOf(principal: Principal, query: EmissionsReportQuery): SQL {
  return and(
    eq(route.companyId, principal.companyId),
    inProjects(route.projectId, principal),
    query.projectId === undefined ? undefined : eq(route.projectId, query.projectId),
    sql`${route.operatingDate} between ${query.from}::date and ${query.to}::date`,
    ne(route.status, "cancelled"),
  ) as SQL
}

/** A measured group's running total. */
type Measured = { routes: number; metres: number; grams: number }
const nothingMeasured = (): Measured => ({ routes: 0, metres: 0, grams: 0 })
const add = (tally: Measured, metres: number, grams: number) => {
  tally.routes += 1
  tally.metres += metres
  tally.grams += grams
}

async function emissionsReport(tx: Tx, principal: Principal, query: EmissionsReportQuery): Promise<EmissionsReport> {
  // Four reads none of which waits on another: the routes with their active Plans and vehicles, the consumptions, the factors holding any day of the window, and the stops by route and fraction.
  const [routes, consumptions, factors, stopRows] = await Promise.all([
    tx
      .select({
        id: route.id,
        projectId: route.projectId,
        operatingDate: route.operatingDate,
        vehicleId: route.plannedVehicleId,
        planId: plan.id,
        planCreatedAt: plan.createdAt,
        solver: plan.solver,
        metres: plan.distanceMetres,
        fuel: vehicle.fuel,
        vehicleTypeId: vehicle.vehicleTypeId,
        callsign: vehicle.callsign,
      })
      .from(route)
      .leftJoin(plan, and(eq(plan.companyId, route.companyId), eq(plan.id, route.activePlanId)))
      .leftJoin(vehicle, and(eq(vehicle.companyId, route.companyId), eq(vehicle.id, route.plannedVehicleId)))
      .where(routesOf(principal, query)),
    tx
      .select({ vehicleTypeId: vehicleTypeConsumption.vehicleTypeId, fuel: vehicleTypeConsumption.fuel, milliUnitsPerKm: vehicleTypeConsumption.milliUnitsPerKm })
      .from(vehicleTypeConsumption)
      .where(eq(vehicleTypeConsumption.companyId, principal.companyId)),
    tx
      .select({ fuel: fuelEmissionFactor.fuel, gramsPerUnit: fuelEmissionFactor.gramsPerUnit, validFrom: fuelEmissionFactor.validFrom, validTo: fuelEmissionFactor.validTo })
      .from(fuelEmissionFactor)
      .where(and(eq(fuelEmissionFactor.companyId, principal.companyId), lte(fuelEmissionFactor.validFrom, query.to), or(isNull(fuelEmissionFactor.validTo), sql`${fuelEmissionFactor.validTo} > ${query.from}::date`))),
    // In a fixed order, so a route's fractions are always named in it and a tie in the split always goes the same way.
    tx
      .select({ routeId: pickup.routeId, wasteFractionId: pickup.wasteFractionId, status: pickup.status, reason: pickup.reason, stops: count() })
      .from(pickup)
      .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
      .where(and(eq(pickup.companyId, principal.companyId), routesOf(principal, query)))
      .groupBy(pickup.routeId, pickup.wasteFractionId, pickup.status, pickup.reason)
      .orderBy(asc(pickup.routeId), asc(pickup.wasteFractionId), asc(pickup.status), asc(pickup.reason)),
  ])
  const consumptionOf = new Map(consumptions.map((row) => [`${row.vehicleTypeId}|${row.fuel}`, row.milliUnitsPerKm]))
  const periods: EmissionFactorPeriod[] = factors.map((row) => ({ ...row, fuel: row.fuel as FuelType }))

  const stopsOf = new Map<string, Map<string | null, number>>()
  for (const row of stopRows) {
    if (pickupStanding(row.status as PickupStatus, row.reason as PickupReason | null) === "withdrawn") continue
    const fractions = stopsOf.get(row.routeId) ?? new Map<string | null, number>()
    fractions.set(row.wasteFractionId, (fractions.get(row.wasteFractionId) ?? 0) + row.stops)
    stopsOf.set(row.routeId, fractions)
  }

  // Each route measured once, before anything is summed: the baselines are read for the measured optimised routes alone.
  const measuredRoutes = routes.map((row) => {
    const fuel = row.fuel as FuelType | null
    const consumption = row.vehicleTypeId === null || fuel === null ? null : (consumptionOf.get(`${row.vehicleTypeId}|${fuel}`) ?? null)
    const factor = fuel === null ? null : factorInForce(periods, fuel, row.operatingDate)
    return { row, fuel, consumption, factor, measured: routeEmission({ plan: row.planId === null ? null : { metres: row.metres }, vehicleTypeId: row.vehicleTypeId, fuel, consumption, factor }) }
  })
  const optimised = measuredRoutes.filter((entry) => entry.measured.measured && entry.row.solver === "optimiser").map((entry) => entry.row.id)
  // The baseline the active Plan was optimised against: the route's latest measured baseline made no later than it, never one made since over other stops.
  const baselines = new Map<string, number>()
  if (optimised.length > 0) {
    const activeMadeAt = new Map(measuredRoutes.map((entry) => [entry.row.id, entry.row.planCreatedAt]))
    const rows = await tx
      .select({ routeId: plan.routeId, metres: plan.distanceMetres, createdAt: plan.createdAt })
      .from(plan)
      .where(and(eq(plan.companyId, principal.companyId), inArray(plan.routeId, optimised), eq(plan.solver, "baseline"), eq(plan.status, "ready"), isNotNull(plan.distanceMetres)))
      .orderBy(asc(plan.routeId), desc(plan.createdAt), desc(plan.id))
    for (const row of rows) {
      const madeAt = activeMadeAt.get(row.routeId)
      if (baselines.has(row.routeId) || row.metres === null || madeAt == null || row.createdAt > madeAt) continue
      baselines.set(row.routeId, row.metres)
    }
  }

  const planned = nothingMeasured()
  const gaps = new Map<EmissionGap, number>()
  const vehicles = new Map<string, Measured & { callsign: string | null; fuel: FuelType }>()
  const projects = new Map<string, Measured>()
  const fractions = new Map<string | null, number>()
  const saving = { routes: 0, metres: 0, grams: 0 }
  for (const { row, fuel, consumption, factor, measured } of measuredRoutes) {
    if (!measured.measured) {
      gaps.set(measured.gap, (gaps.get(measured.gap) ?? 0) + 1)
      continue
    }
    add(planned, measured.metres, measured.grams)
    // A measured route has a vehicle with a fuel, its consumption and its factor.
    const vehicleId = row.vehicleId as string
    const byVehicle = vehicles.get(vehicleId) ?? { ...nothingMeasured(), callsign: row.callsign, fuel: fuel as FuelType }
    add(byVehicle, measured.metres, measured.grams)
    vehicles.set(vehicleId, byVehicle)
    const byProject = projects.get(row.projectId) ?? nothingMeasured()
    add(byProject, measured.metres, measured.grams)
    projects.set(row.projectId, byProject)
    const split = splitByStops(measured.grams, stopsOf.get(row.id) ?? new Map())
    if (split.size === 0) fractions.set(null, (fractions.get(null) ?? 0) + measured.grams)
    for (const [fractionId, grams] of split) fractions.set(fractionId, (fractions.get(fractionId) ?? 0) + grams)
    const saved = savingOf({ solver: row.solver ?? "", metres: measured.metres }, baselines.get(row.id) ?? null, consumption as number, factor as number)
    if (saved !== null) {
      saving.routes += 1
      saving.metres += saved.metres
      saving.grams += saved.grams
    }
  }

  const fractionIds = [...fractions.keys()].filter((id): id is string => id !== null)
  const [projectNames, fractionNames] = await Promise.all([
    projects.size === 0
      ? []
      : tx
          .select({ id: project.id, name: project.name })
          .from(project)
          .where(and(eq(project.companyId, principal.companyId), inArray(project.id, [...projects.keys()]))),
    fractionIds.length === 0
      ? []
      : tx
          .select({ id: wasteFraction.id, name: wasteFraction.name })
          .from(wasteFraction)
          .where(and(eq(wasteFraction.companyId, principal.companyId), inArray(wasteFraction.id, fractionIds))),
  ])
  const projectName = new Map(projectNames.map((row) => [row.id, row.name]))
  const fractionName = new Map(fractionNames.map((row) => [row.id, row.name]))

  return {
    window: { projectId: query.projectId ?? null, from: query.from, to: query.to },
    planned,
    actualGrams: null,
    unmeasured: EMISSION_GAPS.filter((gap) => gaps.has(gap)).map((gap) => ({ gap, routes: gaps.get(gap) ?? 0 })),
    byVehicle: [...vehicles]
      .map(([vehicleId, tally]) => ({ vehicleId, callsign: tally.callsign, fuel: tally.fuel, routes: tally.routes, metres: tally.metres, grams: tally.grams }))
      .sort((a, b) => byName(a.callsign ?? "", b.callsign ?? "") || a.vehicleId.localeCompare(b.vehicleId)),
    byProject: [...projects]
      .map(([projectId, tally]) => ({ projectId, name: projectName.get(projectId) ?? projectId, ...tally }))
      .sort((a, b) => byName(a.name, b.name)),
    byFraction: [...fractions]
      .map(([wasteFractionId, grams]) => ({ wasteFractionId, name: wasteFractionId === null ? null : (fractionName.get(wasteFractionId) ?? null), grams }))
      // A route with no counted stop last, beneath the named fractions.
      .sort((a, b) => (a.wasteFractionId === null ? 1 : 0) - (b.wasteFractionId === null ? 1 : 0) || byName(a.name ?? "", b.name ?? "")),
    saving,
  }
}

export function emissionReportRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>().get(
    "/reports/emissions",
    describeRoute({
      operationId: "getEmissionsReport",
      summary: "The fleet's planned emissions",
      description:
        "What the routes operating from `from` to `to` (both inclusive, at most 366 days, from 2000-01-01 on) planned to emit, in grams of CO₂e (M10 of #293). Each route not cancelled is measured once, whole, from its active Plan's distance, its planned vehicle's fuel and vehicle type, the type's consumption of that fuel, and the fuel's emission factor in force on its operating date. A route missing any of them is unmeasured, counted in `unmeasured` by its first gap — no Plan, a Plan not yet measured, no vehicle, a vehicle with no fuel, no consumption for its type and fuel, no factor in force — and never summed as zero. `byVehicle` and `byProject` sum the routes' own figures; `byFraction` is split by stops: each route's grams shared over its stops' fractions by count, the withdrawn stops left out, an approximation, with a null fraction for routes with no counted stop. `saving` is the optimiser's: the routes whose active Plan is its own, against the baseline it was optimised from — the latest measured baseline made no later than it — the baseline less the active Plan, negative where it drove further. `actualGrams`, from what the routes drove, is null until the sessions record a distance. `projectId` narrows the report to one of the caller's projects; absent it spans every project they work in. The query is strict.",
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The window's planned emissions.", EmissionsReport),
        400: describeProblem("A parameter is one the report does not read, `from` or `to` is missing, not a day or before 2000-01-01, the window runs backwards or is longer than 366 days, or `projectId` is not a project this account works in."),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${PERFORMANCE}\` and \`view\` on \`${ROUTES}\`, the rows this report measures.`),
      },
    }),
    guard,
    requireGrant(PERFORMANCE, "view"),
    requireGrant(ROUTES, "view"),
    validate("query", EmissionsReportQuery),
    async (c) => {
      const query = c.req.valid("query")
      const principal = c.get("principal")
      if (query.projectId !== undefined) requireProject(principal, query.projectId, "projectId", "query")
      return c.json(await emissionsReport(c.get("tx"), principal, query))
    },
  )
}
