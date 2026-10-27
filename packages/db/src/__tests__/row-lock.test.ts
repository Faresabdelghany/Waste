// The row lock a rule the caller holds is judged under (`lockRow`, and
// `lockRows` for several rows; commands/shared.ts), against Postgres as the
// API's role (#335). Taken `for no key update`, it serialises two writers of
// one project's set — the second waits until the first is done — and lets an
// insert whose key names the project go on meanwhile, since a foreign key's
// check takes only `for key share` on the row it names. Taken `for update`,
// as a caller that changes a key column of the row does, it holds that
// insert back too.
//
// A wait that should not happen is bounded by `lock_timeout`, so a lock that
// blocks fails the statement (55P03) rather than hanging the test.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"

import { createDb, type Database, type Tx } from "../client"
import { lockRow, lockRows, type LockStrength } from "../commands/shared"
import { migrateDatabase } from "../migrate"
import { company, project } from "../schema/organisation"
import { ticketSla } from "../schema/resolution"
import { sqlstate } from "../sqlstate"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, withDatabaseName, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const COMPANY = "018f7c2e-c000-7000-8000-000000000001"
const PROJECT = "018f7c2e-c000-7000-8000-000000000002"
const OTHER_PROJECT = "018f7c2e-c000-7000-8000-000000000003"
const SLA = "018f7c2e-c000-7000-8000-000000000004"
const LOCK_NOT_AVAILABLE = "55P03"

/** Thrown to end a transaction without keeping what it wrote. */
class Rollback extends Error {}

/** The error's SQLSTATE, through Drizzle's wrapper. */
const codeOf = (error: unknown): string | undefined => sqlstate(error)?.code
const timedOut = (error: unknown) => codeOf(error) === LOCK_NOT_AVAILABLE

describe("lockRow and lockRows against Postgres, as the API's role", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  let api: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_row_lock")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 1 })
    await owner.db.insert(company).values({ id: COMPANY, companyId: COMPANY, name: "Company c", legalName: "Company c A/S", registrationNumber: "1000000c", country: "DK", status: "active" })
    const place = { companyId: COMPANY, kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" } as const
    await owner.db.insert(project).values([
      { id: PROJECT, name: "Copenhagen Central", ...place },
      { id: OTHER_PROJECT, name: "Nordhavn", ...place },
    ])
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

  /** Takes `lock` in a transaction of the company and holds it while `fn` runs on other connections, then commits. */
  const holding = (lock: (tx: Tx) => Promise<void>, fn: () => Promise<void>): Promise<void> =>
    withCompany(api.db, COMPANY, async (tx) => {
      await lock(tx)
      await fn()
    })
  const projectLock = (strength?: LockStrength) => (tx: Tx) => lockRow(tx, project, { companyId: COMPANY, id: PROJECT }, strength)
  const bothProjects = (tx: Tx) => lockRows(tx, project, COMPANY, [OTHER_PROJECT, PROJECT])

  const insertChild = (tx: Tx, projectId = PROJECT) => tx.insert(ticketSla).values({ id: SLA, companyId: COMPANY, projectId, kind: null, priority: "high", hours: 24 })

  /** Resolves once a backend of this database waits on a lock, as the owner sees it; fails after five seconds. */
  async function someoneWaits(): Promise<void> {
    const until = Date.now() + 5000
    for (;;) {
      const [{ waiting }] = await owner.sql<{ waiting: number }[]>`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
      if (waiting > 0) return
      assert.ok(Date.now() < until, "no backend came to wait on a lock")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  test("by default, an insert whose key names the locked project goes on while the lock is held", () =>
    holding(projectLock(), async () => {
      await meanwhile(async (tx) => {
        await insertChild(tx)
      })
    }))

  test("by default, a second writer of the project's set waits on the first's lock, and is granted it only once the first lets it go", async () => {
    let letGo = false
    let grantedAfterLetGo: boolean | undefined
    let second: Promise<void> | undefined
    await holding(projectLock(), async () => {
      await assert.rejects(meanwhile(projectLock()), timedOut)
      // The same lock again, now with time to wait: Postgres shows it waiting, and it is granted after this transaction ends.
      second = meanwhile(async (tx) => {
        await projectLock()(tx)
        grantedAfterLetGo = letGo
      }, "10s")
      await someoneWaits()
      letGo = true
    })
    await second
    assert.equal(grantedAfterLetGo, true)
  })

  test("`update`, for a caller that changes a key column of the row, holds the insert back too", () =>
    holding(projectLock("update"), async () => {
      await assert.rejects(
        meanwhile(async (tx) => {
          await insertChild(tx)
        }),
        timedOut,
      )
    }))

  test("lockRows holds each row it names against another writer, and lets an insert naming one of them go on", () =>
    holding(bothProjects, async () => {
      await assert.rejects(
        meanwhile((tx) => lockRow(tx, project, { companyId: COMPANY, id: OTHER_PROJECT })),
        timedOut,
      )
      await assert.rejects(meanwhile(bothProjects), timedOut)
      await meanwhile(async (tx) => {
        await insertChild(tx, OTHER_PROJECT)
      })
    }))
})
