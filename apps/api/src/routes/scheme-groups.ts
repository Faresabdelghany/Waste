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
// routes/members.ts holds a membership list: a create body may name two
// hundred containers across its groups and that is one `in (...)`, not two
// hundred round trips inside the request's transaction. The refusal is the
// lowest entry that is wrong, by the path the body spelled it at, and its
// sentence is routes/references.ts's — the singular check is asked to refuse
// the one entry the plural lookup found missing, so a body naming one bad id
// and a body naming one among two hundred are told the same thing.
//
// The two rules a scheme is held to across its groups are the domain's
// (@waste/domain/planning/checks): the structural rules of a validated scheme,
// answered as a 409 listing every sentence, and "no container on two groups
// the same day", a 400 at the entry. Both are applied here to the shapes the
// routes hand in, under the scheme's row lock the routes take first.
import type { CollectionGroup, RouteScheme, StopMatchingRule } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { serviceProvider } from "@waste/db/schema/organisation"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import { alreadyPicked, containerPickedTwice, schemeStructureIssues, type ContainerPick, type GroupStructure } from "@waste/domain/planning/checks"
import type {
  HolidayPolicy,
  RecurrenceFrequency,
  RouteSchemeStatus,
  SchemeEditPolicy,
  ServiceDay,
  ServiceType,
  StopMatchVehicleType,
  StopSource,
  WeekRotation,
} from "@waste/domain/planning/vocabulary"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { newId } from "../ids"
import { invalidRequest, problem } from "../problem"
import { requireContainer, requireContainerType, requireServiceProvider, requireWasteFraction } from "./references"
import { stamp, stampsOf, timeOf, type TenantTable } from "./shared"

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
  ruleVehicleType: collectionGroup.ruleVehicleType,
  serviceProviderId: collectionGroup.serviceProviderId,
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
    collectionGroups: groups,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** The three sets of one group, as read: each an ordered list of ids. */
type GroupSets = { wasteFractionIds: string[]; containerTypeIds: string[]; containerIds: string[] }

const NO_SETS: GroupSets = { wasteFractionIds: [], containerTypeIds: [], containerIds: [] }

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
    rule:
      stopSource === "rule"
        ? { wasteFractionIds: sets.wasteFractionIds, containerTypeIds: sets.containerTypeIds, vehicleType: row.ruleVehicleType as StopMatchVehicleType | null }
        : null,
    containerIds: sets.containerIds,
    serviceProviderId: row.serviceProviderId,
    ...stampsOf(row),
  }
}

/** A membership table of a group: the tenant, the group it belongs to, and the id it names. */
export type MembershipTable = PgTable & { companyId: PgColumn; collectionGroupId: PgColumn }

/**
 * The entries of every group asked for, in one query, grouped by group; the
 * order is the caller's — the id (the order written) for a rule's sets, the
 * position for a picked list.
 */
async function membersOf(tx: Tx, table: MembershipTable, entry: PgColumn, order: PgColumn, companyId: string, groupIds: readonly string[]): Promise<Map<string, string[]>> {
  const byGroup = new Map<string, string[]>()
  if (groupIds.length === 0) return byGroup
  const rows = await tx
    .select({ group: table.collectionGroupId, entry })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.collectionGroupId, [...groupIds])))
    .orderBy(asc(order))
  // A bare `PgColumn` carries `data: unknown`, so the selection reads as unknown however plainly both are `uuid`.
  for (const row of rows as { group: string; entry: string }[]) {
    const found = byGroup.get(row.group)
    if (found === undefined) byGroup.set(row.group, [row.entry])
    else found.push(row.entry)
  }
  return byGroup
}

/** The groups of these rows on the wire, their three sets loaded in three queries however many groups there are. */
export async function assembleGroups(tx: Tx, companyId: string, rows: readonly GroupRow[]): Promise<CollectionGroup[]> {
  const ids = rows.map((row) => row.id)
  const [fractions, types, containers] = await Promise.all([
    membersOf(tx, collectionGroupFraction, collectionGroupFraction.wasteFractionId, collectionGroupFraction.id, companyId, ids),
    membersOf(tx, collectionGroupContainerType, collectionGroupContainerType.containerTypeId, collectionGroupContainerType.id, companyId, ids),
    membersOf(tx, collectionGroupContainer, collectionGroupContainer.containerId, collectionGroupContainer.position, companyId, ids),
  ])
  return rows.map((row) =>
    groupOf(row, {
      wasteFractionIds: fractions.get(row.id) ?? NO_SETS.wasteFractionIds,
      containerTypeIds: types.get(row.id) ?? NO_SETS.containerTypeIds,
      containerIds: containers.get(row.id) ?? NO_SETS.containerIds,
    }),
  )
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

/** One id a body names and where it names it, for the one lookup per set below. */
export type Named = { path: string; id: string }

/** Every id a body names across its groups, by what it names: the rule's fractions and container types, the picked containers, the providers. */
export type GroupReferences = {
  fractions: Named[]
  containerTypes: Named[]
  containers: Named[]
  providers: Named[]
}

/** What a body's checks are bounded by: the caller's company, and the project the scheme is in. */
export type Scope = { companyId: string; projectId: string }

/** Where a body spells its references: `prefix` in front of every path, and `rulePrefix` in front of the rule's two sets — `${prefix}rule.` unless the body is the rule itself. */
export type ReferencePaths = { prefix?: string; rulePrefix?: string }

/**
 * The references of a group body, at the paths that body spells them: a
 * group create as it stands, a scheme create's group under
 * `collectionGroups.N.`, the rule PUT's body with `rulePrefix: ""` since the
 * body is the rule, and the containers PUT's with only `containerIds`.
 */
export function referencesOf(
  group: { rule?: StopMatchingRule | null; containerIds?: readonly string[] | null; serviceProviderId?: string | null },
  { prefix = "", rulePrefix = `${prefix}rule.` }: ReferencePaths = {},
): GroupReferences {
  return {
    fractions: (group.rule?.wasteFractionIds ?? []).map((id, m) => ({ path: `${rulePrefix}wasteFractionIds.${m}`, id })),
    containerTypes: (group.rule?.containerTypeIds ?? []).map((id, m) => ({ path: `${rulePrefix}containerTypeIds.${m}`, id })),
    containers: (group.containerIds ?? []).map((id, m) => ({ path: `${prefix}containerIds.${m}`, id })),
    providers: group.serviceProviderId == null ? [] : [{ path: `${prefix}serviceProviderId`, id: group.serviceProviderId }],
  }
}

/** The references of several groups, concatenated. */
export function mergeReferences(all: readonly GroupReferences[]): GroupReferences {
  return {
    fractions: all.flatMap((refs) => refs.fractions),
    containerTypes: all.flatMap((refs) => refs.containerTypes),
    containers: all.flatMap((refs) => refs.containers),
    providers: all.flatMap((refs) => refs.providers),
  }
}

/**
 * The lowest entry whose id is not a row inside `within`, found in one
 * statement over every id named. The caller hands the one that is missing
 * to the singular check of routes/references.ts, which refuses it with the
 * family's sentence — so the plural and the singular refusal say the same
 * thing, and the one extra statement is spent on the failure path only.
 */
async function firstMissing(tx: Tx, table: TenantTable, within: SQL | undefined, named: readonly Named[]): Promise<Named | undefined> {
  const ids = [...new Set(named.map((entry) => entry.id))]
  if (ids.length === 0) return undefined
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(within, inArray(table.id, ids)))
  const found = new Set((rows as { id: string }[]).map((row) => row.id))
  return named.find((entry) => !found.has(entry.id))
}

/**
 * Holds every id a body names to what its key allows, one statement per set:
 * a waste fraction and a container type are the company's, a container is
 * the scheme's project's, a Service Provider the company's. The first entry
 * that is wrong, set by set in the order a body reads, is a 400 at its path.
 */
export async function requireGroupReferences(tx: Tx, scope: Scope, refs: GroupReferences): Promise<void> {
  const fraction = await firstMissing(tx, wasteFraction, eq(wasteFraction.companyId, scope.companyId), refs.fractions)
  if (fraction !== undefined) await requireWasteFraction(tx, scope.companyId, fraction.id, fraction.path)
  const type = await firstMissing(tx, containerType, eq(containerType.companyId, scope.companyId), refs.containerTypes)
  if (type !== undefined) await requireContainerType(tx, scope.companyId, type.id, type.path)
  const picked = await firstMissing(tx, container, and(eq(container.companyId, scope.companyId), eq(container.projectId, scope.projectId)), refs.containers)
  if (picked !== undefined) await requireContainer(tx, scope, picked.id, picked.path)
  const provider = await firstMissing(tx, serviceProvider, eq(serviceProvider.companyId, scope.companyId), refs.providers)
  if (provider !== undefined) await requireServiceProvider(tx, scope.companyId, provider.id, provider.path)
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
  const stamp = { companyId: scope.companyId, projectId: scope.projectId }
  const fractions = groups.flatMap((group) => (group.rule?.wasteFractionIds ?? []).map((wasteFractionId) => ({ id: newId(), ...stamp, collectionGroupId: group.id, wasteFractionId })))
  const types = groups.flatMap((group) => (group.rule?.containerTypeIds ?? []).map((containerTypeId) => ({ id: newId(), ...stamp, collectionGroupId: group.id, containerTypeId })))
  const containers = groups.flatMap((group) =>
    (group.containerIds ?? []).map((containerId, index) => ({ id: newId(), ...stamp, collectionGroupId: group.id, containerId, position: index + 1 })),
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
    .set("rule" in set ? { ruleVehicleType: set.rule.vehicleType, ...stamp() } : stamp())
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
}

const structureOf = (group: GroupShape): GroupStructure => ({
  name: group.name,
  days: group.days,
  stopSource: group.stopSource,
  fractionCount: group.rule?.wasteFractionIds.length ?? 0,
  containerCount: group.containerIds?.length ?? 0,
})

/** A group's picks as the two-groups-one-day rule reads them. */
export const pickOf = (group: GroupShape): ContainerPick => ({ group: group.name, days: group.days, containerIds: group.containerIds ?? [] })

/**
 * The structural rules of a validated scheme, as the write would leave it: a
 * scheme that is or becomes `validated` and does not hold is refused with a
 * 409 listing every sentence, one after the other; a draft is not asked.
 */
export function requireStructure(scheme: { status: string; serviceDays: readonly string[]; planningAreaId: string | null }, groups: readonly GroupShape[]): void {
  if (scheme.status !== "validated") return
  const issues = schemeStructureIssues({
    serviceDays: scheme.serviceDays,
    hasPlanningArea: scheme.planningAreaId !== null,
    collectionGroups: groups.map(structureOf),
  })
  if (issues.length > 0) throw problem(409, { detail: issues.join(". ") })
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
