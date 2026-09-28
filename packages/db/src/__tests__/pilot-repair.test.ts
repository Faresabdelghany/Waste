// The repair runner (Issue #152): one allow-listed module, resolved from a
// manifest and never from a path, run as precondition → apply → postcondition
// in one owner transaction under the migration lock, and safe to run again.
// The specimen repair mends rows of a table the test makes in a fresh
// database; the manifest is the test's own, the way the workflow's is
// scripts/repairs/index.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { sql as drizzleSql } from "drizzle-orm"

import { createDb } from "../client"
import { runRepair, type Repair, type RepairManifest } from "../pilot/repair"
import { databaseUnderTest, withFreshDatabase } from "./database"

const specimen = (overrides: Partial<Repair> = {}): Repair => ({
  issue: 152,
  description: "mark the specimen rows fixed",
  precondition: async (tx) => (await tx.execute(drizzleSql`select count(*)::int as n from public.repair_specimen where not fixed`)).at(0)?.n !== 0,
  apply: async (tx) => {
    await tx.execute(drizzleSql`update public.repair_specimen set fixed = true where not fixed`)
  },
  postcondition: async (tx) =>
    (await tx.execute(drizzleSql`select (count(*) filter (where not fixed) = 0 and count(*) > 0) as done from public.repair_specimen`)).at(0)?.done === true,
  ...overrides,
})
const manifest = (repair: Repair): RepairManifest => ({ "152-mark-specimen-fixed": async () => repair })

const database = databaseUnderTest()

describe("runRepair refuses before it connects", () => {
  test("an id that is not <issue>-<slug>, and one the manifest does not list", async () => {
    await assert.rejects(runRepair("postgresql://postgres:pw@127.0.0.1:1/postgres", "../../etc", manifest(specimen())), /is not an allow-listed repair id/)
    await assert.rejects(runRepair("postgresql://postgres:pw@127.0.0.1:1/postgres", "152-not-listed", manifest(specimen())), /No active repair is named 152-not-listed/)
    await assert.rejects(runRepair("postgresql://postgres:pw@127.0.0.1:1/postgres", "toString", manifest(specimen())), /is not an allow-listed repair id/)
  })
})

describe("runRepair on a database", { skip: database.skip }, () => {
  test("applies a needed repair, then finds it applied, and refuses a state that is neither", () =>
    withFreshDatabase(database.adminUrl, "waste_repair", async (url) => {
      const owner = createDb(url, { max: 1 })
      try {
        await owner.sql`create table public.repair_specimen (id int primary key, fixed boolean not null)`
        await owner.sql`insert into public.repair_specimen values (1, false), (2, true)`
        assert.equal(await runRepair(url, "152-mark-specimen-fixed", manifest(specimen())), "applied")
        const [{ unfixed }] = await owner.sql<{ unfixed: number }[]>`select count(*) filter (where not fixed)::int as unfixed from public.repair_specimen`
        assert.equal(unfixed, 0)
        assert.equal(await runRepair(url, "152-mark-specimen-fixed", manifest(specimen())), "already-applied")

        await owner.sql`delete from public.repair_specimen`
        await assert.rejects(runRepair(url, "152-mark-specimen-fixed", manifest(specimen())), /Neither the precondition nor the postcondition of 152-mark-specimen-fixed holds: refusing to write/)
      } finally {
        await owner.close()
      }
    }))

  test("rolls back an apply whose postcondition does not hold, and refuses a module that names another issue", () =>
    withFreshDatabase(database.adminUrl, "waste_repair_rollback", async (url) => {
      const owner = createDb(url, { max: 1 })
      try {
        await owner.sql`create table public.repair_specimen (id int primary key, fixed boolean not null)`
        await owner.sql`insert into public.repair_specimen values (1, false), (2, false)`
        const halfway = specimen({
          apply: async (tx) => {
            await tx.execute(drizzleSql`update public.repair_specimen set fixed = true where id = 1`)
          },
        })
        await assert.rejects(runRepair(url, "152-mark-specimen-fixed", manifest(halfway)), /postcondition of 152-mark-specimen-fixed does not hold after it applied: rolled back/)
        const [{ unfixed }] = await owner.sql<{ unfixed: number }[]>`select count(*) filter (where not fixed)::int as unfixed from public.repair_specimen`
        assert.equal(unfixed, 2, "the half-applied write was rolled back")

        await assert.rejects(runRepair(url, "152-mark-specimen-fixed", manifest(specimen({ issue: 153 }))), /152-mark-specimen-fixed names issue 153/)
      } finally {
        await owner.close()
      }
    }))
})
