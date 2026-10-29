// The public door's migrations — the Sorting Guide's 0017, the Collection Days' 0021 and the Drop-off Points' — against Postgres (Issue #293, ADR-0010), on a fresh database
// of this file's own: the public role as the catalog shows it, the exact
// columns it may read and the nothing else it may do, and what a public
// transaction (`withPublishedProject`) sees — a published project's own
// published rows, never a draft, an unpublished project or another company.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { getTableName, sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { columnName } from "../names"
import { withPublishedProject } from "../public-door"
import { API_ROLE, PUBLIC_ROLE } from "../roles"
import { wasteFraction } from "../schema/catalogue"
import { company, project } from "../schema/organisation"
import { dropOffPoint, dropOffPointHours } from "../schema/drop-off-points"
import { sortingGuideItem } from "../schema/sorting-guide"
import { PUBLIC_DOOR_TABLES } from "../sql/public-door"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

/** A refusal for want of a privilege (42501), wherever drizzle and postgres.js put the SQLSTATE. */
const insufficientPrivilege = (error: { cause?: { code?: string }; code?: string }): boolean => (error.cause?.code ?? error.code) === "42501"

/** Two companies of this file's own, a nibble telling them apart. */
const companyId = (n: "a" | "b") => `018f7c34-${n}000-7000-8000-000000000001`
const projectId = (n: "a" | "b", m: 1 | 2) => `018f7c34-${n}00${m}-7000-8000-000000000002`
const fractionId = (n: "a" | "b") => `018f7c34-${n}000-7000-8000-000000000003`
const itemId = (n: "a" | "b", m: number) => `018f7c34-${n}00${m}-7000-8000-000000000004`
const pointId = (n: "a" | "b", m: number) => `018f7c34-${n}00${m}-7000-8000-000000000005`

/** The columns the door names, as `table.column`, sorted: what the role must read and all it may. */
const allowedColumns = (): string[] =>
  PUBLIC_DOOR_TABLES.flatMap(({ table, columns }) => columns.map((column) => `${getTableName(table)}.${columnName(column)}`)).sort()

describe("migration 0017, the public door's role", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_public_door_test")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
    const row = (n: "a" | "b") => ({ id: companyId(n), companyId: companyId(n), name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `3000000${n === "a" ? 1 : 2}`, country: "DK", status: "active" })
    const projectRow = (n: "a" | "b", m: 1 | 2, publicSlug: string | null) => ({
      id: projectId(n, m),
      companyId: companyId(n),
      name: `Project ${n}${m}`,
      kind: "Municipality",
      language: "da",
      currency: "DKK",
      timezone: "Europe/Copenhagen",
      status: "active",
      publicSlug,
    })
    await owner.db.insert(company).values([row("a"), row("b")])
    await owner.db.insert(project).values([projectRow("a", 1, "door-a"), projectRow("a", 2, null), projectRow("b", 1, "door-b")])
    await owner.db.insert(wasteFraction).values([
      { id: fractionId("a"), companyId: companyId("a"), key: "glass", name: "Glas" },
      { id: fractionId("b"), companyId: companyId("b"), key: "glass", name: "Glass" },
    ])
    const item = (n: "a" | "b", m: number, p: 1 | 2, status: string) => ({
      id: itemId(n, m),
      companyId: companyId(n),
      projectId: projectId(n, p),
      name: `Item ${n}${m}`,
      synonyms: ["thing"],
      wasteFractionId: fractionId(n),
      instructions: "Rinse it",
      status,
    })
    await owner.db.insert(sortingGuideItem).values([item("a", 1, 1, "published"), item("a", 2, 1, "draft"), item("a", 3, 1, "withdrawn"), item("a", 4, 2, "published"), item("b", 1, 1, "published")])
    const point = (n: "a" | "b", m: number, p: 1 | 2, status: string) => ({
      id: pointId(n, m),
      companyId: companyId(n),
      projectId: projectId(n, p),
      code: `GS-${n}${m}`,
      name: `Point ${n}${m}`,
      kind: "recycling-centre",
      address: "Vej 1",
      location: { type: "Point" as const, coordinates: [12.5683, 55.6761] as [number, number] },
      status,
      notes: "The office's own",
    })
    await owner.db.insert(dropOffPoint).values([point("a", 1, 1, "active"), point("a", 2, 1, "draft"), point("a", 3, 1, "closed"), point("a", 4, 2, "active"), point("b", 1, 1, "active")])
    await owner.db.insert(dropOffPointHours).values(
      [pointId("a", 1), pointId("a", 2), pointId("a", 4)].map((id) => ({ companyId: companyId("a"), projectId: id === pointId("a", 4) ? projectId("a", 2) : projectId("a", 1), dropOffPointId: id, weekday: "monday", opensAt: "10:00", closesAt: "18:00" })),
    )
  })

  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("is a role that logs in as nobody, inherits nothing, bypasses nothing, and that the API's role may SET and does not inherit", async () => {
    const [attributes] = await owner.sql<{ login: boolean; inherit: boolean; bypassrls: boolean; superuser: boolean; createrole: boolean; replication: boolean; api_set: boolean; api_inherits: boolean; owner_member: boolean }[]>`
      select r.rolcanlogin as login, r.rolinherit as inherit, r.rolbypassrls as bypassrls, r.rolsuper as superuser, r.rolcreaterole as createrole, r.rolreplication as replication,
        pg_has_role(${API_ROLE}, ${PUBLIC_ROLE}, 'SET') as api_set,
        pg_has_role(${API_ROLE}, ${PUBLIC_ROLE}, 'USAGE') as api_inherits,
        pg_has_role(current_user, ${PUBLIC_ROLE}, 'MEMBER') as owner_member
      from pg_roles r where r.rolname = ${PUBLIC_ROLE}`
    assert.deepEqual(attributes, { login: false, inherit: false, bypassrls: false, superuser: false, createrole: false, replication: false, api_set: true, api_inherits: false, owner_member: true })
    const [schema] = await owner.sql<{ usage: boolean; create: boolean }[]>`
      select has_schema_privilege(${PUBLIC_ROLE}, 'wms', 'USAGE') as usage, has_schema_privilege(${PUBLIC_ROLE}, 'wms', 'CREATE') as create`
    assert.deepEqual(schema, { usage: true, create: false })
  })

  test("may SELECT exactly the columns the door names, and nothing else of any wms table: no other column, no write, no table created later", async () => {
    const readable = await owner.sql<{ column: string }[]>`
      select c.relname || '.' || a.attname as column
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'wms' and c.relkind in ('r', 'v', 'm', 'p') and has_column_privilege(${PUBLIC_ROLE}, c.oid, a.attnum, 'SELECT')
      order by 1`
    assert.deepEqual(
      readable.map((row) => row.column),
      allowedColumns(),
    )
    const rights = await owner.sql<{ table: string }[]>`
      select c.relname as table
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind in ('r', 'p')
        and (has_table_privilege(${PUBLIC_ROLE}, c.oid, 'SELECT') or has_table_privilege(${PUBLIC_ROLE}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
      order by 1`
    assert.deepEqual(rights.map((row) => row.table), [], "no table-wide right on any table: the column grants are all it has")
    const sequences = await owner.sql<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and case when c.relkind = 'S' then has_sequence_privilege(${PUBLIC_ROLE}, c.oid, 'USAGE, SELECT, UPDATE') else false end`
    assert.deepEqual(sequences.map((row) => row.name), [])
    await owner.sql.begin(async (tx) => {
      await tx`create table wms.public_door_specimen_later (id int)`
      const [later] = await tx<{ select: boolean }[]>`select has_table_privilege(${PUBLIC_ROLE}, 'wms.public_door_specimen_later', 'SELECT') as select`
      assert.deepEqual(later, { select: false })
      await tx`drop table wms.public_door_specimen_later`
    })
  })

  test("reads no column of a table about people, agreements, money or tickets: customers, parties, contacts, accounts, agreements, prices, events, invoices, tickets and alerts stay the office's (#293)", async () => {
    const forbidden = await owner.sql<{ column: string }[]>`
      select c.relname || '.' || a.attname as column
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'wms' and c.relkind in ('r', 'p')
        and (c.relname in ('customer', 'user_account', 'agreement', 'product', 'billable_event', 'billing_run', 'invoice', 'invoice_line', 'ticket', 'ticket_event', 'alert', 'service_provider', 'settlement', 'proof_of_service', 'session', 'driver')
          or c.relname like '%party%' or c.relname like '%contact%' or c.relname like 'price%')
        and has_column_privilege(${PUBLIC_ROLE}, c.oid, a.attnum, 'SELECT')`
    assert.deepEqual(forbidden.map((row) => row.column), [])
    const property = await owner.sql<{ column: string }[]>`
      select a.attname as column from pg_attribute a where a.attrelid = 'wms.property'::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege(${PUBLIC_ROLE}, a.attrelid, a.attnum, 'SELECT') order by 1`
    assert.deepEqual(property.map((row) => row.column), ["address", "company_id", "id", "project_id"], "a property's address and keys, never its name, notes or location")
    const point = await owner.sql<{ column: string }[]>`
      select a.attname as column from pg_attribute a where a.attrelid = 'wms.drop_off_point'::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege(${PUBLIC_ROLE}, a.attrelid, a.attnum, 'SELECT') order by 1`
    assert.deepEqual(
      point.map((row) => row.column),
      ["address", "closed_on_holidays", "company_id", "id", "kind", "location", "name", "open_always", "project_id", "public_note", "status"],
      "a drop-off point as the map draws it, never its code or the office's notes (#293 M3)",
    )
  })

  test("a published project's slug opens its own published items and its company's fractions, and nothing of a draft, a withdrawn item, an unpublished project or the other company", async () => {
    const seen = await withPublishedProject(owner.db, "door-a", async (tx, published) => {
      const items = await tx.select({ id: sortingGuideItem.id }).from(sortingGuideItem).orderBy(sortingGuideItem.id)
      const fractions = await tx.select({ id: wasteFraction.id }).from(wasteFraction)
      const projects = await tx.select({ id: project.id }).from(project).orderBy(project.id)
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`)
      return { published, items: items.map((row) => row.id), fractions: fractions.map((row) => row.id), projects: projects.map((row) => row.id), role: role?.role }
    })
    assert.deepEqual(seen, {
      published: { id: projectId("a", 1), companyId: companyId("a"), name: "Project a1", language: "da", timezone: "Europe/Copenhagen", slug: "door-a", branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } },
      items: [itemId("a", 1)],
      fractions: [fractionId("a")],
      projects: [projectId("a", 1), projectId("b", 1)],
      role: PUBLIC_ROLE,
    })
  })

  test("a published project's slug opens its own active drop-off points and their hours, and nothing of a draft or closed point, an unpublished project or the other company (#293 M3)", async () => {
    const seen = await withPublishedProject(owner.db, "door-a", async (tx) => {
      const points = await tx.select({ id: dropOffPoint.id }).from(dropOffPoint).orderBy(dropOffPoint.id)
      const hours = await tx.select({ id: dropOffPointHours.dropOffPointId }).from(dropOffPointHours).orderBy(dropOffPointHours.dropOffPointId)
      return { points: points.map((row) => row.id), hours: hours.map((row) => row.id) }
    })
    assert.deepEqual(seen, { points: [pointId("a", 1)], hours: [pointId("a", 1)] }, "not the draft's hours, not the unpublished project's point")
  })

  test("a slug no project publishes under opens nothing, and the transaction never runs", async () => {
    let ran = false
    const answer = await withPublishedProject(owner.db, "no-such-door", async () => {
      ran = true
      return "ran"
    })
    assert.equal(answer, undefined)
    assert.equal(ran, false)
  })

  test("inside the door a column it was not granted is refused (42501), and so is a write, even to a table it reads", async () => {
    await assert.rejects(
      withPublishedProject(owner.db, "door-a", (tx) => tx.execute(sql`select status from wms.project`)),
      insufficientPrivilege,
    )
    await assert.rejects(
      withPublishedProject(owner.db, "door-a", (tx) => tx.execute(sql`update wms.sorting_guide_item set name = 'Changed'`)),
      insufficientPrivilege,
    )
  })

  test("the role ends with the transaction: the next statement on the connection is the connection's own role again", async () => {
    await withPublishedProject(owner.db, "door-a", async () => undefined)
    const [after] = await owner.sql<{ role: string }[]>`select current_user as role`
    assert.notEqual(after?.role, PUBLIC_ROLE)
  })
})
