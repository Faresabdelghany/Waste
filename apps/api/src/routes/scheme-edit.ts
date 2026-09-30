// A scheme edit that moves its collection groups (#205): the `collectionGroups`
// of `PATCH /route-schemes/:id`, the scheme's groups as the edit leaves them.
// Some edits pass through a state the rules refuse whatever order single
// requests take — a service day added to a validated scheme under the group
// that runs on it, a group split in two that share a vehicle, two manual
// groups trading containers on a shared day — so the scheme and its groups
// move in one request, and what the group routes hold one write at a time is
// held here once, over the merged scheme and the list together, before
// anything is written. routes/route-schemes.ts takes the scheme's row lock
// first and writes the scheme's own row; this module holds the list and
// writes the groups.
//
// An entry with an id restates that group of the scheme whole, as a create
// spells a group: a member it leaves unsaid is null, and a restated group
// given no position keeps its own. It keeps how it finds its stops, since a
// group that finds them the other way is another group. An entry without an
// id adds a group, after the last where it gives no position, and a group the
// list leaves out is parked, since there is no delete: it keeps its name and
// runs on nothing.
//
// The rules are the group routes' (routes/collection-groups.ts), in their
// words, at the entry's own path, in the order the API judges: the 400s —
// the entry's id, its source, its days within the service days the scheme is
// left with, the ids it names (`requireGroupReferences`, as a create holds
// its groups), no container on two entries a shared day, and the licence of
// a crew the entry moves — then the 409s: the fleet an entry names afresh by
// its status (#79: a new group's, a vehicle or driver a group moves to, and
// the stored fleet of a group the edit un-parks; a group left running as it
// ran asks nothing of its own), the structure over the groups as the edit
// leaves them, and the name a parked group keeps.
//
// The writes replace each restated group's sets whole, as the two PUTs do.
// The name the database holds unique is checked row by row and is not
// deferrable, so the groups that shift or trade names step aside first, all
// at once, under a name no group can hold, and then take their own.
import type { CollectionGroup, CollectionGroupEntry } from "@waste/contracts/route-schemes"
import { OUTSIDE_SERVICE_DAYS, withinServiceDays } from "@waste/contracts/route-schemes"
import { LABEL_MAX } from "@waste/contracts/text"
import type { Tx } from "@waste/db/client"
import { collectionGroup } from "@waste/db/schema/route-schemes"
import { groupRuns, isParked } from "@waste/domain/planning/checks"
import { and, eq, inArray, sql, type SQL } from "drizzle-orm"

import { newId } from "../ids"
import { invalidRequest, problem } from "../problem"
import type { Today } from "./fleet-lookups"
import type { Scope } from "./references"
import {
  clearGroupSets,
  groupNameTaken,
  mergeReferences,
  pickOf,
  referencesOf,
  requireFleetInService,
  requireGroupDriver,
  requireGroupReferences,
  requireNotPickedTwice,
  requireStructure,
  writeGroupSets,
} from "./scheme-groups"
import { stamp } from "./shared"

/** What an entry naming a group of another scheme, or none, is told at its id. */
const NOT_THIS_SCHEMES_GROUP = "Not a collection group of this scheme"

/** What an entry restating a group with the other source is told: `stopSource` is the group's for life, as the group patch holds it. */
const STOP_SOURCE_KEPT = "A collection group keeps how it finds its stops: one that finds them the other way is another group"

/** An entry with the stored group it restates, or none for a group the edit adds. */
type Restating = { entry: CollectionGroupEntry; group: CollectionGroup | undefined }

/** The edit, held: each entry with the group it restates, and the groups the list leaves out, which the write parks. */
export type GroupEdit = { entries: readonly Restating[]; leftOut: readonly CollectionGroup[] }

/** The scheme as the edit leaves it, and whether its start moved later, which moves the day its drivers are judged on (#101 §6.18). */
type EditedScheme = { status: string; serviceDays: readonly string[]; planningAreaId: string | null; validFrom: string; startsLater: boolean }

/** Whether the entry moves its group's vehicle or driver: an entry that adds a group moves both. */
const moves = ({ entry, group }: Restating, key: "vehicleId" | "driverId"): boolean => group === undefined || (entry[key] ?? null) !== group[key]

/**
 * Holds the entries against the scheme they leave behind and the groups it
 * stores, under the scheme's row lock the route has taken; a refusal is
 * thrown and nothing has been written. The answer is what `writeGroupEdit`
 * writes.
 */
export async function requireGroupEdit(
  tx: Tx,
  scope: Scope,
  scheme: EditedScheme,
  groups: readonly CollectionGroup[],
  entries: readonly CollectionGroupEntry[],
  today: Today,
): Promise<GroupEdit> {
  const stored = new Map(groups.map((group) => [group.id, group]))
  const edit = entries.map((entry, n): Restating => {
    const group = entry.id === undefined ? undefined : stored.get(entry.id)
    if (entry.id !== undefined && group === undefined) throw invalidRequest("body", [{ path: `collectionGroups.${n}.id`, message: NOT_THIS_SCHEMES_GROUP }])
    if (group !== undefined && group.stopSource !== entry.stopSource) throw invalidRequest("body", [{ path: `collectionGroups.${n}.stopSource`, message: STOP_SOURCE_KEPT }])
    if (!withinServiceDays(scheme.serviceDays, entry.days)) throw invalidRequest("body", [{ path: `collectionGroups.${n}.days`, message: OUTSIDE_SERVICE_DAYS }])
    return { entry, group }
  })
  const restated = new Set(edit.flatMap(({ group }) => (group === undefined ? [] : [group.id])))
  const leftOut = groups.filter((group) => !restated.has(group.id))

  const path = (n: number) => `collectionGroups.${n}.`
  const rows = await requireGroupReferences(tx, scope, mergeReferences(entries.map((entry, n) => referencesOf(entry, { prefix: path(n) }))))
  entries.forEach((entry, n) => requireNotPickedTwice(entries.slice(0, n).map(pickOf), pickOf(entry), (m) => `${path(n)}containerIds.${m}`))
  // The licence, as a group's patch judges it: a crew the entry moves at its driver, and a crew that stays where the start moves later at the bound that moved.
  for (const [n, restating] of edit.entries()) {
    const crewMoved = moves(restating, "vehicleId") || moves(restating, "driverId")
    if (crewMoved || scheme.startsLater) await requireGroupDriver(tx, scope, scheme, restating.entry, { path: crewMoved ? `${path(n)}driverId` : "validFrom", rows, today })
  }

  const afresh = edit.map((restating, n) => {
    const { entry, group } = restating
    const unparking = group !== undefined && isParked(group.days) && groupRuns(entry)
    const named = (key: "vehicleId" | "driverId") => (unparking || moves(restating, key) ? entry[key] : null)
    return referencesOf({ vehicleId: named("vehicleId"), driverId: named("driverId") }, { prefix: path(n) })
  })
  requireFleetInService(mergeReferences(afresh), rows)
  await requireStructure(tx, scope, scheme, [...entries, ...leftOut.map((group) => ({ ...group, days: [] }))])
  // The entries' names are one each (the contracts), so what can clash is the name a group the list leaves out keeps, parked.
  const kept = new Set(leftOut.map((group) => group.name))
  const clash = entries.find((entry) => kept.has(entry.name))
  if (clash !== undefined) throw problem(409, { detail: groupNameTaken(clash.name) })
  return { entries: edit, leftOut }
}

/** An entry's row as it writes it: the group whole, what it leaves unsaid null. */
const rowOf = (entry: CollectionGroupEntry) => ({
  name: entry.name,
  days: entry.days,
  ruleVehicleTypeId: entry.rule?.vehicleTypeId ?? null,
  serviceProviderId: entry.serviceProviderId ?? null,
  vehicleId: entry.vehicleId ?? null,
  driverId: entry.driverId ?? null,
})

/**
 * Writes a held edit inside the request's transaction: the restated groups'
 * rows, the left-out groups parked, the added groups after the last, and
 * every entry's sets replaced whole — one statement per table for the sets,
 * one per restated group for the rows.
 */
export async function writeGroupEdit(tx: Tx, scope: Scope, schemeId: string, { entries, leftOut }: GroupEdit): Promise<void> {
  const ofScheme = (...where: SQL[]) => and(eq(collectionGroup.companyId, scope.companyId), eq(collectionGroup.routeSchemeId, schemeId), ...where)
  const restated = entries.flatMap(({ entry, group }) => (group === undefined ? [] : [{ entry, group }]))

  // The step-aside. `collection_group_route_scheme_id_name_key` is not deferrable, so Postgres checks it row by row and a
  // chain or a swap of names ("Route 1" → "Route 2" while "Route 2" → "Route 3") would collide half-way through the
  // updates below. The groups being renamed first take, all at once, their id followed by LABEL_MAX dots: longer than
  // any label, so no group's name can equal it. Then each takes the name it is left with.
  const renaming = restated.filter(({ entry, group }) => entry.name !== group.name).map(({ group }) => group.id)
  if (renaming.length > 0) await tx.update(collectionGroup).set({ name: sql`${collectionGroup.id}::text || repeat('.', ${LABEL_MAX})` }).where(ofScheme(inArray(collectionGroup.id, renaming)))
  for (const { entry, group } of restated) {
    await tx
      .update(collectionGroup)
      .set({ ...rowOf(entry), ...(entry.position === undefined ? {} : { position: entry.position }), ...stamp() })
      .where(ofScheme(eq(collectionGroup.id, group.id)))
  }
  const parking = leftOut.filter(groupRuns).map((group) => group.id)
  if (parking.length > 0) await tx.update(collectionGroup).set({ days: [], ...stamp() }).where(ofScheme(inArray(collectionGroup.id, parking)))

  // After the last as the edit leaves them, in the body's order, as `POST …/collection-groups` appends one.
  let last = Math.max(0, ...restated.map(({ entry, group }) => entry.position ?? group.position), ...leftOut.map((group) => group.position))
  const added = entries.flatMap(({ entry, group }) =>
    group === undefined ? [{ entry, row: { id: newId(), ...scope, routeSchemeId: schemeId, stopSource: entry.stopSource, position: entry.position ?? (last += 1), ...rowOf(entry) } }] : [],
  )
  if (added.length > 0) await tx.insert(collectionGroup).values(added.map(({ row }) => row))

  await clearGroupSets(tx, scope.companyId, restated.map(({ group }) => group.id))
  await writeGroupSets(tx, scope, [
    ...restated.map(({ entry, group }) => ({ id: group.id, rule: entry.rule, containerIds: entry.containerIds })),
    ...added.map(({ entry, row }) => ({ id: row.id, rule: entry.rule, containerIds: entry.containerIds })),
  ])
}
