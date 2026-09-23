import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { eq, sql, and } from "drizzle-orm"
import { text, uuid } from "drizzle-orm/pg-core"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { validOn } from "../query/valid-on"
import { id, tenant, validity, validPeriod } from "../schema/columns"
import { wms } from "../schema/wms"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { databaseUnderTest } from "./database"
import { refusedWith, withSpecimen, type Tx } from "./specimen"

const database = databaseUnderTest()

// An effective-dated record: which container an agreement covered, and when.
const specimen = wms.table(
  "specimen_validity",
  { ...id, ...tenant, ...validity, containerId: uuid().notNull(), label: text().notNull() },
  (columns) => [validPeriod(columns)],
)

const companyA = "018f7c2e-0000-7000-8000-00000000000a"
const companyB = "018f7c2e-0000-7000-8000-00000000000b"
const bin = "018f7c2e-0000-7000-8000-0000000000c1"
const otherBin = "018f7c2e-0000-7000-8000-0000000000c2"

describe("effective dating against the database", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  /** The specimen table with its exclusion constraint, as a migration would create it. */
  const inSpecimen = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withSpecimen(admin.db, { specimen }, async (tx) => {
      for (const statement of excludeOverlapping(specimen, [specimen.containerId])) await tx.execute(sql.raw(statement))
      return fn(tx)
    })

  const period = (label: string, validFrom: string, validTo: string | null, companyId = companyA, containerId = bin) => ({
    companyId,
    containerId,
    label,
    validFrom,
    validTo,
  })

  test("two periods of one key that overlap are refused with 23P01, naming the constraint; adjacent periods are not", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values(period("first quarter", "2026-01-01", "2026-04-01"))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("overlapping", "2026-03-15", "2026-06-01"))),
        refusedWith("23P01", /specimen_validity_no_overlap/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("inside", "2026-02-01", "2026-03-01"))),
        refusedWith("23P01", /specimen_validity_no_overlap/),
      )
      // Ends on the day the next starts: half-open, no overlap.
      await tx.insert(specimen).values(period("second quarter", "2026-04-01", "2026-07-01"))
      await tx.insert(specimen).values(period("before", "2025-10-01", "2026-01-01"))
      assert.equal((await tx.select().from(specimen)).length, 3)
    }))

  test("an open-ended period blocks every later start for its key, and is itself blocked by any period it would cover", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values(period("ongoing", "2026-01-01", null))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("years later", "2031-01-01", "2032-01-01"))),
        refusedWith("23P01", /specimen_validity_no_overlap/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("also ongoing", "2027-01-01", null))),
        refusedWith("23P01", /specimen_validity_no_overlap/),
      )
      // Ending when the open-ended one starts is fine.
      await tx.insert(specimen).values(period("earlier", "2025-01-01", "2026-01-01"))
    }))

  test("the key is the company and the business key together: another container or another company may overlap freely", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values([
        period("bin", "2026-01-01", null),
        period("other bin", "2026-01-01", null, companyA, otherBin),
        period("same bin, other company", "2026-01-01", null, companyB, bin),
      ])
      assert.equal((await tx.select().from(specimen)).length, 3)
    }))

  test("validPeriod refuses an empty or inverted period with 23514, which the exclusion constraint alone would let through", () =>
    inSpecimen(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("empty", "2026-01-01", "2026-01-01"))),
        refusedWith("23514", /specimen_validity_validity/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values(period("inverted", "2026-02-01", "2026-01-01"))),
        refusedWith("23514", /specimen_validity_validity/),
      )
      // Without the check, an empty range overlaps nothing: the reason the check is mandatory.
      const [row] = await tx.execute<{ overlaps: boolean }>(
        sql`select daterange('2026-01-01', '2026-01-01', '[)') && daterange('2025-01-01', null, '[)') as overlaps`,
      )
      assert.equal(row.overlaps, false)
    }))

  test("validOn returns exactly the row valid on a day: the start day included, the end day excluded, the open end unbounded", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values([
        period("q1", "2026-01-01", "2026-04-01"),
        period("q2", "2026-04-01", "2026-07-01"),
        period("onwards", "2026-07-01", null),
      ])
      const labelsOn = async (day: string): Promise<string[]> => {
        const rows = await tx
          .select({ label: specimen.label })
          .from(specimen)
          .where(and(eq(specimen.containerId, bin), validOn(specimen, day)))
        return rows.map((row) => row.label)
      }
      assert.deepEqual(await labelsOn("2025-12-31"), [])
      assert.deepEqual(await labelsOn("2026-01-01"), ["q1"])
      assert.deepEqual(await labelsOn("2026-03-31"), ["q1"])
      assert.deepEqual(await labelsOn("2026-04-01"), ["q2"])
      assert.deepEqual(await labelsOn("2026-06-30"), ["q2"])
      assert.deepEqual(await labelsOn("2026-07-01"), ["onwards"])
      assert.deepEqual(await labelsOn("2099-12-31"), ["onwards"])
    }))

  test("validOn takes a SQL date expression too, and refuses a day that is not YYYY-MM-DD before the database sees it", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values(period("q1", "2026-01-01", "2026-04-01"))
      const rows = await tx
        .select({ label: specimen.label })
        .from(specimen)
        .where(validOn(specimen, sql`date '2026-02-01' + interval '1 month'`))
      assert.deepEqual(rows, [{ label: "q1" }])
      assert.throws(() => validOn(specimen, "Jan 1 2026"), /validOn: "Jan 1 2026" is not a YYYY-MM-DD day/)
      assert.throws(() => validOn(specimen, "2026-1-1"), /validOn: "2026-1-1" is not a YYYY-MM-DD day/)
    }))

  test("the validity columns travel as YYYY-MM-DD strings through the Drizzle face", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values(period("q1", "2026-01-01", "2026-04-01"))
      const [row] = await tx.select({ validFrom: specimen.validFrom, validTo: specimen.validTo }).from(specimen)
      assert.deepEqual(row, { validFrom: "2026-01-01", validTo: "2026-04-01" })
    }))
})
