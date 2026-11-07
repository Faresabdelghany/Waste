// The held routes a change of holiday inputs re-decides (#226). A change of
// holiday inputs — the scheme's `holidayPolicy`, the project's `weekend` or
// whether it has a `holidayList`, a list's days — releases the held routes it
// re-decides (`holidayReleases` in the domain): one standing where the scheme
// put its collection, held for its start or crew, when the change moves that
// collection or skips it, and one the office moved when the change makes its
// day one the scheme moves collections off. The project's and the list's edits
// reach every held route of the project, fenced by the tenant and the project
// the edit changed rather than by the caller's projects, since the inputs are
// the project's whoever changes them; the scheme's reaches its own routes.
// Those two edits hold no scheme's lock, so a run already reading the route
// keeps the office's day once more, and the run after it moves it. No run is
// asked: the next run re-plans. The hold itself is the API's
// (`apps/api/src/routes/route-holds.ts`).
import { holidayReleases } from "@waste/domain/planning/generation"
import type { HolidayPolicy, SchemeCalendar } from "@waste/domain/planning/occurrences"
import { and, eq, inArray, isNotNull } from "drizzle-orm"

import type { Tx } from "../client"
import { readProjectCalendar, type Scope } from "../query/project-clock"
import { route } from "../schema/execution"
import { routeScheme } from "../schema/route-schemes"

/** A change of holiday inputs: the project's calendar before and after it, and the scheme's policy where the change is the scheme's. */
type HolidayChange = { before: SchemeCalendar; after: SchemeCalendar; policy?: { routeSchemeId: string; before: HolidayPolicy; after: HolidayPolicy } }

/** Releases, in the edit's transaction, the held routes of the project the change re-decides, each judged under its scheme's policy. */
async function releaseHolidayHolds(tx: Tx, scope: Scope, change: HolidayChange): Promise<void> {
  const held = await tx
    .select({ id: route.id, serviceDate: route.serviceDate, operatingDate: route.operatingDate, holidayPolicy: routeScheme.holidayPolicy })
    .from(route)
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .where(
      and(
        eq(route.companyId, scope.companyId),
        eq(route.projectId, scope.projectId),
        isNotNull(route.heldAt),
        change.policy === undefined ? undefined : eq(route.routeSchemeId, change.policy.routeSchemeId),
      ),
    )
  const released = held
    .filter((row) =>
      holidayReleases(
        row,
        { holidayPolicy: change.policy?.before ?? row.holidayPolicy, calendar: change.before },
        { holidayPolicy: change.policy?.after ?? row.holidayPolicy, calendar: change.after },
      ),
    )
    .map((row) => row.id)
  if (released.length === 0) return
  await tx
    .update(route)
    .set({ heldAt: null })
    .where(and(eq(route.companyId, scope.companyId), eq(route.projectId, scope.projectId), inArray(route.id, released)))
}

/**
 * Runs `write`, an edit of the calendars of `projectIds` — a project's weekend
 * or holiday list, a list's days — reading each calendar before and after it,
 * and releases in each project the held routes the change re-decides; what
 * `write` answers.
 */
export async function changeProjectCalendars<T>(tx: Tx, companyId: string, projectIds: readonly string[], write: () => Promise<T>): Promise<T> {
  const before: SchemeCalendar[] = []
  for (const projectId of projectIds) before.push(await readProjectCalendar(tx, { companyId, projectId }))
  const written = await write()
  for (const [n, projectId] of projectIds.entries()) {
    const scope = { companyId, projectId }
    await releaseHolidayHolds(tx, scope, { before: before[n]!, after: await readProjectCalendar(tx, scope) })
  }
  return written
}

/** A scheme's holiday policy changed: releases the scheme's held routes the new policy re-decides on the project's calendar. */
export async function releasePolicyHolds(tx: Tx, scope: Scope, policy: { routeSchemeId: string; before: HolidayPolicy; after: HolidayPolicy }): Promise<void> {
  const calendar = await readProjectCalendar(tx, scope)
  await releaseHolidayHolds(tx, scope, { before: calendar, after: calendar, policy })
}
