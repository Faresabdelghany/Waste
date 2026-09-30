// A scheme edit that moves its collection groups (#205): the `collectionGroups`
// of `PATCH /route-schemes/:id`, the scheme's groups as the edit leaves them.
// A service day added to a validated scheme under the group that runs on it
// passes through a state the rules refuse whatever order single requests
// take, and a group split in two that share a vehicle, or two manual groups
// trading containers on a shared day, gets through them only in a careful
// order, through states the edit never meant; so the scheme and its groups
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
// id adds a group — which the route asks `create` for, as `POST
// …/collection-groups` does — after the last the edit leaves where it gives
// no position, and a group the list leaves out is parked, since there is no
// delete: it keeps its name and runs on nothing, so no entry may take the
// name, and a parked group runs again by being restated.
//
// The rules are the group routes' (routes/collection-groups.ts), in their
// words, at the entry's own path, in the order the API judges: the 400s —
// the entry's id, its source, its days within the service days the scheme is
// left with, the ids it names (`requireGroupReferences`, as a create holds
// its groups), no container on two entries a shared day, and the licence of
// a crew the entry moves, or of every crew when the start moves later — the
// left-out groups' too, which they keep parked; then the 409s: the fleet an
// entry names afresh by its status (#79: a new group's, a vehicle or driver
// a group moves to, and the stored fleet of a group the edit un-parks; a
// group left running as it ran asks nothing of its own), the structure over
// the groups as the edit leaves them, in the order they will stand, and the
// name a parked group keeps.
//
// The writes leave a group restated as it stands alone, and replace a
// changed group's sets whole, as the two PUTs do. The name the database
// holds unique is checked row by row and is not deferrable, so the groups
// that shift or trade names step aside first, all at once, under a name no
// group can hold, and then take their own.
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

/** An entry with the stored group it restates, or none for a group the edit adds, and where the edit leaves it among the scheme's groups. */
type Restating = { entry: CollectionGroupEntry; group: CollectionGroup | undefined; position: number }

/** The edit, held: each entry with the group it restates, and the groups the list leaves out, which the write parks. */
export type GroupEdit = { entries: readonly Restating[]; leftOut: readonly CollectionGroup[] }

/** The scheme as the edit leaves it, and whether its start moved later, which moves the day its drivers are judged on (#101 §6.18). */
type EditedScheme = { status: string; serviceDays: readonly string[]; planningAreaId: string | null; validFrom: string; startsLater: boolean }

/** What an added group sorts as among ids: after every stored one, as the id the server mints it will be (UUIDv7, time-ordered). */
const ADDED = "~"

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
  const found = entries.map((entry, n) => {
    const group = entry.id === undefined ? undefined : stored.get(entry.id)
    if (entry.id !== undefined && group === undefined) throw invalidRequest("body", [{ path: `collectionGroups.${n}.id`, message: NOT_THIS_SCHEMES_GROUP }])
    if (group !== undefined && group.stopSource !== entry.stopSource) throw invalidRequest("body", [{ path: `collectionGroups.${n}.stopSource`, message: STOP_SOURCE_KEPT }])
    if (!withinServiceDays(scheme.serviceDays, entry.days)) throw invalidRequest("body", [{ path: `collectionGroups.${n}.days`, message: OUTSIDE_SERVICE_DAYS }])
    return { entry, group }
  })
  const restated = new Set(found.flatMap(({ group }) => (group === undefined ? [] : [group.id])))
  const leftOut = groups.filter((group) => !restated.has(group.id))
  // Where each group stands as the edit leaves it: an entry at its own position, a restated one given none where it stood, a left-out one where it stands, and an added one given none after the last of all of those, in the body's order, as `POST …/collection-groups` appends one.
  const placed = found.map(({ entry, group }) => entry.position ?? group?.position)
  let last = Math.max(0, ...placed.flatMap((position) => (position === undefined ? [] : [position])), ...leftOut.map((group) => group.position))
  const edit = found.map((restating, n): Restating => ({ ...restating, position: placed[n] ?? (last += 1) }))

  const path = (n: number) => `collectionGroups.${n}.`
  const rows = await requireGroupReferences(tx, scope, mergeReferences(entries.map((entry, n) => referencesOf(entry, { prefix: path(n) }))))
  entries.forEach((entry, n) => requireNotPickedTwice(entries.slice(0, n).map(pickOf), pickOf(entry), (m) => `${path(n)}containerIds.${m}`))
  // The licence, as a group's patch judges it: a crew the entry moves at its driver, and a crew that stays where the start moves later at the bound that moved.
  for (const [n, restating] of edit.entries()) {
    const crewMoved = moves(restating, "vehicleId") || moves(restating, "driverId")
    if (crewMoved || scheme.startsLater) await requireGroupDriver(tx, scope, scheme, restating.entry, { path: crewMoved ? `${path(n)}driverId` : "validFrom", rows, today })
  }
  // A group the list leaves out keeps its crew parked, and un-parking it asks no licence, so a later start judges it too, as the patch without the list judges every stored group.
  if (scheme.startsLater) for (const group of leftOut) await requireGroupDriver(tx, scope, scheme, group, { path: "validFrom", today })

  const afresh = edit.map((restating, n) => {
    const { entry, group } = restating
    const unparking = group !== undefined && isParked(group.days) && groupRuns(entry)
    const named = (key: "vehicleId" | "driverId") => (unparking || moves(restating, key) ? entry[key] : null)
    return referencesOf({ vehicleId: named("vehicleId"), driverId: named("driverId") }, { prefix: path(n) })
  })
  requireFleetInService(mergeReferences(afresh), rows)
  // The structure over the groups as the edit leaves them, in the order they stand — the order a read lists them in, position then id, an added group after the stored ones — since its sentences name groups in that order.
  const standing = [...edit.map(({ entry, group, position }) => ({ ...entry, position, id: group?.id })), ...leftOut.map((group) => ({ ...group, days: [] }))]
  await requireStructure(tx, scope, scheme, standing.sort((a, b) => a.position - b.position || ((a.id ?? ADDED) < (b.id ?? ADDED) ? -1 : 1)))
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

/** Two lists of ids alike, in the same order: a stop order, or a rule's set as it was written and is read. */
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, n) => id === b[n])

/** What writing the entry over its group would change: its row (the position the edit leaves it at included), its sets, or neither. */
function changesOf(entry: CollectionGroupEntry, group: CollectionGroup, position: number): { row: boolean; sets: boolean } {
  const row = rowOf(entry)
  return {
    row:
      row.name !== group.name ||
      !sameIds(row.days, group.days) ||
      position !== group.position ||
      row.ruleVehicleTypeId !== (group.rule?.vehicleTypeId ?? null) ||
      row.serviceProviderId !== group.serviceProviderId ||
      row.vehicleId !== group.vehicleId ||
      row.driverId !== group.driverId,
    sets:
      !sameIds(entry.rule?.wasteFractionIds ?? [], group.rule?.wasteFractionIds ?? []) ||
      !sameIds(entry.rule?.containerTypeIds ?? [], group.rule?.containerTypeIds ?? []) ||
      !sameIds(entry.containerIds ?? [], group.containerIds),
  }
}

/**
 * Writes a held edit inside the request's transaction: the rows of the
 * restated groups the edit changes, the left-out groups parked, the added
 * groups, and the sets of every group whose sets change, replaced whole — one
 * statement per table for the sets, one per changed group for the rows. A
 * group restated as it stands is not written, so its updatedAt stays; one
 * whose sets alone change is stamped, as a set's PUT stamps it.
 */
export async function writeGroupEdit(tx: Tx, scope: Scope, schemeId: string, { entries, leftOut }: GroupEdit): Promise<void> {
  const ofScheme = (...where: SQL[]) => and(eq(collectionGroup.companyId, scope.companyId), eq(collectionGroup.routeSchemeId, schemeId), ...where)
  const restated = entries.flatMap(({ entry, group, position }) => (group === undefined ? [] : [{ entry, group, position, changes: changesOf(entry, group, position) }]))
  const changed = restated.filter(({ changes }) => changes.row || changes.sets)

  // The step-aside. `collection_group_route_scheme_id_name_key` is not deferrable, so Postgres checks it row by row and a
  // chain or a swap of names ("Round 1" → "Round 2" while "Round 2" → "Round 3") would collide half-way through the
  // updates below. The groups being renamed first take, all at once, their id followed by LABEL_MAX dots: longer than
  // any label, so no group's name can equal it. Then each takes the name it is left with.
  const renaming = changed.filter(({ entry, group }) => entry.name !== group.name).map(({ group }) => group.id)
  if (renaming.length > 0) await tx.update(collectionGroup).set({ name: sql`${collectionGroup.id}::text || repeat('.', ${LABEL_MAX})` }).where(ofScheme(inArray(collectionGroup.id, renaming)))
  for (const { entry, group, position } of changed) {
    await tx
      .update(collectionGroup)
      .set({ ...rowOf(entry), position, ...stamp() })
      .where(ofScheme(eq(collectionGroup.id, group.id)))
  }
  const parking = leftOut.filter(groupRuns).map((group) => group.id)
  if (parking.length > 0) await tx.update(collectionGroup).set({ days: [], ...stamp() }).where(ofScheme(inArray(collectionGroup.id, parking)))

  const added = entries.flatMap(({ entry, group, position }) =>
    group === undefined ? [{ entry, row: { id: newId(), ...scope, routeSchemeId: schemeId, stopSource: entry.stopSource, position, ...rowOf(entry) } }] : [],
  )
  if (added.length > 0) await tx.insert(collectionGroup).values(added.map(({ row }) => row))

  const resetting = changed.filter(({ changes }) => changes.sets)
  await clearGroupSets(tx, scope.companyId, resetting.map(({ group }) => group.id))
  await writeGroupSets(tx, scope, [
    ...resetting.map(({ entry, group }) => ({ id: group.id, rule: entry.rule, containerIds: entry.containerIds })),
    ...added.map(({ entry, row }) => ({ id: row.id, rule: entry.rule, containerIds: entry.containerIds })),
  ])
}
