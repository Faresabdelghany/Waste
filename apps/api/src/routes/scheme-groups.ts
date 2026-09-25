// What the two Planning route modules share (Issue #97, ADR-0002): a Route
// Scheme on the wire carries its Collection Groups, and a group carries its
// Stop Matching Rule or its picked containers, so reading a scheme, reading a
// group and answering a write all assemble the same shape from the same five
// tables. The mechanics are here once and routes/route-schemes.ts and
// routes/collection-groups.ts each say only which route does what.
//
// A page of schemes costs five statements, never five per scheme: the groups
// of every scheme on the page in one query, grouped by scheme, and their
// three sets — the fractions a rule matches, the container types it is
// restricted to, the containers a manual group picks — in one query each,
// grouped by group. A single read and the answer to a write go through the
// same assembly, so what a write answers is what the next read says. The two
// rule sets read in the order they were written (their ids are minted in body
// order, ADR-0004) and the picked containers in stop order (`position`).
//
// A body's references are held in one statement per set, the way
// routes/members.ts holds a membership list — routes/sets.ts is the two
// statements once, `eachPresent` for the check and `groupedBy` for the read,
// since the closing round of the #101 review: a create body may name two
// hundred containers across its groups and that is one `in (...)`, not two
// hundred round trips inside the request's transaction. The refusal is the
// lowest entry that is wrong, by the path the body spelled it at, and its
// sentence is routes/references.ts's — the singular check is asked to refuse
// the one entry the plural lookup found missing, so a body naming one bad id
// and a body naming one among two hundred are told the same thing. The vehicle
// type a rule asks for is one of those references since Resources (Issue
// #101): a row of the company's `vehicle_type`, where 0006 had a token.
//
// Resources also gave the group a vehicle and a driver and the scheme a depot
// and an unloading station (migration 0007), and #101's slice 6 the rules
// that hold them. A group's `vehicleId` is a `powered-vehicle` of the scheme's
// project and its `driverId` a driver of it — two more sets of
// `requireGroupReferences`, held like the others, their sentences spelled in
// routes/references.ts — and, since the review round (#79's rule: a status
// gates a new reference and never an existing one), a vehicle named afresh
// is not retired and a driver named afresh is active (routes/statuses.ts),
// where a group whose vehicle later retires is not refused on an unrelated
// patch. The plural lookup reads those two sets as whole rows and hands them
// back, since what a body names is what the next rule reads: a group naming
// both names a driver who may take that vehicle, and `requireGroupDriver` is
// the licence rule of @waste/domain/resources/licence over those rows,
// judged on the day the scheme's period starts or today on the project's
// clock, whichever is later (#101 §6.18) — today being the app's injected
// `now` rendered in `project.timezone`, read once per request through
// `projectToday` and only when a group asks — a 400 at `driverId` in the
// words an allocation refuses with, whatever the scheme's status. And on a
// `validated` scheme no vehicle or driver is on two groups that run on a
// shared day, which joined the domain's structural rules and so
// `requireStructure`, which runs the rules over ids and reads the callsigns
// and names the sentences spell only once an issue exists. The scheme's depot
// and station are held by routes/route-schemes.ts, and the fleet's own routes
// count what still names a vehicle or a driver through `groupsInForceNaming`
// before taking it out of service.
//
// The two rules a scheme is held to across its groups are the domain's
// (@waste/domain/planning/checks): the structural rules of a validated scheme,
// answered as a 409 listing every sentence, and "no container on two groups
// the same day", a 400 at the entry. Both are applied here to the shapes the
// routes hand in, under the scheme's row lock the routes take first.
import type { CollectionGroup, RouteScheme, StopMatchingRule } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { project, serviceProvider } from "@waste/db/schema/organisation"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import {
  alreadyPicked,
  containerPickedTwice,
  groupDriverIssue,
  schemeLicenceDay,
  schemeStructureIssues,
  type ContainerPick,
  type GroupStructure,
  type NamedResource,
} from "@waste/domain/planning/checks"
import type { HolidayPolicy, RecurrenceFrequency, RouteSchemeStatus, SchemeEditPolicy, ServiceDay, ServiceType, StopSource, WeekRotation } from "@waste/domain/planning/vocabulary"
import { and, asc, eq, exists, inArray, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { newId } from "../ids"
import { invalidRequest, problem } from "../problem"
import { dayInTimezone } from "./days"
import { driverColumns, findDriver, findVehicle, projectTimezone, vehicleColumns, vehicleLabel, type DriverRow, type VehicleRow } from "./fleet-lookups"
import {
  requireContainer,
  requireContainerType,
  requireDriver,
  requireServiceProvider,
  requireVehicle,
  requireVehicleType,
  requireWasteFraction,
  type Scope,
} from "./references"
import { eachPresent, groupedBy, type Named } from "./sets"
import { stamp, stampsOf, timeOf } from "./shared"
import { refuseRetiredVehicle, refuseUnavailableDriver } from "./statuses"

/** What a route module takes beside the guard: the app's clock, which "today" on a project's clock is rendered from; a test pins it. */
export type ClockOptions = { now?: () => Date }

/** The grant every scheme and group route runs under: a group is a part of its scheme and not a surface of its own. */
export const MODULE = "route-studio.schemes"

/** `EXCLUDE USING gist (company_id, project_id, name, daterange)`: one scheme of a name in force at a time, so a new version follows the old. */
export const SCHEME_NAME_IN_FORCE = "route_scheme_no_overlap"
export const SCHEME_NAME_IN_FORCE_SENTENCE = "A route scheme of this name is already in force over that period"

/** `unique (company_id, route_scheme_id, name)`: a name is one group's inside a scheme. */
export const GROUP_NAME_TAKEN = "collection_group_route_scheme_id_name_key"
export const groupNameTaken = (name: string): string => `This scheme already has a collection group called ${JSON.stringify(name)}`

export const noSuchScheme = (id: string) => problem(404, { detail: `No route scheme ${id} in the projects this account works in` })
export const noSuchGroup = (id: string) => problem(404, { detail: `No collection group ${id} in the projects this account works in` })

export const schemeColumns = {
  id: routeScheme.id,
  projectId: routeScheme.projectId,
  name: routeScheme.name,
  planningAreaId: routeScheme.planningAreaId,
  serviceType: routeScheme.serviceType,
  frequency: routeScheme.frequency,
  serviceDays: routeScheme.serviceDays,
  weekRotation: routeScheme.weekRotation,
  plannedStartTime: routeScheme.plannedStartTime,
  holidayPolicy: routeScheme.holidayPolicy,
  editPolicy: routeScheme.editPolicy,
  planAhead: routeScheme.planAhead,
  status: routeScheme.status,
  depotId: routeScheme.depotId,
  unloadingStationId: routeScheme.unloadingStationId,
  validFrom: routeScheme.validFrom,
  validTo: routeScheme.validTo,
  createdAt: routeScheme.createdAt,
  updatedAt: routeScheme.updatedAt,
}

export type SchemeRow = Pick<typeof routeScheme.$inferSelect, keyof typeof schemeColumns>

export const groupColumns = {
  id: collectionGroup.id,
  projectId: collectionGroup.projectId,
  routeSchemeId: collectionGroup.routeSchemeId,
  name: collectionGroup.name,
  position: collectionGroup.position,
  days: collectionGroup.days,
  stopSource: collectionGroup.stopSource,
  ruleVehicleTypeId: collectionGroup.ruleVehicleTypeId,
  serviceProviderId: collectionGroup.serviceProviderId,
  vehicleId: collectionGroup.vehicleId,
  driverId: collectionGroup.driverId,
  createdAt: collectionGroup.createdAt,
  updatedAt: collectionGroup.updatedAt,
}

export type GroupRow = Pick<typeof collectionGroup.$inferSelect, keyof typeof groupColumns>

/** The row on the wire, with the groups read for it. The coded fields are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
export function schemeOf(row: SchemeRow, groups: CollectionGroup[]): RouteScheme {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    planningAreaId: row.planningAreaId,
    serviceType: row.serviceType as ServiceType,
    frequency: row.frequency as RecurrenceFrequency,
    serviceDays: row.serviceDays as ServiceDay[],
    weekRotation: row.weekRotation as WeekRotation | null,
    // Postgres spells the start with seconds; the wire does not (routes/shared.ts).
    plannedStartTime: row.plannedStartTime === null ? null : timeOf(row.plannedStartTime),
    holidayPolicy: row.holidayPolicy as HolidayPolicy,
    editPolicy: row.editPolicy as SchemeEditPolicy,
    planAhead: row.planAhead,
    status: row.status as RouteSchemeStatus,
    depotId: row.depotId,
    unloadingStationId: row.unloadingStationId,
    collectionGroups: groups,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** The three sets of one group, as read: each an ordered list of ids. */
type GroupSets = { wasteFractionIds: string[]; containerTypeIds: string[]; containerIds: string[] }

/** The row on the wire: a rule group carries its rule and no containers, a manual group its containers and no rule. */
function groupOf(row: GroupRow, sets: GroupSets): CollectionGroup {
  const stopSource = row.stopSource as StopSource
  return {
    id: row.id,
    routeSchemeId: row.routeSchemeId,
    name: row.name,
    position: row.position,
    days: row.days as ServiceDay[],
    stopSource,
    rule: stopSource === "rule" ? { wasteFractionIds: sets.wasteFractionIds, containerTypeIds: sets.containerTypeIds, vehicleTypeId: row.ruleVehicleTypeId } : null,
    containerIds: sets.containerIds,
    serviceProviderId: row.serviceProviderId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    ...stampsOf(row),
  }
}

/** A membership table of a group: the tenant, the group it belongs to, and the id it names. */
export type MembershipTable = PgTable & { companyId: PgColumn; collectionGroupId: PgColumn }

/** The ids one group's set names, in the order read; none for a group the set has no entry of. */
const idsOf = (grouped: ReadonlyMap<string, { id: string }[]>, groupId: string): string[] => grouped.get(groupId)?.map((entry) => entry.id) ?? []

/**
 * The groups of these rows on the wire, their three sets loaded in three
 * queries however many groups there are (`groupedBy`, routes/sets.ts); the
 * order is each set's own — the id (the order written) for a rule's two
 * sets, the position for a picked list.
 */
export async function assembleGroups(tx: Tx, companyId: string, rows: readonly GroupRow[]): Promise<CollectionGroup[]> {
  const ids = rows.map((row) => row.id)
  const [fractions, types, containers] = await Promise.all([
    groupedBy(tx, collectionGroupFraction, collectionGroupFraction.collectionGroupId, { id: collectionGroupFraction.wasteFractionId }, [collectionGroupFraction.id], companyId, ids),
    groupedBy(tx, collectionGroupContainerType, collectionGroupContainerType.collectionGroupId, { id: collectionGroupContainerType.containerTypeId }, [collectionGroupContainerType.id], companyId, ids),
    groupedBy(tx, collectionGroupContainer, collectionGroupContainer.collectionGroupId, { id: collectionGroupContainer.containerId }, [collectionGroupContainer.position], companyId, ids),
  ])
  return rows.map((row) => groupOf(row, { wasteFractionIds: idsOf(fractions, row.id), containerTypeIds: idsOf(types, row.id), containerIds: idsOf(containers, row.id) }))
}

/**
 * The groups of every scheme asked for, by scheme, in position order (ties by
 * id, the order they were made in): one query for the groups and three for
 * their sets, whatever the page holds. A scheme with no groups is absent from
 * the map, so a caller reads `?? []`.
 */
export async function groupsOf(tx: Tx, companyId: string, schemeIds: readonly string[]): Promise<Map<string, CollectionGroup[]>> {
  const byScheme = new Map<string, CollectionGroup[]>()
  if (schemeIds.length === 0) return byScheme
  const rows = await tx
    .select(groupColumns)
    .from(collectionGroup)
    .where(and(eq(collectionGroup.companyId, companyId), inArray(collectionGroup.routeSchemeId, [...schemeIds])))
    .orderBy(asc(collectionGroup.routeSchemeId), asc(collectionGroup.position), asc(collectionGroup.id))
  for (const group of await assembleGroups(tx, companyId, rows)) {
    const found = byScheme.get(group.routeSchemeId)
    if (found === undefined) byScheme.set(group.routeSchemeId, [group])
    else found.push(group)
  }
  return byScheme
}

/** One scheme on the wire, its groups read the way a page reads them. */
export async function schemeWithGroups(tx: Tx, companyId: string, row: SchemeRow): Promise<RouteScheme> {
  return schemeOf(row, (await groupsOf(tx, companyId, [row.id])).get(row.id) ?? [])
}

/** The rows of this company, in the projects the caller works in: what every scheme statement is bounded by. */
export const schemeScope = (principal: Principal): SQL | undefined =>
  and(eq(routeScheme.companyId, principal.companyId), inProjects(routeScheme.projectId, principal))

/** The same for a group, which carries the project its scheme is in. */
export const groupScope = (principal: Principal): SQL | undefined =>
  and(eq(collectionGroup.companyId, principal.companyId), inProjects(collectionGroup.projectId, principal))

/** One scheme of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findScheme(tx: Tx, principal: Principal, id: string): Promise<SchemeRow | undefined> {
  const [row] = await tx
    .select(schemeColumns)
    .from(routeScheme)
    .where(and(schemeScope(principal), eq(routeScheme.id, id)))
    .limit(1)
  return row
}

/** Every id a body names across its groups, by what it names: the rule's fractions, container types and vehicle type, the picked containers, the providers, the vehicles and the drivers. */
export type GroupReferences = {
  fractions: Named[]
  containerTypes: Named[]
  vehicleTypes: Named[]
  containers: Named[]
  providers: Named[]
  vehicles: Named[]
  drivers: Named[]
}

/** Where a body spells its references: `prefix` in front of every path, and `rulePrefix` in front of the rule's two sets — `${prefix}rule.` unless the body is the rule itself. */
export type ReferencePaths = { prefix?: string; rulePrefix?: string }

/**
 * The references of a group body, at the paths that body spells them: a
 * group create as it stands, a scheme create's group under
 * `collectionGroups.N.`, the rule PUT's body with `rulePrefix: ""` since the
 * body is the rule, and the containers PUT's with only `containerIds`.
 */
export function referencesOf(
  group: {
    rule?: StopMatchingRule | null
    containerIds?: readonly string[] | null
    serviceProviderId?: string | null
    vehicleId?: string | null
    driverId?: string | null
  },
  { prefix = "", rulePrefix = `${prefix}rule.` }: ReferencePaths = {},
): GroupReferences {
  return {
    fractions: (group.rule?.wasteFractionIds ?? []).map((id, m) => ({ path: `${rulePrefix}wasteFractionIds.${m}`, id })),
    containerTypes: (group.rule?.containerTypeIds ?? []).map((id, m) => ({ path: `${rulePrefix}containerTypeIds.${m}`, id })),
    vehicleTypes: group.rule?.vehicleTypeId == null ? [] : [{ path: `${rulePrefix}vehicleTypeId`, id: group.rule.vehicleTypeId }],
    containers: (group.containerIds ?? []).map((id, m) => ({ path: `${prefix}containerIds.${m}`, id })),
    providers: group.serviceProviderId == null ? [] : [{ path: `${prefix}serviceProviderId`, id: group.serviceProviderId }],
    vehicles: group.vehicleId == null ? [] : [{ path: `${prefix}vehicleId`, id: group.vehicleId }],
    drivers: group.driverId == null ? [] : [{ path: `${prefix}driverId`, id: group.driverId }],
  }
}

/** The references of several groups, concatenated. */
export function mergeReferences(all: readonly GroupReferences[]): GroupReferences {
  return {
    fractions: all.flatMap((refs) => refs.fractions),
    containerTypes: all.flatMap((refs) => refs.containerTypes),
    vehicleTypes: all.flatMap((refs) => refs.vehicleTypes),
    containers: all.flatMap((refs) => refs.containers),
    providers: all.flatMap((refs) => refs.providers),
    vehicles: all.flatMap((refs) => refs.vehicles),
    drivers: all.flatMap((refs) => refs.drivers),
  }
}

/** The fleet rows a body named, by id, as `requireGroupReferences` read them: what the licence rule reads next, so it does not read them again. */
export type FleetRows = { vehicles: ReadonlyMap<string, VehicleRow>; drivers: ReadonlyMap<string, DriverRow> }

/** No fleet read: what a caller hands in when the body named none, and the rule reads the stored rows itself. */
export const NO_FLEET: FleetRows = { vehicles: new Map(), drivers: new Map() }

/**
 * Every powered vehicle of the project a body names, read whole in one
 * statement: the first entry naming none is handed to the singular check
 * (a 400 in its words), and then, in body order, a vehicle named afresh is
 * held to its status — a retired one is refused at its entry
 * (routes/statuses.ts). The rows come back for the licence rule.
 */
async function vehiclesNamed(tx: Tx, scope: Scope, named: readonly Named[]): Promise<ReadonlyMap<string, VehicleRow>> {
  const ids = [...new Set(named.map((entry) => entry.id))]
  if (ids.length === 0) return NO_FLEET.vehicles
  const rows = await tx
    .select(vehicleColumns)
    .from(vehicle)
    .where(and(eq(vehicle.companyId, scope.companyId), eq(vehicle.projectId, scope.projectId), eq(vehicle.kind, "powered-vehicle"), inArray(vehicle.id, ids)))
  const found = new Map(rows.map((row) => [row.id, row as VehicleRow] as const))
  const missing = named.find((entry) => !found.has(entry.id))
  if (missing !== undefined) await requireVehicle(tx, scope, missing.id, { kind: "powered-vehicle", path: missing.path })
  for (const entry of named) {
    const row = found.get(entry.id)
    if (row !== undefined) refuseRetiredVehicle(row.status, vehicleLabel(row), entry.path)
  }
  return found
}

/** The same for the drivers a body names: the project's, and, named afresh, active. */
async function driversNamed(tx: Tx, scope: Scope, named: readonly Named[]): Promise<ReadonlyMap<string, DriverRow>> {
  const ids = [...new Set(named.map((entry) => entry.id))]
  if (ids.length === 0) return NO_FLEET.drivers
  const rows = await tx
    .select(driverColumns)
    .from(driver)
    .where(and(eq(driver.companyId, scope.companyId), eq(driver.projectId, scope.projectId), inArray(driver.id, ids)))
  const found = new Map(rows.map((row) => [row.id, row as DriverRow] as const))
  const missing = named.find((entry) => !found.has(entry.id))
  if (missing !== undefined) await requireDriver(tx, scope, missing.id, missing.path)
  for (const entry of named) {
    const row = found.get(entry.id)
    if (row !== undefined) refuseUnavailableDriver(row.status, row.name, entry.path)
  }
  return found
}

/**
 * Holds every id a body names to what its key allows, one statement per set
 * (`eachPresent`, routes/sets.ts, the missing entry handed to the singular
 * check of routes/references.ts for the family's sentence): a waste fraction,
 * a container type and a vehicle type are the company's, a container is the
 * scheme's project's, a Service Provider the company's, and, since Resources
 * (Issue #101), a vehicle is a powered vehicle of the scheme's project that is
 * not retired and a driver one of its drivers who is active. The first entry
 * that is wrong, set by set in the order a body reads, is a 400 at its path.
 * The vehicles and drivers are read whole and handed back, since the licence
 * rule reads the same rows next.
 */
export async function requireGroupReferences(tx: Tx, scope: Scope, refs: GroupReferences): Promise<FleetRows> {
  await eachPresent(tx, wasteFraction, wasteFraction.id, scope.companyId, refs.fractions, (entry) => requireWasteFraction(tx, scope.companyId, entry.id, entry.path))
  await eachPresent(tx, containerType, containerType.id, scope.companyId, refs.containerTypes, (entry) => requireContainerType(tx, scope.companyId, entry.id, entry.path))
  await eachPresent(tx, vehicleType, vehicleType.id, scope.companyId, refs.vehicleTypes, (entry) => requireVehicleType(tx, scope.companyId, entry.id, entry.path))
  await eachPresent(tx, container, container.id, scope.companyId, refs.containers, (entry) => requireContainer(tx, scope, entry.id, entry.path), eq(container.projectId, scope.projectId))
  await eachPresent(tx, serviceProvider, serviceProvider.id, scope.companyId, refs.providers, (entry) => requireServiceProvider(tx, scope.companyId, entry.id, entry.path))
  const vehicles = await vehiclesNamed(tx, scope, refs.vehicles)
  const drivers = await driversNamed(tx, scope, refs.drivers)
  return { vehicles, drivers }
}

/** Today on a project's clock, asked for at most once per request. */
export type Today = () => Promise<string>

/**
 * Today on the project's clock — the app's `now` rendered as a day in
 * `project.timezone` (routes/days.ts) — read once per request, however many
 * groups ask, and not at all when none does. The clock is the app's and never
 * `new Date()` here, so a test pins the day a driver is judged on.
 */
export function projectToday(tx: Tx, scope: Scope, now: () => Date): Today {
  let today: Promise<string> | undefined
  return () => (today ??= projectTimezone(tx, scope.companyId, scope.projectId).then((timezone) => dayInTimezone(now(), timezone)))
}

/**
 * A group naming both a vehicle and a driver names a driver who may take that
 * vehicle (Issue #101 §6.18): the licence rule, judged on the day the
 * scheme's period starts or today on the project's clock, whichever is later,
 * and refused as a 400 at `path` in the domain's sentence — the same words an
 * allocation refuses with. A group naming one or neither is asked nothing.
 * The rows are the ones `requireGroupReferences` read where the body named
 * them (`rows`); a stored one the body did not name — a patch moving the
 * driver alone, a scheme's start moving under its groups — is read here for
 * its class, label, licence and name, and its status is not asked, since it
 * is not a new reference.
 */
export async function requireGroupDriver(
  tx: Tx,
  scope: Scope,
  scheme: { validFrom: string },
  group: { vehicleId?: string | null; driverId?: string | null },
  { path = "driverId", rows = NO_FLEET, today }: { path?: string; rows?: FleetRows; today: Today },
): Promise<void> {
  if (group.vehicleId == null || group.driverId == null) return
  const truck = rows.vehicles.get(group.vehicleId) ?? (await findVehicle(tx, scope, group.vehicleId, "powered-vehicle", path.replace(/driverId$/, "vehicleId")))
  const who = rows.drivers.get(group.driverId) ?? (await findDriver(tx, scope, group.driverId, path))
  const judged = schemeLicenceDay(scheme.validFrom, await today())
  const issue = groupDriverIssue({ vehicle: { label: vehicleLabel(truck), requiredLicenceClass: truck.requiredLicenceClass }, driver: who }, judged)
  if (issue !== undefined) throw invalidRequest("body", [{ path, message: issue }])
}

/**
 * The collection groups of schemes in force today that name one vehicle or
 * one driver — `column` is `collection_group.vehicle_id` or `.driver_id` —
 * the count a fleet route refuses a retirement, an `inactive` or a
 * `suspended` with (routes/vehicles.ts, routes/drivers.ts, through
 * `refuseStranded`). Today is on each scheme's project's clock, read in the
 * statement (`now() at time zone project.timezone`), whatever the scheme's
 * status: a draft naming the vehicle is a plan that names it. A scheme that
 * has ended or has not begun counts for nothing; ending it or moving the
 * group's vehicle is the way to retire one. `company_id` and the row's id and
 * never `inProjects`, since a count that refuses a write must not be the one
 * statement that could miss a row.
 */
export function groupsInForceNaming(tx: Tx, column: typeof collectionGroup.vehicleId | typeof collectionGroup.driverId, companyId: string, id: string): SQL | undefined {
  const today = sql`(now() at time zone ${project.timezone})::date`
  const inForce = tx
    .select({ id: routeScheme.id })
    .from(routeScheme)
    .innerJoin(project, and(eq(project.companyId, routeScheme.companyId), eq(project.id, routeScheme.projectId)))
    .where(and(eq(routeScheme.companyId, collectionGroup.companyId), eq(routeScheme.id, collectionGroup.routeSchemeId), validOn(routeScheme, today)))
  return and(eq(collectionGroup.companyId, companyId), eq(column, id), exists(inForce))
}

/** What a group's sets are written from: the group's id, the rule it matches by or null, and the containers it picks in stop order. */
export type GroupSetsToWrite = { id: string; rule: StopMatchingRule | null | undefined; containerIds: readonly string[] | null | undefined }

/**
 * Writes the sets of one or more groups, one insert per table however many
 * groups there are: the rule's fractions and container types, and the picked
 * containers with positions 1..n in the body's order. Nothing to write is no
 * statement.
 */
export async function writeGroupSets(tx: Tx, scope: Scope, groups: readonly GroupSetsToWrite[]): Promise<void> {
  const tenant = { companyId: scope.companyId, projectId: scope.projectId }
  const fractions = groups.flatMap((group) => (group.rule?.wasteFractionIds ?? []).map((wasteFractionId) => ({ id: newId(), ...tenant, collectionGroupId: group.id, wasteFractionId })))
  const types = groups.flatMap((group) => (group.rule?.containerTypeIds ?? []).map((containerTypeId) => ({ id: newId(), ...tenant, collectionGroupId: group.id, containerTypeId })))
  const containers = groups.flatMap((group) =>
    (group.containerIds ?? []).map((containerId, index) => ({ id: newId(), ...tenant, collectionGroupId: group.id, containerId, position: index + 1 })),
  )
  if (fractions.length > 0) await tx.insert(collectionGroupFraction).values(fractions)
  if (types.length > 0) await tx.insert(collectionGroupContainerType).values(types)
  if (containers.length > 0) await tx.insert(collectionGroupContainer).values(containers)
}

/** A group's own rows of one membership table, gone: the first half of replacing a set whole. */
async function clearSet(tx: Tx, table: MembershipTable, group: { companyId: string; id: string }): Promise<void> {
  await tx.delete(table).where(and(eq(table.companyId, group.companyId), eq(table.collectionGroupId, group.id)))
}

/** What a group's set replacement carries: the whole rule, or the whole picked list in stop order. */
export type GroupSet = { rule: StopMatchingRule } | { containerIds: readonly string[] }

/**
 * `PUT …/stop-matching-rule` and `PUT …/containers`, once — the way
 * routes/members.ts replaces a membership, through a sibling because a rule
 * is three things over two tables and a column, and a list is positioned.
 * The group's own row goes first: the stamp, and for a rule the vehicle type,
 * under the caller's scope, so a group of another company or of a project
 * the account does not work in comes back as nothing and the route raises
 * its 404. Then the set's rows are deleted and the body's written, all in
 * the request's one transaction and under the scheme's row lock the route
 * has already taken, so a refused body leaves the group exactly as it was.
 */
export async function replaceGroupSet(tx: Tx, principal: Principal, id: string, set: GroupSet): Promise<GroupRow | undefined> {
  const [row] = await tx
    .update(collectionGroup)
    .set("rule" in set ? { ruleVehicleTypeId: set.rule.vehicleTypeId, ...stamp() } : stamp())
    .where(and(groupScope(principal), eq(collectionGroup.id, id)))
    .returning(groupColumns)
  if (row === undefined) return undefined
  const group = { companyId: principal.companyId, id }
  const scope: Scope = { companyId: principal.companyId, projectId: row.projectId }
  if ("rule" in set) {
    await clearSet(tx, collectionGroupFraction, group)
    await clearSet(tx, collectionGroupContainerType, group)
    await writeGroupSets(tx, scope, [{ id, rule: set.rule, containerIds: [] }])
  } else {
    await clearSet(tx, collectionGroupContainer, group)
    await writeGroupSets(tx, scope, [{ id, rule: null, containerIds: set.containerIds }])
  }
  return row
}

/** A group as the two domain rules see it, whether it is a stored group on the wire or a body about to be written. */
export type GroupShape = {
  name: string
  days: readonly string[]
  stopSource: string
  rule?: { wasteFractionIds: readonly string[] } | null
  containerIds?: readonly string[] | null
  vehicleId?: string | null
  driverId?: string | null
}

/** The labels the two-groups sentences spell a vehicle and a driver by, keyed by id. */
type FleetLabels = { vehicles: Map<string, string>; drivers: Map<string, string> }

const NO_LABELS: FleetLabels = { vehicles: new Map(), drivers: new Map() }

/** The callsign or plate of every vehicle and the name of every driver the groups name, in one query each; none when they name none. */
async function fleetLabelsOf(tx: Tx, companyId: string, groups: readonly GroupShape[]): Promise<FleetLabels> {
  const vehicleIds = [...new Set(groups.flatMap((group) => (group.vehicleId == null ? [] : [group.vehicleId])))]
  const driverIds = [...new Set(groups.flatMap((group) => (group.driverId == null ? [] : [group.driverId])))]
  const [vehicles, drivers] = await Promise.all([
    vehicleIds.length === 0
      ? []
      : tx
          .select({ id: vehicle.id, registration: vehicle.registration, callsign: vehicle.callsign })
          .from(vehicle)
          .where(and(eq(vehicle.companyId, companyId), inArray(vehicle.id, vehicleIds))),
    driverIds.length === 0 ? [] : tx.select({ id: driver.id, name: driver.name }).from(driver).where(and(eq(driver.companyId, companyId), inArray(driver.id, driverIds))),
  ])
  return {
    vehicles: new Map(vehicles.map((row) => [row.id, vehicleLabel(row)])),
    drivers: new Map(drivers.map((row) => [row.id, row.name])),
  }
}

/** The resource as the sentence names it; a row nobody labelled (it cannot happen: the key holds it) is named by its id rather than dropped. */
const named = (id: string | null | undefined, labels: Map<string, string>): NamedResource | null => (id == null ? null : { id, label: labels.get(id) ?? id })

const structureOf = (group: GroupShape, labels: FleetLabels): GroupStructure => ({
  name: group.name,
  days: group.days,
  stopSource: group.stopSource,
  fractionCount: group.rule?.wasteFractionIds.length ?? 0,
  containerCount: group.containerIds?.length ?? 0,
  vehicle: named(group.vehicleId, labels.vehicles),
  driver: named(group.driverId, labels.drivers),
})

/** A group's picks as the two-groups-one-day rule reads them. */
export const pickOf = (group: GroupShape): ContainerPick => ({ group: group.name, days: group.days, containerIds: group.containerIds ?? [] })

/**
 * The structural rules of a validated scheme, as the write would leave it: a
 * scheme that is or becomes `validated` and does not hold is refused with a
 * 409 listing every sentence, one after the other; a draft is not asked. The
 * rules compare ids, and the labels — a callsign, a person's name (Issue
 * #101) — only spell the sentences, so the rules run over the ids first and
 * the labels are read, two queries at most, only once an issue exists: a
 * scheme that stands costs no read, and a scheme that does not is told the
 * same sentences it would have been.
 */
export async function requireStructure(
  tx: Tx,
  companyId: string,
  scheme: { status: string; serviceDays: readonly string[]; planningAreaId: string | null },
  groups: readonly GroupShape[],
): Promise<void> {
  if (scheme.status !== "validated") return
  const structure = (labels: FleetLabels) => ({
    serviceDays: scheme.serviceDays,
    hasPlanningArea: scheme.planningAreaId !== null,
    collectionGroups: groups.map((group) => structureOf(group, labels)),
  })
  const issues = schemeStructureIssues(structure(NO_LABELS))
  if (issues.length === 0) return
  const named = groups.some((group) => group.vehicleId != null || group.driverId != null)
  const spelled = named ? schemeStructureIssues(structure(await fleetLabelsOf(tx, companyId, groups))) : issues
  throw problem(409, { detail: spelled.join(". ") })
}

/**
 * No container on two groups the same day: the first container of `picked`
 * that a group of `others` already picks on a day both run is a 400 at the
 * path the body spelled it, naming the group and the day.
 */
export function requireNotPickedTwice(others: readonly ContainerPick[], picked: Pick<ContainerPick, "days" | "containerIds">, pathOf: (index: number) => string): void {
  const found = containerPickedTwice(others, picked)
  if (found === undefined) return
  throw invalidRequest("body", [{ path: pathOf(found.index), message: alreadyPicked(found) }])
}
