// A Route Scheme's Seasons (O17 of #290): the set read with the scheme and
// written whole with it. A create writes the body's seasons; a patch that
// carries `seasons` replaces the stored set — its rows gone, the body's
// written — under the scheme's row lock, which the patch already holds. The
// set's own rules (one name each, no day shared, a daily scheme none) are the
// contracts'; the route holds the last against the merged row, since a patch
// may carry half the pair. A season moves the dates the scheme collects on,
// as a change of frequency does, so it releases no hold (routes/route-holds.ts).
import type { SchemeSeason } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { routeSchemeSeason } from "@waste/db/schema/route-schemes"
import type { StoredSeason } from "@waste/domain/planning/generation"
import type { SeasonFrequency, WeekRotation } from "@waste/domain/planning/vocabulary"
import { and, asc, eq, inArray } from "drizzle-orm"

import { newId } from "../ids"
import type { Scope } from "./references"

/** Every season of the schemes, by scheme, each scheme's by the day it starts; a scheme with none is absent. */
export async function seasonsOf(tx: Tx, companyId: string, schemeIds: readonly string[]): Promise<Map<string, SchemeSeason[]>> {
  const byScheme = new Map<string, SchemeSeason[]>()
  if (schemeIds.length === 0) return byScheme
  const rows = await tx
    .select({
      routeSchemeId: routeSchemeSeason.routeSchemeId,
      name: routeSchemeSeason.name,
      startsOn: routeSchemeSeason.startsOn,
      endsOn: routeSchemeSeason.endsOn,
      frequency: routeSchemeSeason.frequency,
      weekRotation: routeSchemeSeason.weekRotation,
    })
    .from(routeSchemeSeason)
    .where(and(eq(routeSchemeSeason.companyId, companyId), inArray(routeSchemeSeason.routeSchemeId, [...schemeIds])))
    .orderBy(asc(routeSchemeSeason.routeSchemeId), asc(routeSchemeSeason.startsOn))
  for (const { routeSchemeId, ...row } of rows) {
    const season: SchemeSeason = { ...row, frequency: row.frequency as SeasonFrequency, weekRotation: row.weekRotation as WeekRotation | null }
    byScheme.set(routeSchemeId, [...(byScheme.get(routeSchemeId) ?? []), season])
  }
  return byScheme
}

/** One scheme's seasons as the domain reads them for its occurrences. */
export async function storedSeasonsOf(tx: Tx, companyId: string, schemeId: string): Promise<StoredSeason[]> {
  return (await seasonsOf(tx, companyId, [schemeId])).get(schemeId) ?? []
}

/** The scheme's seasons replaced whole by the body's: the stored rows gone, the body's written. The caller holds the scheme's row lock. */
export async function writeSeasons(tx: Tx, scope: Scope, schemeId: string, seasons: readonly SchemeSeason[], { replacing }: { replacing: boolean }): Promise<void> {
  if (replacing) await tx.delete(routeSchemeSeason).where(and(eq(routeSchemeSeason.companyId, scope.companyId), eq(routeSchemeSeason.routeSchemeId, schemeId)))
  if (seasons.length === 0) return
  await tx.insert(routeSchemeSeason).values(seasons.map((season) => ({ id: newId(), companyId: scope.companyId, projectId: scope.projectId, routeSchemeId: schemeId, ...season })))
}
