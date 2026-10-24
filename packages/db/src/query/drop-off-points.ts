// What the public map of a project's Drop-off Points (Issue #293, M3) is
// drawn from: one read over a transaction, whatever role holds it — the
// public door's `wms_public` (ADR-0010) or, for M4's visits and the portal,
// the API's own role. Every statement names the company and the project, and
// the points are the active ones; a row the role may not see is simply
// absent, so the public role's grants and policies bound the answer, not
// this code.
//
// Each point comes with what `@waste/domain/resources/drop-off-points` reads
// its days from — its hours, its exceptions in the window, its flags — and
// the fractions it takes by name. The project's holidays in the window are
// read as generation reads them (`holidayListOf`), so a point closed on
// holidays closes on the days the collection calendar shifts around.
import type { DropOffOpening, OpeningException, WeeklyWindow } from "@waste/domain/resources/drop-off-points"
import { ON_THE_MAP } from "@waste/domain/resources/drop-off-points"
import { holidayListOf } from "@waste/domain/planning/generation"
import type { ServiceDay } from "@waste/domain/planning/vocabulary"
import type { DropOffPointKind } from "@waste/domain/resources/vocabulary"
import { NO_HOLIDAYS, type HolidayList } from "@waste/domain/route-schemes/occurrences"
import { and, asc, eq, exists, gte, inArray, lte, sql } from "drizzle-orm"

import type { Tx } from "../client"
import type { ScopedProject } from "./collection-days"
import { wasteFraction } from "../schema/catalogue"
import { collectionCalendarHoliday } from "../schema/collection-calendars"
import { dropOffPoint, dropOffPointException, dropOffPointFraction, dropOffPointHours } from "../schema/drop-off-points"
import { project } from "../schema/organisation"

/** A point as the map draws it, with what its days are read from. */
export type DropOffMapPoint = {
  id: string
  name: string
  kind: DropOffPointKind
  address: string
  location: { type: "Point"; coordinates: [number, number] }
  publicNote: string | null
  /** The fractions it takes, by name, in name order. */
  fractions: string[]
  opening: DropOffOpening
}

/** The map: the fraction asked for (`unknown` where the key names none of the company's), the active points, whether more stood than the map carries, and the project's holidays in the window where a point closes on them. */
export type DropOffMap = { fraction: { id: string; key: string; name: string } | null | "unknown"; points: DropOffMapPoint[]; truncated: boolean; holidays: HolidayList }

/** The most points one read of the map carries, by name: a city's bring banks, not a listing of every bin. A read past it says so (`truncated`). */
export const MAP_POINTS_MAX = 1000

/** `HH:MM:SS` as Postgres answers a `time`, `HH:MM` as the domain reads it. */
const clock = (time: string): string => time.slice(0, 5)

/** Rows grouped by their point, in the order read. */
function byPoint<Row extends { point: string }, Out>(source: readonly Row[], map: (row: Row) => Out): Map<string, Out[]> {
  const grouped = new Map<string, Out[]>()
  for (const row of source) {
    const found = grouped.get(row.point)
    if (found === undefined) grouped.set(row.point, [map(row)])
    else found.push(map(row))
  }
  return grouped
}

/** The project's active Drop-off Points over a window of days, each with its opening and fractions; those taking `fractionKey` alone where one is asked for. */
export async function readDropOffMap(tx: Tx, scope: ScopedProject, { fractionKey, from, to }: { fractionKey: string | undefined; from: string; to: string }): Promise<DropOffMap> {
  // The fraction first: a key naming none of the company's answers before anything else is read.
  let fraction: { id: string; key: string; name: string } | null = null
  if (fractionKey !== undefined) {
    const [found] = await tx
      .select({ id: wasteFraction.id, key: wasteFraction.key, name: wasteFraction.name })
      .from(wasteFraction)
      .where(and(eq(wasteFraction.companyId, scope.companyId), eq(wasteFraction.key, fractionKey)))
      .limit(1)
    if (found === undefined) return { fraction: "unknown", points: [], truncated: false, holidays: NO_HOLIDAYS }
    fraction = found
  }

  const rows = await tx
    .select({
      id: dropOffPoint.id,
      name: dropOffPoint.name,
      kind: dropOffPoint.kind,
      address: dropOffPoint.address,
      location: dropOffPoint.location,
      publicNote: dropOffPoint.publicNote,
      openAlways: dropOffPoint.openAlways,
      closedOnHolidays: dropOffPoint.closedOnHolidays,
    })
    .from(dropOffPoint)
    .where(
      and(
        eq(dropOffPoint.companyId, scope.companyId),
        eq(dropOffPoint.projectId, scope.projectId),
        eq(dropOffPoint.status, ON_THE_MAP),
        fraction === null
          ? undefined
          : exists(
              sql`(select 1 from ${dropOffPointFraction} where ${dropOffPointFraction.companyId} = ${scope.companyId} and ${dropOffPointFraction.dropOffPointId} = ${dropOffPoint.id} and ${dropOffPointFraction.wasteFractionId} = ${fraction.id})`,
            ),
      ),
    )
    .orderBy(asc(dropOffPoint.name), asc(dropOffPoint.id))
    .limit(MAP_POINTS_MAX + 1)
  const truncated = rows.length > MAP_POINTS_MAX
  const shown = rows.slice(0, MAP_POINTS_MAX)
  if (shown.length === 0) return { fraction, points: [], truncated, holidays: NO_HOLIDAYS }
  const ids = shown.map((row) => row.id)

  const [fractionRows, hourRows, exceptionRows] = [
    await tx
      .select({ point: dropOffPointFraction.dropOffPointId, name: wasteFraction.name })
      .from(dropOffPointFraction)
      .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, dropOffPointFraction.companyId), eq(wasteFraction.id, dropOffPointFraction.wasteFractionId)))
      .where(and(eq(dropOffPointFraction.companyId, scope.companyId), inArray(dropOffPointFraction.dropOffPointId, ids)))
      .orderBy(asc(wasteFraction.name)),
    await tx
      .select({ point: dropOffPointHours.dropOffPointId, weekday: dropOffPointHours.weekday, opensAt: dropOffPointHours.opensAt, closesAt: dropOffPointHours.closesAt })
      .from(dropOffPointHours)
      .where(and(eq(dropOffPointHours.companyId, scope.companyId), inArray(dropOffPointHours.dropOffPointId, ids))),
    await tx
      .select({ point: dropOffPointException.dropOffPointId, day: dropOffPointException.day, opensAt: dropOffPointException.opensAt, closesAt: dropOffPointException.closesAt, note: dropOffPointException.note })
      .from(dropOffPointException)
      .where(and(eq(dropOffPointException.companyId, scope.companyId), inArray(dropOffPointException.dropOffPointId, ids), gte(dropOffPointException.day, from), lte(dropOffPointException.day, to))),
  ]

  const fractions = byPoint(fractionRows, (row) => row.name)
  const hours = byPoint(hourRows, (row): WeeklyWindow => ({ weekday: row.weekday as ServiceDay, opensAt: clock(row.opensAt), closesAt: clock(row.closesAt) }))
  const exceptions = byPoint(
    exceptionRows,
    (row): OpeningException => ({ date: row.day, opensAt: row.opensAt === null ? null : clock(row.opensAt), closesAt: row.closesAt === null ? null : clock(row.closesAt), note: row.note }),
  )

  // The project's holidays in the window, read as generation reads them, and only where a point shown closes on them.
  let holidays: HolidayList = NO_HOLIDAYS
  if (shown.some((row) => row.closedOnHolidays)) {
    const [calendarRow] = await tx
      .select({ holidayList: project.holidayList })
      .from(project)
      .where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
      .limit(1)
    if (calendarRow?.holidayList != null) {
      const holidayRows = await tx
        .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
        .from(collectionCalendarHoliday)
        .where(and(eq(collectionCalendarHoliday.companyId, scope.companyId), eq(collectionCalendarHoliday.projectId, scope.projectId), gte(collectionCalendarHoliday.day, from), lte(collectionCalendarHoliday.day, to)))
      holidays = holidayListOf(holidayRows, calendarRow.holidayList)
    }
  }

  return {
    fraction,
    truncated,
    holidays,
    points: shown.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as DropOffPointKind,
      address: row.address,
      location: row.location as DropOffMapPoint["location"],
      publicNote: row.publicNote,
      fractions: fractions.get(row.id) ?? [],
      opening: { openAlways: row.openAlways, closedOnHolidays: row.closedOnHolidays, hours: hours.get(row.id) ?? [], exceptions: exceptions.get(row.id) ?? [] },
    })),
  }
}
