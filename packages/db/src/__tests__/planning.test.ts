// The Planning tables against Postgres (Issue #97, slice 1), on a fresh
// database of this file's own so that "migration 0006 applies to a clean
// database" is proved — the first ALTER TABLE to a table an earlier file
// created included — and nothing depends on what the shared local database
// holds: the composite keys refuse another tenant's fraction, container type
// and provider and another project's planning area and container, the three
// exclusion constraints refuse two of one thing at a time and accept the
// second once the first has ended, the array checks hold a day set to the
// seven and a scheme's to at least one, the two shape checks and PostGIS's
// ring validity refuse what they should, the project's working week defaults
// and is checked, and the fence shows the API role exactly its company's rows
// in each of the nine. Every test runs as the owner in a transaction that is
// rolled back, so nothing needs cleaning up.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Polygon } from "@waste/contracts/geojson"
import { eq, getTableName } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { containerType, wasteFraction } from "../schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { container } from "../schema/containers"
import { company, project, serviceProvider } from "../schema/organisation"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "../schema/route-schemes"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c2f-${n}000-7000-8000-000000000001`,
  project: `018f7c2f-${n}000-7000-8000-000000000002`,
  wasteFraction: `018f7c2f-${n}000-7000-8000-000000000003`,
  containerType: `018f7c2f-${n}000-7000-8000-000000000004`,
  container: `018f7c2f-${n}000-7000-8000-000000000005`,
  serviceProvider: `018f7c2f-${n}000-7000-8000-000000000006`,
  planningArea: `018f7c2f-${n}000-7000-8000-000000000007`,
  boundary: `018f7c2f-${n}000-7000-8000-000000000008`,
  calendar: `018f7c2f-${n}000-7000-8000-000000000009`,
  holiday: `018f7c2f-${n}000-7000-8000-00000000000a`,
  scheme: `018f7c2f-${n}000-7000-8000-00000000000b`,
  ruleGroup: `018f7c2f-${n}000-7000-8000-00000000000c`,
  manualGroup: `018f7c2f-${n}000-7000-8000-00000000000d`,
  groupFraction: `018f7c2f-${n}000-7000-8000-00000000000e`,
  groupContainerType: `018f7c2f-${n}000-7000-8000-00000000000f`,
  groupContainer: `018f7c2f-${n}000-7000-8000-000000000010`,
  /** Free for a test's own rows. */
  spare: `018f7c2f-${n}000-7000-8000-0000000000e1`,
  other: `018f7c2f-${n}000-7000-8000-0000000000e2`,
  third: `018f7c2f-${n}000-7000-8000-0000000000e3`,
  /** A second project of the same company, and the rows of its own that a record of the first may not name: every one of those keys carries `project_id`. */
  harbor: `018f7c2f-${n}000-7000-8000-0000000000f1`,
  harborArea: `018f7c2f-${n}000-7000-8000-0000000000f2`,
  harborContainer: `018f7c2f-${n}000-7000-8000-0000000000f3`,
})
const a = ids("a")
const b = ids("b")

/** A square over central Copenhagen: a valid ring, closed on its first position. */
const SQUARE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.65],
      [12.65, 55.75],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}
/** The same four corners visited in the wrong order: a closed ring of four distinct positions that crosses itself, which the contracts' shape rule cannot see and ST_IsValid does. */
const BOW_TIE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.75],
      [12.65, 55.65],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}
/** The first day of the seeded periods; every date in this file is a `YYYY-MM-DD` string, as the validity columns read. */
const OPENED = "2026-01-01"

const tables: Record<string, PgTable> = {
  planningArea,
  planningAreaBoundary,
  collectionCalendar,
  collectionCalendarHoliday,
  routeScheme,
  collectionGroup,
  collectionGroupFraction,
  collectionGroupContainerType,
  collectionGroupContainer,
}

/** A company with its project, what the Registry and Organisation & Access lend it, and one row in each Planning table — two in collection_group, a rule group and a manual one — inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  await tx.insert(company).values({ id: own.company, companyId: own.company, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({
    id: own.project,
    companyId: own.company,
    name: "Copenhagen Central",
    kind: "Municipality",
    language: "da",
    currency: "DKK",
    timezone: "Europe/Copenhagen",
    status: "active",
    weekend: ["saturday", "sunday"],
    holidayList: "Danish public holidays",
  })
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, companyId: own.company, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, companyId: own.company, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(container).values({ id: own.container, companyId: own.company, projectId: own.project, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" })
  await tx.insert(serviceProvider).values({ id: own.serviceProvider, companyId: own.company, legalName: "NordRen ApS", registrationNumber: `4000000${n}`, country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars@${n}.example` })
  await tx.insert(planningArea).values({ id: own.planningArea, companyId: own.company, projectId: own.project, code: "OP-CEN-01", name: "Central", purpose: "route-planning" })
  await tx.insert(planningAreaBoundary).values({ id: own.boundary, companyId: own.company, projectId: own.project, validFrom: OPENED, planningAreaId: own.planningArea, boundary: SQUARE })
  await tx.insert(collectionCalendar).values({ id: own.calendar, companyId: own.company, projectId: own.project, validFrom: OPENED, validTo: "2027-01-01", name: "Copenhagen Central 2026" })
  await tx.insert(collectionCalendarHoliday).values({ id: own.holiday, companyId: own.company, projectId: own.project, collectionCalendarId: own.calendar, day: "2026-06-05", name: "Grundlovsdag" })
  await tx.insert(routeScheme).values({
    id: own.scheme,
    companyId: own.company,
    projectId: own.project,
    validFrom: OPENED,
    name: "Residual weekly",
    planningAreaId: own.planningArea,
    serviceType: "container-collection",
    frequency: "weekly",
    serviceDays: ["monday", "thursday"],
    plannedStartTime: "06:30",
    status: "validated",
  })
  await tx.insert(collectionGroup).values([
    { id: own.ruleGroup, companyId: own.company, projectId: own.project, routeSchemeId: own.scheme, name: "Rear loaders", position: 1, days: ["monday", "thursday"], stopSource: "rule", ruleVehicleType: "rear-loader", serviceProviderId: own.serviceProvider },
    { id: own.manualGroup, companyId: own.company, projectId: own.project, routeSchemeId: own.scheme, name: "By hand", position: 2, days: ["monday"], stopSource: "manual" },
  ])
  await tx.insert(collectionGroupFraction).values({ id: own.groupFraction, companyId: own.company, projectId: own.project, collectionGroupId: own.ruleGroup, wasteFractionId: own.wasteFraction })
  await tx.insert(collectionGroupContainerType).values({ id: own.groupContainerType, companyId: own.company, projectId: own.project, collectionGroupId: own.ruleGroup, containerTypeId: own.containerType })
  await tx.insert(collectionGroupContainer).values({ id: own.groupContainer, companyId: own.company, projectId: own.project, collectionGroupId: own.manualGroup, containerId: own.container, position: 1 })
}

/** A sound scheme of company a's first project, but for what a test overrides. */
const scheme = (values: Partial<typeof routeScheme.$inferInsert>): typeof routeScheme.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  validFrom: OPENED,
  name: "Paper fortnightly",
  planningAreaId: a.planningArea,
  serviceType: "container-collection",
  frequency: "weekly",
  serviceDays: ["tuesday"],
  ...values,
})

/** A sound rule group of the seeded scheme, but for what a test overrides. */
const group = (values: Partial<typeof collectionGroup.$inferInsert>): typeof collectionGroup.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeSchemeId: a.scheme,
  name: "Another group",
  position: 3,
  days: ["thursday"],
  stopSource: "rule",
  ...values,
})

describe("the Planning tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_planning")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** The two companies seeded as the owner in a transaction that is rolled back. */
  const seeded = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
      return fn(tx)
    })

  test("0006 created the nine tables in wms, each fenced (row-level security enabled and forced, one policy for the API role) and with its updated_at trigger", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.equal(names.length, 9)
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: [`${table}_touch_updated_at`] })),
    )
  })

  test("and gave project its working week: the weekend defaults to Saturday and Sunday, the holiday list to none, and a day outside the seven is refused (23514 project_weekend_subset_of)", () =>
    seeded(async (tx) => {
      await tx.insert(project).values({ id: a.spare, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "onboarding" })
      const [harbor] = await tx.select({ weekend: project.weekend, holidayList: project.holidayList }).from(project).where(eq(project.id, a.spare))
      assert.deepEqual(harbor, { weekend: ["saturday", "sunday"], holidayList: null })
      // Cairo rests Friday–Saturday, and the column takes it as said.
      await tx.update(project).set({ weekend: ["friday", "saturday"], holidayList: "Egyptian public holidays" }).where(eq(project.id, a.spare))
      const [cairo] = await tx.select({ weekend: project.weekend, holidayList: project.holidayList }).from(project).where(eq(project.id, a.spare))
      assert.deepEqual(cairo, { weekend: ["friday", "saturday"], holidayList: "Egyptian public holidays" })
      // A project that never rests is an empty set, which the subset check allows: nothing says a weekend has a day in it.
      await tx.update(project).set({ weekend: [] }).where(eq(project.id, a.spare))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(project).set({ weekend: ["saturday", "funday"] }).where(eq(project.id, a.spare))),
        refusedWith("23514", /project_weekend_subset_of/),
      )
      // But a project that always rests has no working day for a shifted collection to land on: six is the most (23514 project_weekend_not_every_day).
      const week = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
      await tx.update(project).set({ weekend: week.slice(0, 6) }).where(eq(project.id, a.spare))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(project).set({ weekend: week }).where(eq(project.id, a.spare))),
        refusedWith("23514", /project_weekend_not_every_day/),
      )
    }))

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }
  /** What one company seeded: one row in each table, two collection groups. */
  const ownRows = { ...Object.fromEntries(Object.keys(tables).map((name) => [name, 1])), collectionGroup: 2 }

  /** Both companies seeded as the owner inside `withCompany`, then the transaction becomes the API role. */
  const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBackIn(
      (body) => withCompany(owner.db, companyId, body),
      async (tx) => {
        await seed(tx, "a")
        await seed(tx, "b")
        // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        return fn(tx)
      },
    )

  test("under withCompany as the API role, each of the nine tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      schemes: (await tx.select({ id: routeScheme.id }).from(routeScheme)).map((row) => row.id),
      boundaries: (await tx.select({ boundary: planningAreaBoundary.boundary }).from(planningAreaBoundary)).map((row) => row.boundary),
    }))
    assert.deepEqual(seenByA, { counts: ownRows, schemes: [a.scheme], boundaries: [SQUARE] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      schemes: (await tx.select({ id: routeScheme.id }).from(routeScheme)).map((row) => row.id),
    }))
    assert.deepEqual(seenByB, { counts: ownRows, schemes: [b.scheme] })
  })

  test("a group that names another company's fraction, container type or service provider is refused by the composite key (23503)", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(collectionGroupFraction).values({ id: a.spare, companyId: a.company, projectId: a.project, collectionGroupId: a.ruleGroup, wasteFractionId: b.wasteFraction })),
        refusedWith("23503", /collection_group_fraction_waste_fraction_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(collectionGroupContainerType).values({ id: a.spare, companyId: a.company, projectId: a.project, collectionGroupId: a.ruleGroup, containerTypeId: b.containerType }),
        ),
        refusedWith("23503", /collection_group_container_type_container_type_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(collectionGroup).values(group({ serviceProviderId: b.serviceProvider }))),
        refusedWith("23503", /collection_group_service_provider_id_fk/),
      )
      // The same rows within the tenant land; a second fraction is another row of the rule.
      await tx.insert(wasteFraction).values({ id: a.other, companyId: a.company, key: "paper", name: "Paper" })
      await tx.insert(collectionGroupFraction).values({ id: a.spare, companyId: a.company, projectId: a.project, collectionGroupId: a.ruleGroup, wasteFractionId: a.other })
      await tx.insert(collectionGroup).values(group({ serviceProviderId: a.serviceProvider }))
    }))

  test("a scheme cannot name the planning area of another project of its own company, and a group cannot pick that project's container (23503)", () =>
    seeded(async (tx) => {
      // A second project of company a, with a planning area and a container
      // of its own. The tenant is the same, so only the project_id in the key
      // stands between them.
      await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      await tx.insert(planningArea).values({ id: a.harborArea, companyId: a.company, projectId: a.harbor, code: "OP-HAR-01", name: "Harbor", purpose: "route-planning" })
      await tx.insert(container).values({ id: a.harborContainer, companyId: a.company, projectId: a.harbor, label: "BIN-82015", containerTypeId: a.containerType, ownership: "company" })

      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ planningAreaId: a.harborArea }))), refusedWith("23503", /route_scheme_planning_area_id_fk/))
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(collectionGroupContainer).values({ id: a.spare, companyId: a.company, projectId: a.project, collectionGroupId: a.manualGroup, containerId: a.harborContainer, position: 2 }),
        ),
        refusedWith("23503", /collection_group_container_container_id_fk/),
      )
      // And a boundary cannot be drawn for another project's area.
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(planningAreaBoundary).values({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: OPENED, planningAreaId: a.harborArea, boundary: SQUARE }),
        ),
        refusedWith("23503", /planning_area_boundary_planning_area_id_fk/),
      )

      // The same rows land when every id they name is their own project's.
      await tx.insert(routeScheme).values(scheme({}))
      await tx.insert(container).values({ id: a.third, companyId: a.company, projectId: a.project, label: "BIN-82016", containerTypeId: a.containerType, ownership: "company" })
      await tx.insert(collectionGroupContainer).values({ id: a.other, companyId: a.company, projectId: a.project, collectionGroupId: a.manualGroup, containerId: a.third, position: 2 })
    }))

  test("one boundary of an area at a time (23P01 planning_area_boundary_no_overlap), and a new version may start the day the old ends", () =>
    seeded(async (tx) => {
      const version = (validFrom: string) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom, planningAreaId: a.planningArea, boundary: SQUARE })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(planningAreaBoundary).values(version("2026-07-01"))), refusedWith("23P01", /planning_area_boundary_no_overlap/))
      // The period is half-open, so the next version may start on the day the first ends.
      await tx.update(planningAreaBoundary).set({ validTo: "2026-07-01" }).where(eq(planningAreaBoundary.id, a.boundary))
      await tx.insert(planningAreaBoundary).values(version("2026-07-01"))
      // Two areas of one project may overlap in space and in time: that is a read, not a constraint.
      await tx.insert(planningArea).values({ id: a.other, companyId: a.company, projectId: a.project, code: "OP-CEN-02", name: "Central north", purpose: "route-planning" })
      await tx.insert(planningAreaBoundary).values({ ...version(OPENED), id: a.third, planningAreaId: a.other })
    }))

  test("one scheme of a name in force at a time (23P01 route_scheme_no_overlap); the name is free once the first has ended, in another project, and beside another name", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ name: "Residual weekly", validFrom: "2026-07-01" }))), refusedWith("23P01", /route_scheme_no_overlap/))
      await tx.update(routeScheme).set({ validTo: "2026-07-01" }).where(eq(routeScheme.id, a.scheme))
      await tx.insert(routeScheme).values(scheme({ name: "Residual weekly", validFrom: "2026-07-01" }))
      // Another name over the same period is another scheme, and the key is the project's: the same name in another project of the company is another scheme too.
      await tx.insert(routeScheme).values(scheme({ id: a.other, name: "Residual weekly, north", validFrom: OPENED }))
      await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      await tx.insert(routeScheme).values(scheme({ id: a.third, name: "Residual weekly", validFrom: OPENED, projectId: a.harbor, planningAreaId: null }))
    }))

  test("one calendar of a project in force at a time (23P01 collection_calendar_no_overlap): the per-year records tile the project's timeline", () =>
    seeded(async (tx) => {
      const calendar = (name: string, validFrom: string, validTo: string | null) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom, validTo, name })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(collectionCalendar).values(calendar("Copenhagen Central 2026, second half", "2026-07-01", null))),
        refusedWith("23P01", /collection_calendar_no_overlap/),
      )
      // Next year's record starts the day this year's ends, and a holiday goes on the record whose period it falls in.
      await tx.insert(collectionCalendar).values(calendar("Copenhagen Central 2027", "2027-01-01", "2028-01-01"))
      await tx.insert(collectionCalendarHoliday).values({ id: a.other, companyId: a.company, projectId: a.project, collectionCalendarId: a.spare, day: "2027-06-05", name: "Grundlovsdag" })
      // The same day twice on one calendar is one holiday (23505).
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(collectionCalendarHoliday).values({ id: a.third, companyId: a.company, projectId: a.project, collectionCalendarId: a.calendar, day: "2026-06-05" })),
        refusedWith("23505", /collection_calendar_holiday_collection_calendar_id_day_key/),
      )
    }))

  test("a boundary that is not a valid polygon is refused (23514 planning_area_boundary_boundary_valid): a ring that crosses itself, and one off the map", () =>
    seeded(async (tx) => {
      // A period before the seeded version's, so the exclusion constraint has nothing to say and the check is what refuses.
      const earlier = (boundary: Polygon) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: "2025-01-01", validTo: OPENED, planningAreaId: a.planningArea, boundary })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(planningAreaBoundary).values(earlier(BOW_TIE))), refusedWith("23514", /planning_area_boundary_boundary_valid/))
      const offTheMap: Polygon = { type: "Polygon", coordinates: [SQUARE.coordinates[0].map(([lng, lat]) => [lng + 180, lat])] }
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(planningAreaBoundary).values(earlier(offTheMap))), refusedWith("23514", /planning_area_boundary_boundary_valid/))
      // The square itself lands, and reads back as the GeoJSON it was written as.
      await tx.insert(planningAreaBoundary).values(earlier(SQUARE))
      const [row] = await tx.select({ boundary: planningAreaBoundary.boundary }).from(planningAreaBoundary).where(eq(planningAreaBoundary.id, a.spare))
      assert.deepEqual(row.boundary, SQUARE)
    }))

  test("a scheme's service days are one or more of the seven (23514 route_scheme_service_days_subset_of, route_scheme_service_days_non_empty); a group's days are of the seven and may be none", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ serviceDays: ["monday", "funday"] }))), refusedWith("23514", /route_scheme_service_days_subset_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ serviceDays: [] }))), refusedWith("23514", /route_scheme_service_days_non_empty/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(collectionGroup).values(group({ days: ["Monday"] }))), refusedWith("23514", /collection_group_days_subset_of/))
      // A group that no longer runs keeps its row with no days; a daily scheme serves all seven.
      await tx.insert(collectionGroup).values(group({ days: [] }))
      await tx.insert(routeScheme).values(scheme({ frequency: "daily", serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] }))
    }))

  test("the week rotation belongs to every-2-weeks and to nothing else (23514 route_scheme_week_rotation_shape), and a manual group carries no vehicle type (23514 collection_group_rule_shape)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ frequency: "weekly", weekRotation: "odd" }))), refusedWith("23514", /route_scheme_week_rotation_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ frequency: "every-2-weeks" }))), refusedWith("23514", /route_scheme_week_rotation_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(routeScheme).values(scheme({ frequency: "every-2-weeks", weekRotation: "third" }))), refusedWith("23514", /route_scheme_week_rotation_one_of/))
      await tx.insert(routeScheme).values(scheme({ frequency: "every-2-weeks", weekRotation: "even" }))

      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(collectionGroup).values(group({ stopSource: "manual", ruleVehicleType: "rear-loader" }))), refusedWith("23514", /collection_group_rule_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(collectionGroup).values(group({ ruleVehicleType: "side-loader" }))), refusedWith("23514", /collection_group_rule_vehicle_type_one_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(collectionGroup).values(group({ position: 0 }))), refusedWith("23514", /collection_group_position_positive/))
      // A rule group without a vehicle type asks for any; a manual one without one is the shape.
      await tx.insert(collectionGroup).values([group({}), group({ id: a.other, name: "Picked", stopSource: "manual", position: 3 })])
    }))

  test("the defaults a scheme is written with: skip on a holiday, ask on an edit, plan ahead, a draft — and the planned start time is a time of day", () =>
    seeded(async (tx) => {
      await tx.insert(routeScheme).values(scheme({ plannedStartTime: null }))
      const [row] = await tx
        .select({ holidayPolicy: routeScheme.holidayPolicy, editPolicy: routeScheme.editPolicy, planAhead: routeScheme.planAhead, status: routeScheme.status, plannedStartTime: routeScheme.plannedStartTime })
        .from(routeScheme)
        .where(eq(routeScheme.id, a.spare))
      assert.deepEqual(row, { holidayPolicy: "skip", editPolicy: "ask", planAhead: true, status: "draft", plannedStartTime: null })
      const [seededScheme] = await tx.select({ plannedStartTime: routeScheme.plannedStartTime }).from(routeScheme).where(eq(routeScheme.id, a.scheme))
      assert.equal(seededScheme.plannedStartTime, "06:30:00", "Postgres spells a time with its seconds; the contracts' IsoTime is the API's spelling")
    }))
})
