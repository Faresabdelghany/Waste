// What the route-scheme and collection-group suites need of Planning beyond
// their own routes (Issue #97, slice 4): a planning area per project, each
// project's working week and holiday list, and a collection calendar with the
// holidays the occurrence read is proved against. The rows are written
// directly through `tx` as `wms_api` inside `withCompany`, the way tenant.ts
// seeds its company — the suites prove the scheme routes, not the area and
// calendar ones — and `dropTenant` drops them with the rest of the company.
//
// The three projects say three different things about a working week:
// Copenhagen Central rests Saturday–Sunday on the Danish list, Harbor
// Commercial has calendar rows but no list, so its holidays are read by
// nobody, and Cairo Operations rests Friday–Saturday on the Egyptian list, so
// a Thursday holiday shifts to Sunday there.
import type { Database, Tx } from "@waste/db/client"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { project } from "@waste/db/schema/organisation"
import { planningArea } from "@waste/db/schema/planning-areas"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { testId, type Tenant } from "./tenant"

export type PlanningFixtures = {
  /** One planning area per project the suites plan in. */
  areas: { centrum: { id: string }; harbor: { id: string }; cairo: { id: string } }
}

/** The Danish holidays of the Copenhagen calendar: two named by the list's lookup, one by the calendar itself. */
export const COPENHAGEN_HOLIDAYS = {
  /** A Friday; the lookup calls it Constitution Day. */
  constitutionDay: "2026-06-05",
  /** A Thursday; unnamed on the calendar, so the lookup names it Christmas Eve. */
  christmasEve: "2026-12-24",
  /** A Friday; the calendar names it, and its name wins over the lookup's. */
  christmasDay: "2026-12-25",
  /** A Thursday; unnamed, so the lookup names it New Year's Eve. */
  newYearsEve: "2026-12-31",
} as const

/** The Cairo calendar: a Thursday the company itself named, and a Tuesday the Egyptian lookup names. */
export const CAIRO_HOLIDAYS = {
  /** A Thursday; Cairo rests Friday–Saturday, so shift-next lands on the Sunday. */
  companyHoliday: "2026-10-01",
  /** A Tuesday; the lookup calls it Armed Forces Day. */
  armedForcesDay: "2026-10-06",
} as const

export async function seedPlanning(pool: Database, tenant: Tenant): Promise<PlanningFixtures> {
  const { companyId } = tenant
  const fixtures: PlanningFixtures = { areas: { centrum: { id: testId() }, harbor: { id: testId() }, cairo: { id: testId() } } }
  const copenhagen = tenant.projects.copenhagen.id
  const harbor = tenant.projects.harbor.id
  const cairo = tenant.projects.cairo.id
  const calendars = { copenhagen: testId(), harbor: testId(), cairo: testId() }

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.update(project).set({ holidayList: "Danish public holidays" }).where(and(eq(project.companyId, companyId), eq(project.id, copenhagen)))
    await tx
      .update(project)
      .set({ holidayList: "Egyptian public holidays", weekend: ["friday", "saturday"] })
      .where(and(eq(project.companyId, companyId), eq(project.id, cairo)))
    await tx.insert(planningArea).values([
      { id: fixtures.areas.centrum.id, companyId, projectId: copenhagen, code: "OP-CEN-01", name: "Centrum", purpose: "route-planning" },
      { id: fixtures.areas.harbor.id, companyId, projectId: harbor, code: "HB-01", name: "Havnen", purpose: "route-planning" },
      { id: fixtures.areas.cairo.id, companyId, projectId: cairo, code: "CAI-01", name: "Maadi", purpose: "route-planning" },
    ])
    await tx.insert(collectionCalendar).values([
      { id: calendars.copenhagen, companyId, projectId: copenhagen, name: "Copenhagen Central 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
      { id: calendars.harbor, companyId, projectId: harbor, name: "Harbor Commercial 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
      { id: calendars.cairo, companyId, projectId: cairo, name: "Cairo Operations 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
    ])
    await tx.insert(collectionCalendarHoliday).values([
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.constitutionDay, name: null },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.christmasEve, name: null },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.christmasDay, name: "Juledag" },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.newYearsEve, name: null },
      // Harbor has the rows and no list: nobody reads them.
      { id: testId(), companyId, projectId: harbor, collectionCalendarId: calendars.harbor, day: COPENHAGEN_HOLIDAYS.christmasEve, name: "Juleaftensdag" },
      { id: testId(), companyId, projectId: cairo, collectionCalendarId: calendars.cairo, day: CAIRO_HOLIDAYS.companyHoliday, name: "Company holiday" },
      { id: testId(), companyId, projectId: cairo, collectionCalendarId: calendars.cairo, day: CAIRO_HOLIDAYS.armedForcesDay, name: null },
    ])
  })
  return fixtures
}
