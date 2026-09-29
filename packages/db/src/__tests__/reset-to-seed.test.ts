// Reset-to-seed (Issue #142) against a database of this file's own, never
// the shared local one: other suites seed and read there, and a reset sweeps
// the demo company whole. The file creates a database, migrates it, seeds the
// demo company and a second company beside it, and drops it after.
//
// "A reset equals a fresh seed" is proved by snapshot, not by counts, since
// the seed grows (#156): every row of the demo company in every `wms` table
// the database holds, read off the catalogue, ordered by id and rendered by
// the database, taken after the fresh seed and again after a reset over rows
// testers made in every context. The stamps are the one thing a reset may
// move, and only as the seed moves them: the seed writes in one transaction,
// so a fresh seed's rows carry one instant, and every row a reset writes
// carries the reset's — a swept row because the seed wrote it again, a kept
// row only where something had moved it off the seed's word.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { and, eq, getTableName, sql } from "drizzle-orm"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { KEPT_TABLES, resetToSeed, SWEPT_TABLES, sweepOrder } from "../reset-to-seed"
import { projectAccess, role, roleGrant, userAccount } from "../schema/access"
import { containerType, product, wasteFraction } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { customer, property } from "../schema/customers"
import { outboxEvent, pickup, route } from "../schema/execution"
import { billingRun, invoice, priceList, priceListRow } from "../schema/finance"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { generationRun } from "../schema/generation"
import { company, project } from "../schema/organisation"
import { depot, unloadingStation, warehouse } from "../schema/places"
import { planningArea } from "../schema/planning-areas"
import { ticket, ticketEvent } from "../schema/resolution"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { stockMovement } from "../schema/stock"
import { DEMO_IDS, seedDemo } from "../seed/demo"
import { PGBOSS_SCHEMA } from "../sql/pgboss"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

/** The package's directory, where its scripts run from. */
const PACKAGE = fileURLToPath(new URL("../..", import.meta.url))

const DEMO = DEMO_IDS.company

/** A second company on the database, in this file's own id bucket: what a reset must never touch. */
const OTHER = {
  company: "018f7c42-0000-7000-8000-000000000001",
  project: "018f7c42-0000-7000-8000-000000000002",
  role: "018f7c42-0000-7000-8000-000000000003",
  account: "018f7c42-0000-7000-8000-000000000004",
  fraction: "018f7c42-0000-7000-8000-000000000005",
  containerType: "018f7c42-0000-7000-8000-000000000006",
  container: "018f7c42-0000-7000-8000-000000000007",
  customer: "018f7c42-0000-7000-8000-000000000008",
  property: "018f7c42-0000-7000-8000-000000000009",
  product: "018f7c42-0000-7000-8000-00000000000a",
}

/** A queue of this file's own on its own database, for the jobs a reset leaves behind. */
const SPECIMEN_QUEUE = "reset.specimen"

/** What a company's operational rows hang off. */
type Ground = { companyId: string; projectId: string; accountId: string; containerId: string; propertyId: string; fractionId: string; customerId: string; productId: string }

/** One company's rows in every `wms` table: each table's rows ordered by id, as the database renders them. */
type Snapshot = Record<string, Record<string, unknown>[]>

const STAMPS = ["created_at", "updated_at", "recorded_at"] as const
/** What the reset keeps (the Logins decision of #142, as the PR states it): Organisation & Access, what a person signs in with and is. */
const KEPT = new Set(["company", "project", "service_provider", "role", "role_grant", "user_account", "project_access", "service_provider_access"])
/** The seed's hand-spelled id bucket (seed/ids.ts): a row outside it was minted by the database. */
const SEEDED_ID = /^01a0d2a4-a280-7/

/** Every stamp in a snapshot. */
function instantsIn(snapshot: Snapshot): Set<string> {
  const found = new Set<string>()
  for (const rows of Object.values(snapshot)) for (const row of rows) for (const stamp of STAMPS) if (typeof row[stamp] === "string") found.add(row[stamp] as string)
  return found
}

/**
 * The snapshot a fresh seed would read after the reset: the seeded rows with
 * every stamp of a swept table, and the stamps of the kept rows named in
 * `healed`, at the reset's instant; the other kept rows exactly as seeded.
 */
function expectedAfterReset(seeded: Snapshot, resetAt: string, healed: Record<string, readonly string[]> = {}): Snapshot {
  return Object.fromEntries(
    Object.entries(seeded).map(([table, rows]) => [
      table,
      rows.map((row) => {
        if (KEPT.has(table) && !(healed[table] ?? []).includes(row.id as string)) return row
        if (KEPT.has(table)) return { ...row, updated_at: resetAt }
        return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, (STAMPS as readonly string[]).includes(column) ? resetAt : value]))
      }),
    ]),
  )
}

/**
 * A row the seed writes without an id of its own (a pair it joins, as a grant
 * is) comes back from a reset under a new one: in a swept table, such a row is
 * compared without its id, the rows sorted by what they say.
 */
function withoutMintedIds(snapshot: Snapshot): Snapshot {
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => {
      if (KEPT.has(table) || rows.every((row) => SEEDED_ID.test(row.id as string))) return [table, rows]
      const unkeyed = rows.map((row) => (SEEDED_ID.test(row.id as string) ? row : { ...row, id: "<minted>" }))
      return [table, unkeyed.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
    }),
  )
}

/** The tables of a snapshot a reset would sweep rows from, in the sweep's order. */
const sweptTablesOf = (snapshot: Snapshot): string[] => SWEPT_TABLES.map(getTableName).filter((table) => snapshot[table].length > 0)

/** How many rows a reset would sweep from the company a snapshot holds. */
const sweptRows = (snapshot: Snapshot): number => sweptTablesOf(snapshot).reduce((total, table) => total + snapshot[table].length, 0)

/** The script's line for what a reset of a snapshot's company sweeps. */
const sweptLine = (snapshot: Snapshot): string =>
  `Swept ${sweptRows(snapshot)} rows from ${sweptTablesOf(snapshot).length} tables, children first${sweptTablesOf(snapshot)
    .map((table) => `, ${table} ${snapshot[table].length}`)
    .join("")}.`

/** A row of each context's operational and configuration tables, as testers make them through the API and the worker; the rows it names are the ground's. */
async function operate(tx: Tx, ground: Ground): Promise<void> {
  const { companyId, projectId, accountId: by } = ground
  const scoped = { companyId, projectId }
  const at = new Date("2026-10-05T06:00:00Z")
  // Planning.
  const [area] = await tx.insert(planningArea).values({ ...scoped, code: "TESTER-AREA", name: "A tester's area", purpose: "route-planning" }).returning({ id: planningArea.id })
  const [scheme] = await tx
    .insert(routeScheme)
    .values({ ...scoped, name: "A tester's scheme", planningAreaId: area.id, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], validFrom: "2026-10-01" })
    .returning({ id: routeScheme.id })
  const [group] = await tx.insert(collectionGroup).values({ ...scoped, routeSchemeId: scheme.id, name: "Group 1", position: 1, days: ["monday"], stopSource: "manual" }).returning({ id: collectionGroup.id })
  // Resources, and the Stock Movement ledger.
  const [type] = await tx.insert(vehicleType).values({ companyId, key: "tester-truck", name: "A tester's truck" }).returning({ id: vehicleType.id })
  await tx.insert(vehicle).values({ ...scoped, registration: "TE 12 345", kind: "powered-vehicle", vehicleTypeId: type.id, ownership: "company", status: "active", requiredLicenceClass: "c" })
  await tx.insert(driver).values({ ...scoped, name: "A tester's driver", employment: "employee", status: "active" })
  await tx.insert(depot).values({ ...scoped, code: "TESTER-DEPOT", name: "A tester's depot", address: "Sundkrogsgade 1", location: { type: "Point", coordinates: [12.5951, 55.7089] }, ownership: "company", status: "active" })
  await tx
    .insert(unloadingStation)
    .values({ companyId, code: "TESTER-STATION", name: "A tester's station", address: "Vindmøllevej 6", location: { type: "Point", coordinates: [12.6193, 55.6602] }, ownership: "external", status: "active" })
  const [store] = await tx.insert(warehouse).values({ ...scoped, code: "TESTER-WH", name: "A tester's warehouse", address: "Lagervej 2", status: "active" }).returning({ id: warehouse.id })
  await tx.insert(stockMovement).values({ ...scoped, containerId: ground.containerId, kind: "receipt", fromKind: "supplier", toKind: "warehouse", toWarehouseId: store.id, occurredAt: at, recordedBy: by })
  // Generation and Execution: a run, a route with its pickup, the news of its dispatch not yet relayed.
  await tx.insert(generationRun).values({ ...scoped, routeSchemeId: scheme.id, trigger: "on-demand", windowFrom: "2026-10-05", windowTo: "2026-10-11" })
  const [run] = await tx
    .insert(route)
    .values({ ...scoped, routeSchemeId: scheme.id, collectionGroupId: group.id, serviceDate: "2026-10-05", operatingDate: "2026-10-05", number: 1000 })
    .returning({ id: route.id })
  await tx.insert(pickup).values({ ...scoped, routeId: run.id, containerId: ground.containerId, position: 1, propertyId: ground.propertyId, wasteFractionId: ground.fractionId })
  await tx.insert(outboxEvent).values({ ...scoped, kind: "route-dispatched", aggregateKind: "route", aggregateId: run.id, occurredAt: at, payload: {} })
  // Resolution: a ticket and its history, a ledger.
  const [opened] = await tx
    .insert(ticket)
    .values({ ...scoped, number: 1000, kind: "missed-collection", source: "phone", subject: "Bin not emptied", description: "The bin was missed on Monday", occurredAt: at, createdBy: by })
    .returning({ id: ticket.id })
  await tx.insert(ticketEvent).values({ ...scoped, ticketId: opened.id, kind: "created", status: "open", recordedBy: by })
  // Finance: a tariff, a completed run and its invoice, a ledger.
  const [list] = await tx.insert(priceList).values({ ...scoped, code: "TESTER-PL", name: "A tester's tariff", currency: "DKK", validFrom: "2026-01-01" }).returning({ id: priceList.id })
  await tx.insert(priceListRow).values({ ...scoped, priceListId: list.id, productId: ground.productId, unitPriceMinor: 12_000, validFrom: "2026-01-01" })
  const [billed] = await tx
    .insert(billingRun)
    .values({ ...scoped, periodFrom: "2026-10-01", periodTo: "2026-10-31", status: "completed", completedAt: at, requestedBy: by })
    .returning({ id: billingRun.id })
  await tx.insert(invoice).values({
    ...scoped,
    number: 1000,
    kind: "invoice",
    customerId: ground.customerId,
    currency: "DKK",
    issuedOn: "2026-11-01",
    dueOn: "2026-12-01",
    periodFrom: "2026-10-01",
    periodTo: "2026-10-31",
    billingRunId: billed.id,
    netMinor: 12_000,
    vatMinor: 3_000,
    grossMinor: 15_000,
    issuedBy: by,
  })
  // The counters, as generation, Resolution and a billing run take them.
  await tx
    .update(company)
    .set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1`, nextTicketNumber: sql`${company.nextTicketNumber} + 1`, nextInvoiceNumber: sql`${company.nextInvoiceNumber} + 1` })
    .where(eq(company.id, companyId))
}

describe("reset-to-seed against a database of its own", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  /** The demo company as a fresh seed leaves it, and the one instant its rows carry. */
  let seeded: Snapshot
  let seedInstant: string
  /** The other company, with rows in every context, before any reset. */
  let otherBefore: Snapshot

  /** Every row of the company in every table of the `wms` schema, read off the catalogue, not the Drizzle schema. */
  const snapshot = async (companyId: string): Promise<Snapshot> => {
    const tables = await owner.sql<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind in ('r', 'p') order by c.relname`
    const result: Snapshot = {}
    for (const { name } of tables) {
      const [{ rows }] = await owner.sql.unsafe<{ rows: string }[]>(
        `select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)::text as rows from "wms"."${name}" t where t.company_id = $1`,
        [companyId],
      )
      result[name] = JSON.parse(rows) as Record<string, unknown>[]
    }
    return result
  }

  /** The first seeded row of the demo company in a table, by id, where a condition holds: for a tester's row to name. */
  const seededId = async (table: string, where = "true"): Promise<string> => {
    const [row] = await owner.sql.unsafe<{ id: string }[]>(`select id from "wms"."${table}" where company_id = $1 and ${where} order by id limit 1`, [DEMO])
    assert.ok(row, `the seed wrote no ${table} row where ${where}`)
    return row.id
  }

  /** The one instant a reset wrote with: the stamp the demo company carries that the fresh seed did not. */
  const resetInstant = (snapshot: Snapshot, before: ReadonlySet<string>): string => {
    const written = [...instantsIn(snapshot)].filter((instant) => !before.has(instant))
    assert.equal(written.length, 1, `every row a reset writes carries one instant, its transaction's; found ${written.join(", ")}`)
    return written[0]
  }

  /** The specimen queue's jobs replaced by one waiting job per company named, as the relay leaves them. */
  const queueJobs = async (...companyIds: string[]): Promise<void> => {
    await owner.sql.unsafe(`delete from ${PGBOSS_SCHEMA}.job where name = $1`, [SPECIMEN_QUEUE])
    for (const companyId of companyIds) await owner.sql.unsafe(`insert into ${PGBOSS_SCHEMA}.job (name, data) values ($1, $2::jsonb)`, [SPECIMEN_QUEUE, JSON.stringify({ companyId })])
  }

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_reset")
    await migrateDatabase(fresh.url)
    await seedDemo(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
    await owner.sql.unsafe(`select ${PGBOSS_SCHEMA}.create_queue($1, '{"policy": "standard"}'::jsonb)`, [SPECIMEN_QUEUE])
    seeded = await snapshot(DEMO)
    const instants = instantsIn(seeded)
    assert.equal(instants.size, 1, "the seed writes in one transaction, so every row it wrote carries one instant")
    ;[seedInstant] = instants

    // The other company, with rows in every context the demo company's testers write.
    await owner.db.transaction(async (tx) => {
      const own = { companyId: OTHER.company }
      await tx.insert(company).values({ id: OTHER.company, ...own, name: "Another company", legalName: "Another company A/S", registrationNumber: "87654321", country: "DK", status: "active" })
      await tx.insert(project).values({ id: OTHER.project, ...own, name: "Aarhus", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      await tx.insert(role).values({ id: OTHER.role, ...own, name: "Everything", scope: "Company", description: "All of it", system: false })
      await tx.insert(userAccount).values({ id: OTHER.account, ...own, authUserId: randomUUID(), email: "someone@another.example", fullName: "Some One", roleId: OTHER.role, allProjects: true, primaryAdministrator: true })
      await tx.insert(roleGrant).values({ ...own, roleId: OTHER.role, moduleKey: "configure.access", action: "view" })
      await tx.insert(wasteFraction).values({ id: OTHER.fraction, ...own, key: "residual", name: "Residual" })
      await tx.insert(containerType).values({ id: OTHER.containerType, ...own, name: "240 L bin", volumeLitres: 240 })
      await tx.insert(container).values({ id: OTHER.container, ...own, projectId: OTHER.project, label: "BIN-1", containerTypeId: OTHER.containerType, ownership: "company" })
      await tx.insert(customer).values({ id: OTHER.customer, ...own, kind: "organisation", name: "Someone A/S", status: "active" })
      await tx.insert(property).values({ id: OTHER.property, ...own, projectId: OTHER.project, name: "Strøget 1", address: "Strøget 1, 8000 Aarhus C", kind: "commercial", status: "active" })
      await tx.insert(product).values({ id: OTHER.product, ...own, projectId: OTHER.project, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup" })
      await operate(tx, {
        companyId: OTHER.company,
        projectId: OTHER.project,
        accountId: OTHER.account,
        containerId: OTHER.container,
        propertyId: OTHER.property,
        fractionId: OTHER.fraction,
        customerId: OTHER.customer,
        productId: OTHER.product,
      })
    })
    otherBefore = await snapshot(OTHER.company)
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("sweeps every table but Organisation & Access's eight, each before every table it references, as the database's own keys say", async () => {
    const tables = await owner.sql<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'wms' and c.relkind in ('r', 'p')`
    const swept = SWEPT_TABLES.map(getTableName)
    assert.deepEqual(KEPT_TABLES.map(getTableName).sort(), [...KEPT].sort())
    assert.deepEqual([...swept, ...KEPT].sort(), tables.map((row) => row.name).sort(), "every wms table is kept or swept, once")
    // A SET NULL key (confdeltype 'n') clears itself under the parent's delete, so it forces no order (#169: route.active_plan_id).
    const keys = await owner.sql<{ child: string; parent: string }[]>`
      select child.relname as child, parent.relname as parent from pg_constraint k
      join pg_class child on child.oid = k.conrelid join pg_class parent on parent.oid = k.confrelid
      join pg_namespace n on n.oid = child.relnamespace
      where k.contype = 'f' and n.nspname = 'wms' and child.oid <> parent.oid and k.confdeltype <> 'n'`
    const position = new Map(swept.map((name, index) => [name, index]))
    for (const { child, parent } of keys) {
      if (!position.has(child)) {
        assert.ok(KEPT.has(parent), `the kept table ${child} references the swept ${parent}, which the sweep would then fail on`)
        continue
      }
      if (position.has(parent)) assert.ok((position.get(child) as number) < (position.get(parent) as number), `${child} names ${parent}, so it is swept first`)
    }
    assert.deepEqual(sweepOrder([route, pickup, ticket]).map(getTableName), ["ticket", "pickup", "route"], "whatever order they are given in")
    assert.deepEqual(sweepOrder([ticket, route, pickup]).map(getTableName), ["ticket", "pickup", "route"])
  })

  test("refuses any company but the demo company's, before it deletes anything", async () => {
    await assert.rejects(
      resetToSeed(fresh.url, OTHER.company),
      /reset-to-seed resets the demo company \(01a0d2a4-a280-7001-8000-000000000001\) and no other; refused 018f7c42-0000-7000-8000-000000000001, and nothing was deleted/,
    )
    assert.deepEqual(await snapshot(DEMO), seeded)
    assert.deepEqual(await snapshot(OTHER.company), otherBefore)
  })

  test("a reset over rows testers made in every context equals a fresh seed, the counters back, and says what it swept", async () => {
    const copenhagen = DEMO_IDS.projects.copenhagen
    const ground: Ground = {
      companyId: DEMO,
      projectId: copenhagen,
      accountId: DEMO_IDS.users.fares,
      containerId: await seededId("container", `project_id = '${copenhagen}'`),
      propertyId: await seededId("property", `project_id = '${copenhagen}'`),
      fractionId: await seededId("waste_fraction"),
      customerId: await seededId("customer"),
      productId: await seededId("product", `project_id = '${copenhagen}'`),
    }
    await owner.db.transaction(async (tx) => {
      await operate(tx, ground)
      // Seeded rows edited: a Registry row renamed, a column the seed does not write set, a placement ended by deletion, a project renamed.
      await tx.update(customer).set({ name: "Renamed by a tester" }).where(eq(customer.id, ground.customerId))
      await tx.update(container).set({ notes: "Dented" }).where(eq(container.id, ground.containerId))
      await tx.delete(containerServicePlacement).where(eq(containerServicePlacement.id, await seededId("container_service_placement")))
      await tx.update(project).set({ name: "Harbour, renamed" }).where(eq(project.id, DEMO_IDS.projects.harbor))
    })
    // A job on pg-boss's queue for the demo company and one for the other, as the relay leaves them.
    await queueJobs(DEMO, OTHER.company)
    const operated = await snapshot(DEMO)
    assert.notDeepEqual(operated, seeded)

    const report = await resetToSeed(fresh.url, DEMO)

    const reset = await snapshot(DEMO)
    const resetAt = resetInstant(reset, new Set([seedInstant, ...instantsIn(operated)]))
    assert.ok(Date.parse(resetAt) > Date.parse(seedInstant))
    assert.deepEqual(withoutMintedIds(reset), withoutMintedIds(expectedAfterReset(seeded, resetAt, { company: [DEMO], project: [DEMO_IDS.projects.harbor] })))
    const [counters] = await owner.db.select({ route: company.nextRouteNumber, ticket: company.nextTicketNumber, invoice: company.nextInvoiceNumber }).from(company).where(eq(company.id, DEMO))
    assert.deepEqual(counters, { route: 1000, ticket: 1000, invoice: 1000 }, "the counters a fresh seed leaves, the columns' defaults")

    // What it says: every row it deleted, table by table, the news no relay will send, the jobs left to fail.
    const expectedSweep = Object.entries(operated)
      .filter(([table, rows]) => !KEPT.has(table) && rows.length > 0)
      .map(([table, rows]) => [table, rows.length])
    assert.deepEqual(Object.fromEntries(report.swept.map(({ table, rows }) => [table, rows])), Object.fromEntries(expectedSweep))
    assert.deepEqual(
      report.swept.map(({ table }) => table),
      SWEPT_TABLES.map(getTableName).filter((table) => report.swept.some((row) => row.table === table)),
      "in the order it swept them",
    )
    assert.deepEqual({ unsentEvents: report.unsentEvents, waitingJobs: report.waitingJobs, otherAccounts: report.otherAccounts }, { unsentEvents: 1, waitingJobs: 1, otherAccounts: 0 })
    const [{ jobs }] = await owner.sql.unsafe<{ jobs: number }[]>(`select count(*)::int as jobs from ${PGBOSS_SCHEMA}.job where name = $1`, [SPECIMEN_QUEUE])
    assert.equal(jobs, 2, "pg-boss's jobs are not the company's rows, and are left for the worker to fail")

    assert.deepEqual(await snapshot(OTHER.company), otherBefore, "the other company's rows, every one untouched")
  })

  test("a second reset lands where the first did: the kept rows untouched, the swept ones written again as the seed writes them", async () => {
    const first = await snapshot(DEMO)
    const report = await resetToSeed(fresh.url, DEMO)
    const second = await snapshot(DEMO)
    const resetAt = resetInstant(second, instantsIn(first))
    assert.deepEqual(withoutMintedIds(second), withoutMintedIds(expectedAfterReset(first, resetAt)))
    assert.equal(report.unsentEvents, 0)
    assert.deepEqual(await snapshot(OTHER.company), otherBefore)
  })

  test("keeps the Logins bound and every account the seed does not name, and puts the seeded roles, accounts and access back to the seed's word", async () => {
    const harbor = DEMO_IDS.projects.harbor
    const tester = { id: "018f7c42-0000-7000-8000-0000000000a1", role: "018f7c42-0000-7000-8000-0000000000a2" }
    const login = randomUUID()
    await owner.db.transaction(async (tx) => {
      // Fares has signed in (the hook bound his Login); Lars was deactivated through the API.
      await tx.update(userAccount).set({ authUserId: login }).where(eq(userAccount.id, DEMO_IDS.users.fares))
      await tx.update(userAccount).set({ deactivatedAt: new Date("2026-10-01T09:00:00Z") }).where(eq(userAccount.id, DEMO_IDS.users.lars))
      // A tester invited in Users & Roles at their own address, on a custom role, signed in, working in Harbor.
      await tx.insert(role).values({ id: tester.role, companyId: DEMO, name: "Pilot tester", scope: "Assigned projects", description: "Tries things", system: false })
      await tx.insert(roleGrant).values({ companyId: DEMO, roleId: tester.role, moduleKey: "configure.access", action: "view" })
      await tx.insert(userAccount).values({ id: tester.id, companyId: DEMO, authUserId: randomUUID(), email: "tester@pilot.example", fullName: "Pia Tester", roleId: tester.role })
      await tx.insert(projectAccess).values({ companyId: DEMO, userAccountId: tester.id, projectId: harbor })
      // Seeded ones moved off the seed's word: a role renamed, Mads given Harbor too.
      await tx.update(role).set({ name: "Dispatch desk" }).where(eq(role.id, DEMO_IDS.roles.dispatcher))
      await tx.insert(projectAccess).values({ companyId: DEMO, userAccountId: DEMO_IDS.users.mads, projectId: harbor })
    })
    const before = await snapshot(DEMO)
    const keptRow = (snapshot: Snapshot, table: string, id: string) => snapshot[table].find((row) => row.id === id)
    const testerRows = (snapshot: Snapshot) => ({
      account: keptRow(snapshot, "user_account", tester.id),
      role: keptRow(snapshot, "role", tester.role),
      grants: snapshot.role_grant.filter((row) => row.role_id === tester.role),
      access: snapshot.project_access.filter((row) => row.user_account_id === tester.id),
    })

    const report = await resetToSeed(fresh.url, DEMO)

    const after = await snapshot(DEMO)
    assert.equal(report.otherAccounts, 1)
    assert.deepEqual(testerRows(after), testerRows(before), "the tester's account, role, grant and access, row for row, stamps and all")
    assert.deepEqual(keptRow(after, "user_account", DEMO_IDS.users.fares), keptRow(before, "user_account", DEMO_IDS.users.fares), "Fares's Login stays bound, and his row is not written")
    assert.equal(keptRow(after, "user_account", DEMO_IDS.users.fares)?.auth_user_id, login)
    assert.equal(keptRow(after, "user_account", DEMO_IDS.users.lars)?.deactivated_at, keptRow(before, "user_account", DEMO_IDS.users.lars)?.deactivated_at)
    assert.equal(keptRow(after, "role", DEMO_IDS.roles.dispatcher)?.name, keptRow(seeded, "role", DEMO_IDS.roles.dispatcher)?.name)
    const madsAccess = await owner.db
      .select({ projectId: projectAccess.projectId })
      .from(projectAccess)
      .where(and(eq(projectAccess.companyId, DEMO), eq(projectAccess.userAccountId, DEMO_IDS.users.mads)))
    assert.deepEqual(
      madsAccess.map((row) => row.projectId),
      [DEMO_IDS.projects.copenhagen],
    )
    assert.deepEqual(await snapshot(OTHER.company), otherBefore)
  })

  test("the script says what it swept, what it kept and what becomes of the outbox and pg-boss's jobs, and refuses a host that is not the local stack", async () => {
    const script = (env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/reset-to-seed.ts"], {
        cwd: PACKAGE,
        encoding: "utf8",
        env: { PATH: process.env.PATH, DATABASE_ADMIN_URL: fresh.url, ...env },
      })
    await owner.db.transaction(async (tx) => {
      await tx.update(customer).set({ name: "Renamed again" }).where(eq(customer.id, await seededId("customer")))
      await tx.update(company).set({ nextTicketNumber: 1001 }).where(eq(company.id, DEMO))
      await tx
        .insert(outboxEvent)
        .values({ companyId: DEMO, projectId: DEMO_IDS.projects.copenhagen, kind: "route-dispatched", aggregateKind: "route", aggregateId: randomUUID(), occurredAt: new Date(), payload: {} })
    })
    const before = await snapshot(DEMO)
    await queueJobs(OTHER.company)

    const done = script()
    assert.equal(done.status, 0, done.stderr)
    const said = done.stdout.split("\n")
    assert.deepEqual(said.slice(0, 2), ["Reset the demo company 01a0d2a4-a280-7001-8000-000000000001 on 127.0.0.1 to its seed, in one transaction.", sweptLine(before)])
    assert.match(said[2], /Kept Organisation & Access .* so every Login stays bound; the seeded rows are back at the seed's word, and 1 account the seed does not name is as it was\.$/)
    // Every swept row but the outbox's was the seed's, and comes back from it.
    assert.equal(said[3], `The seed wrote ${sweptRows(before) - 1} rows; the route, ticket and invoice counters were put back to 1000, 1000 and 1000, as a fresh seed leaves them.`)
    assert.deepEqual(said.slice(4), ["Outbox: 1 unpublished event went with the sweep and will never be relayed.", "pg-boss: no waiting job names the company.", ""])

    const settled = await snapshot(DEMO)
    await queueJobs(DEMO, DEMO)
    const again = script()
    assert.equal(again.status, 0, again.stderr)
    assert.deepEqual(again.stdout.split("\n").slice(1), [
      sweptLine(settled),
      "Kept Organisation & Access — the company, its projects, service providers, roles, grants, User Accounts and their access — so every Login stays bound; the seeded rows are back at the seed's word, and 1 account the seed does not name is as it was.",
      `The seed wrote ${sweptRows(settled)} rows; the route, ticket and invoice counters were already at 1000, 1000 and 1000, as a fresh seed leaves them.`,
      "Outbox: no unpublished event was swept.",
      "pg-boss: 2 waiting jobs still name the company and are left on their queues: when a worker takes one it meets a tenant without the rows it names, and either finds nothing to do or fails, is retried and ends failed — an outbox consumer's copy on outbox.dead, which is not to be redriven.",
      "",
    ])

    const hosted = script({ DATABASE_ADMIN_URL: "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-eu-north-1.pooler.supabase.com:5432/postgres" })
    assert.equal(hosted.status, 1)
    assert.match(hosted.stderr, /PILOT_SUPABASE_REF is not set: outside the protected workflow a Pilot operation runs against the local stack only/)
    assert.doesNotMatch(hosted.stderr + hosted.stdout, /secret/)
    assert.deepEqual(await snapshot(OTHER.company), otherBefore)
  })

  test("a reset that fails anywhere, a postcondition included, leaves the demo company as it was: the sweep and the seed are one transaction", async () => {
    await owner.db.transaction(async (tx) => {
      await tx.update(customer).set({ name: "Renamed before a failed reset" }).where(eq(customer.id, await seededId("customer")))
      await tx
        .insert(outboxEvent)
        .values({ companyId: DEMO, projectId: DEMO_IDS.projects.copenhagen, kind: "route-dispatched", aggregateKind: "route", aggregateId: randomUUID(), occurredAt: new Date(), payload: {} })
      await tx.update(company).set({ nextRouteNumber: 1042 }).where(eq(company.id, DEMO))
    })
    const before = await snapshot(DEMO)
    /** What a failed reset said: its own sentence, or the database's under Drizzle's wrapper (the way scripts/step.ts prints it). */
    const said = (error: unknown): string => {
      const { message, cause } = error as { message: string; cause?: { message?: string } }
      return cause?.message ?? message
    }
    // Each trigger lives on this file's own database, for the one reset it breaks.
    const breaking = async (body: string, when: "before" | "after", expected: RegExp) => {
      await owner.sql.unsafe(`create function public.reset_test_break() returns trigger language plpgsql as $$ begin ${body}; return new; end $$`)
      await owner.sql.unsafe(`create trigger reset_test_break ${when} insert on wms.customer for each row execute function public.reset_test_break()`)
      try {
        await assert.rejects(resetToSeed(fresh.url, DEMO), (error) => {
          assert.match(said(error), expected)
          return true
        })
      } finally {
        await owner.sql.unsafe("drop trigger reset_test_break on wms.customer")
        await owner.sql.unsafe("drop function public.reset_test_break()")
      }
      assert.deepEqual(await snapshot(DEMO), before)
    }
    // The seed refused halfway through writing the Registry back, after the sweep.
    await breaking("raise exception 'refused by the test'", "before", /refused by the test/)
    // The seed writes, and something moves what it wrote: the postcondition finds the seed with rows still to change.
    await breaking("update wms.customer set name = name || ' (moved)' where id = new.id", "after", /the seed found \d+ rows still to change after the reset, so the reset was rolled back/)
    assert.deepEqual(await snapshot(OTHER.company), otherBefore)
  })
})
