// The audit trail (#291, slice 9): every table of the schema is classified,
// once, as audited or exempt with a reason; every audited table carries the
// trigger in a migration and no exempt one does, the hot tables of execution
// among them; and, against a fresh database, the trigger writes what the
// schema says a row of the log is — the columns that moved and nothing for an
// update that moved none, a set's row under its parent, the actor and the
// reason the transaction carries, one transaction id per transaction, the
// company's counters ignored and its own delete not recorded — into a ledger
// the API role may append to and never rewrite, whose rows go with their
// company.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"

import { eq, getTableName, is, sql } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import * as schema from "../schema"
import { role, roleGrant, userAccount } from "../schema/access"
import { auditEvent } from "../schema/audit"
import { customer } from "../schema/customers"
import { company, project } from "../schema/organisation"
import { AUDIT_ROW_FUNCTION, AUDIT_TRAIL, AUDITED, auditTrail, EXEMPT } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack } from "./specimen"

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations")
const statements = new Set(
  readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .flatMap((file) => statementsOf(readFileSync(path.join(MIGRATIONS, file), "utf8"))),
)
const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable))
const nameOf = (table: PgTable) => getTableName(table)

describe("the audit trail's classification", () => {
  test("every table of the schema is audited or exempt, exactly once, and an exempt one says why", () => {
    const classified = [...AUDITED.map((entry) => nameOf(entry.table)), ...EXEMPT.map((entry) => nameOf(entry.table))]
    assert.equal(new Set(classified).size, classified.length, "a table is classified twice")
    assert.deepEqual([...classified].sort(), tables.map(nameOf).sort(), "every table, and only the schema's")
    for (const entry of EXEMPT) assert.ok(entry.why.length > 0, nameOf(entry.table))
  })

  test("a set's parent is an audited table, and the column naming it is the set's own", () => {
    const audited = new Set(AUDITED.map((entry) => nameOf(entry.table)))
    for (const entry of AUDITED) {
      if (entry.parent === undefined) continue
      assert.ok(audited.has(nameOf(entry.parent.table)), `${nameOf(entry.table)}'s parent ${nameOf(entry.parent.table)} is audited`)
      assert.equal(entry.parent.column.table, entry.table, `${nameOf(entry.table)} names its parent through its own column`)
    }
  })

  test("the hot tables are exempt: execution, generation, routing and the money the work makes", () => {
    const exempt = new Set(EXEMPT.map((entry) => nameOf(entry.table)))
    for (const hot of ["route", "pickup", "session", "plan", "plan_stop", "plan_leg", "routing_quota", "generation_run", "generation_match", "billable_event", "outbox_event", "ticket", "alert"]) assert.ok(exempt.has(hot), hot)
  })
})

describe("the audit trail in the migrations", () => {
  test("the function is written once, as the helper spells it", () => {
    assert.ok(statements.has(normalised(AUDIT_ROW_FUNCTION)), "wms.audit_row(), as AUDIT_ROW_FUNCTION spells it")
  })

  test("every audited table carries its trigger as auditTrail spells it, and no exempt table carries one", () => {
    const missing = AUDITED.flatMap(auditTrail).filter((statement) => !statements.has(normalised(statement)))
    assert.deepEqual(missing, [], `paste these into the migration:\n${missing.join("\n")}`)
    const onExempt = EXEMPT.filter((entry) => [...statements].some((statement) => statement.startsWith(`CREATE TRIGGER "${nameOf(entry.table)}_${AUDIT_TRAIL}"`)))
    assert.deepEqual(onExempt.map((entry) => nameOf(entry.table)), [])
  })
})

const database = databaseUnderTest()

const ID = {
  company: "018f7c2e-c000-7000-8000-000000000001",
  project: "018f7c2e-c000-7000-8000-000000000002",
  role: "018f7c2e-c000-7000-8000-000000000003",
  olivia: "018f7c2e-c000-7000-8000-000000000004",
  customer: "018f7c2e-c000-7000-8000-000000000005",
  grant: "018f7c2e-c000-7000-8000-000000000006",
}

/** A company with a project, a role and an account, written as the owner before the settings are made. */
async function seed(tx: Tx): Promise<void> {
  await tx.insert(company).values({ id: ID.company, companyId: ID.company, name: "Audit A/S", legalName: "Audit A/S", registrationNumber: "10000099", country: "DK", status: "active" })
  await tx.insert(project).values({ id: ID.project, companyId: ID.company, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(role).values({ id: ID.role, companyId: ID.company, key: null, name: "Desk", scope: "Company", description: "d", system: false })
  await tx.insert(userAccount).values({ id: ID.olivia, companyId: ID.company, email: "olivia@audit.example", fullName: "Olivia Larsen", roleId: ID.role, allProjects: true })
}

/** The transaction as a request's: the company, the actor and the reason set as the API's guard sets them, then the API role. */
async function asRequest(tx: Tx, reason: string | null = null): Promise<void> {
  await tx.execute(sql`select set_config('wms.company_id', ${ID.company}, true)`)
  await tx.execute(sql`select set_config('wms.user_account_id', ${ID.olivia}, true)`)
  if (reason !== null) await tx.execute(sql`select set_config('wms.change_reason', ${reason}, true)`)
  await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
}

const historyOf = (tx: Tx, rowId: string) => tx.select().from(auditEvent).where(eq(auditEvent.rowId, rowId)).orderBy(auditEvent.id)
/** What happened to the row after the seed wrote it: the seed's own inserts are history too, the owner's, with no actor. */
const changesOf = async (tx: Tx, rowId: string) => (await historyOf(tx, rowId)).filter((row) => row.action !== "insert")

describe("the audit trigger against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_audit_trail")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("a request's insert, update and delete are three rows: the values written, the columns that moved, the values it had — with the actor and the reason", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await asRequest(tx, "Moved to the housing association")
      await tx.insert(customer).values({ id: ID.customer, companyId: ID.company, kind: "organisation", name: "Østerbro Housing", email: "kontor@osterbro.example", status: "active" })
      await tx.update(customer).set({ name: "Østerbro Boligselskab" }).where(eq(customer.id, ID.customer))
      await tx.update(customer).set({ name: "Østerbro Boligselskab" }).where(eq(customer.id, ID.customer))
      await tx.delete(customer).where(eq(customer.id, ID.customer))
      const rows = await historyOf(tx, ID.customer)
      assert.deepEqual(rows.map((row) => row.action), ["insert", "update", "delete"], "an update that moved nothing is no row")
      const [inserted, updated, deleted] = rows
      assert.deepEqual(inserted.changed, {
        kind: [null, "organisation"],
        name: [null, "Østerbro Housing"],
        email: [null, "kontor@osterbro.example"],
        service_messages_allowed: [null, true],
        status: [null, "active"],
      }, "every column with a value, less the id, the tenant and the stamps")
      assert.deepEqual(updated.changed, { name: ["Østerbro Housing", "Østerbro Boligselskab"] })
      assert.deepEqual(deleted.changed, {
        kind: ["organisation", null],
        name: ["Østerbro Boligselskab", null],
        email: ["kontor@osterbro.example", null],
        service_messages_allowed: [true, null],
        status: ["active", null],
      }, "the row's last values")
      for (const row of rows) {
        assert.equal(row.tableName, "customer")
        assert.equal(row.companyId, ID.company)
        assert.equal(row.projectId, null, "a customer is company-wide")
        assert.equal(row.actorUserAccountId, ID.olivia)
        assert.equal(row.reason, "Moved to the housing association")
        assert.equal(row.parentTable, null)
      }
      assert.equal(new Set(rows.map((row) => row.transactionId)).size, 1, "one transaction, one id")
    })
  })

  test("a set's row is kept under its parent; a project-scoped row names its project; the worker's write has no actor and no reason", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await tx.execute(sql`select set_config('wms.company_id', ${ID.company}, true)`)
      await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
      await tx.insert(roleGrant).values({ id: ID.grant, companyId: ID.company, roleId: ID.role, moduleKey: "operate.tickets", action: "view" })
      await tx.update(project).set({ name: "Copenhagen North" }).where(eq(project.id, ID.project))
      const [grant] = await historyOf(tx, ID.grant)
      assert.deepEqual([grant.tableName, grant.parentTable, grant.parentId], ["role_grant", "role", ID.role])
      assert.deepEqual([grant.actorUserAccountId, grant.reason], [null, null])
      const [renamed] = await changesOf(tx, ID.project)
      assert.equal(renamed.tableName, "project")
      assert.deepEqual(renamed.changed, { name: ["Copenhagen Central", "Copenhagen North"] })
      const [seeded] = await historyOf(tx, ID.project)
      assert.deepEqual([seeded.action, seeded.actorUserAccountId], ["insert", null], "the owner's write, no actor")
    })
  })

  test("the company's document counters are no history: a run, a ticket or an invoice stepping one writes nothing, a rename does", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await asRequest(tx)
      await tx.update(company).set({ nextRouteNumber: sql`${company.nextRouteNumber} + 25`, nextTicketNumber: sql`${company.nextTicketNumber} + 1`, nextInvoiceNumber: sql`${company.nextInvoiceNumber} + 3` }).where(eq(company.id, ID.company))
      assert.deepEqual(await changesOf(tx, ID.company), [])
      await tx.update(company).set({ name: "Audit Renovation A/S", nextRouteNumber: sql`${company.nextRouteNumber} + 1` }).where(eq(company.id, ID.company))
      const [renamed] = await changesOf(tx, ID.company)
      assert.deepEqual(renamed.changed, { name: ["Audit A/S", "Audit Renovation A/S"] }, "the counter rode along unrecorded")
    })
  })

  test("the API role appends to the log and never rewrites it", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await asRequest(tx)
      await tx.insert(customer).values({ id: ID.customer, companyId: ID.company, kind: "person", name: "Mikkel", status: "active" })
      assert.equal((await historyOf(tx, ID.customer)).length, 1, "the API role's insert was appended")
      for (const rewrite of [sql`update wms.audit_event set reason = 'rewritten'`, sql`delete from wms.audit_event`]) {
        await assert.rejects(
          tx.transaction((savepoint) => savepoint.execute(rewrite)),
          refusedWith("42501", /permission denied for table audit_event/),
        )
      }
    })
  })

  test("a company's trail goes with the company, and the company's own delete is not recorded", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await tx.execute(sql`select set_config('wms.company_id', ${ID.company}, true)`)
      await tx.insert(customer).values({ id: ID.customer, companyId: ID.company, kind: "person", name: "Mikkel", status: "active" })
      assert.ok((await tx.select().from(auditEvent).where(eq(auditEvent.companyId, ID.company))).length > 0)
      await tx.delete(customer).where(eq(customer.companyId, ID.company))
      await tx.delete(userAccount).where(eq(userAccount.companyId, ID.company))
      await tx.delete(role).where(eq(role.companyId, ID.company))
      await tx.delete(project).where(eq(project.companyId, ID.company))
      await tx.delete(company).where(eq(company.id, ID.company))
      assert.deepEqual(await tx.select().from(auditEvent).where(eq(auditEvent.companyId, ID.company)), [])
    })
  })
})
