// The row lock a rule the caller holds is judged under (`lockRow`,
// commands/shared.ts), against Postgres as the API's role (#335). Taken
// `for no key update`, it serialises two writers of one project's set — the
// second waits until the first is done — and lets an insert whose key names
// the project go on meanwhile, since a foreign key's check takes only
// `for key share` on the row it names. Taken `for update`, as a caller that
// changes a key column of the row does, it holds that insert back too.
//
// Each wait is bounded by `lock_timeout`, so a lock that blocks fails the
// statement (55P03) rather than hanging the test.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"

import { createDb, type Database, type Tx } from "../client"
import { lockRow, type LockStrength } from "../commands/shared"
import { migrateDatabase } from "../migrate"
import { company, project } from "../schema/organisation"
import { ticketSla } from "../schema/resolution"
import { sqlstate } from "../sqlstate"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, withDatabaseName, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const COMPANY = "018f7c2e-c000-7000-8000-000000000001"
const PROJECT = "018f7c2e-c000-7000-8000-000000000002"
const SLA = "018f7c2e-c000-7000-8000-000000000003"
const LOCK_NOT_AVAILABLE = "55P03"

/** Thrown to end a transaction without keeping what it wrote. */
class Rollback extends Error {}

/** The error's SQLSTATE, through Drizzle's wrapper. */
const codeOf = (error: unknown): string | undefined => sqlstate(error)?.code

describe("lockRow against Postgres, as the API's role", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  let api: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_row_lock")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 1 })
    await owner.db.insert(company).values({ id: COMPANY, companyId: COMPANY, name: "Company c", legalName: "Company c A/S", registrationNumber: "1000000c", country: "DK", status: "active" })
    await owner.db.insert(project).values({ id: PROJECT, companyId: COMPANY, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
    api = createDb(withDatabaseName(database.appUrl, fresh.name), { max: 3 })
  })
  after(async () => {
    await api?.close()
    await owner?.close()
    await fresh?.drop()
  })

  /** Runs `fn` in a transaction of the company under a bounded wait for any lock, and rolls back whatever it wrote. */
  const meanwhile = (fn: (tx: Tx) => Promise<unknown>, wait = "300ms"): Promise<void> =>
    withCompany(api.db, COMPANY, async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${wait}'`))
      await fn(tx)
      throw new Rollback()
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error
    })

  /** Holds the project's row lock at `strength` while `fn` runs on other connections, then lets it go. */
  const holding = (strength: LockStrength, fn: () => Promise<void>): Promise<void> =>
    withCompany(api.db, COMPANY, async (tx) => {
      await lockRow(tx, project, { companyId: COMPANY, id: PROJECT }, strength)
      await fn()
    })

  const insertChild = (tx: Tx) => tx.insert(ticketSla).values({ id: SLA, companyId: COMPANY, projectId: PROJECT, kind: null, priority: "high", hours: 24 })

  test("by default, an insert whose key names the locked project goes on while the lock is held", () =>
    holding("no key update", async () => {
      await meanwhile(async (tx) => {
        await insertChild(tx)
      })
    }))

  test("by default, a second writer of the project's set waits for the first: it times out while the lock is held, and takes the lock once it is let go", async () => {
    let second: Promise<void> | undefined
    let settled = false
    await holding("no key update", async () => {
      await assert.rejects(
        meanwhile((tx) => lockRow(tx, project, { companyId: COMPANY, id: PROJECT })),
        (error) => codeOf(error) === LOCK_NOT_AVAILABLE,
      )
      // The same lock again, now with time to wait: it waits for this transaction to end.
      second = meanwhile((tx) => lockRow(tx, project, { companyId: COMPANY, id: PROJECT }), "10s").finally(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(settled, false, "the second writer is still waiting on the first")
    })
    await second
    assert.equal(settled, true)
  })

  test("`update`, for a caller that changes a key column of the row, holds the insert back too", () =>
    holding("update", async () => {
      await assert.rejects(
        meanwhile(async (tx) => {
          await insertChild(tx)
        }),
        (error) => codeOf(error) === LOCK_NOT_AVAILABLE,
      )
    }))
})
