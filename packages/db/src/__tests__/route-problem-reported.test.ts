// A problem on the route given a kind of its own (F2 of #574), as migration
// 0114 writes it and as it moves what a database holds of the old pair: the
// file is drizzle-kit's change to the outbox's kind check and then the
// statements of `sql/route-problem-kind.ts`, verbatim; on a fresh database
// those statements send again every job of the old pair not done, give every
// row of the old pair the new kind and leave a stop's problem alone, and the
// trigger writes the previous API's insert of the old pair as the new kind.
// The file is found by its name, not its number. A rendering test lives until
// its migration merges (migrations/README.md), and this one with it.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"

import { createDb, type Database, type Tx } from "../client"
import { MIGRATIONS_FOLDER, migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { company, project } from "../schema/organisation"
import { normalised, statementsOf } from "../sql/hand-written"
import { resendRouteProblems, ROUTE_PROBLEM_TRIGGER, routeProblemKind, routeProblemStatements } from "../sql/route-problem-kind"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { rolledBack } from "./specimen"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_route_problem_reported\.sql$/.test(name))
  assert.ok(file !== undefined, "the route problem's own kind")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the route problem's own kind, as the migration writes it", () => {
  test("is drizzle-kit's change to the outbox's kind check, and then the statements that move the old pair, verbatim", async () => {
    const name = await migrationName()
    const own = name.slice(0, 4)
    const generated = await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))
    assert.equal(generated.length, 2, "the kind check dropped and added again")
    assert.match(generated[1], /'route-reassigned', 'route-problem-reported', 'pickup-completed'/)
    assert.deepEqual(statementsOf(await readFile(join(MIGRATIONS_FOLDER, name), "utf8")), [...generated, ...routeProblemStatements()].map(normalised))
  })
})

const database = databaseUnderTest()

const COMPANY = "018f7c2e-c000-7000-8000-0000000000c1"
const PROJECT = "018f7c2e-c000-7000-8000-0000000000c2"
/** The rows of the old pair, by what became of their jobs: worked, waiting, dead-lettered, retrying, never relayed; and a stop's problem waiting. */
const ROW = {
  worked: "018f7c2e-c000-7000-8000-0000000000a1",
  waiting: "018f7c2e-c000-7000-8000-0000000000a2",
  dead: "018f7c2e-c000-7000-8000-0000000000a3",
  retrying: "018f7c2e-c000-7000-8000-0000000000a4",
  unrelayed: "018f7c2e-c000-7000-8000-0000000000a5",
  onStop: "018f7c2e-c000-7000-8000-0000000000a6",
} as const

const OLD_QUEUE = "outbox.pickup-problem-reported.resolution"
const DEAD = "outbox.dead"

describe("the route problem's own kind against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_route_problem")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** A company and a project, and the two queues an old pair's job waited on, written as the owner. */
  async function seed(tx: Tx): Promise<void> {
    await tx.insert(company).values({ id: COMPANY, companyId: COMPANY, name: "Kind A/S", legalName: "Kind A/S", registrationNumber: "10000114", country: "DK", status: "active" })
    await tx.insert(project).values({ id: PROJECT, companyId: COMPANY, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
    await tx.execute(sql`select pgboss.create_queue(${DEAD}, '{"policy": "standard"}'::jsonb)`)
    await tx.execute(sql`select pgboss.create_queue(${OLD_QUEUE}, ${JSON.stringify({ policy: "standard", deadLetter: DEAD })}::jsonb)`)
  }

  /** An outbox row as the previous release wrote it, published or not. */
  const row = (tx: Tx, id: string, aggregateKind: "route" | "pickup", published: boolean) =>
    tx.execute(sql`insert into wms.outbox_event (id, company_id, project_id, kind, aggregate_kind, aggregate_id, occurred_at, payload, published_at)
      values (${id}, ${COMPANY}, ${PROJECT}, 'pickup-problem-reported', ${aggregateKind}, ${id}, now(), '{}', ${published ? sql`now()` : null})`)
  /** A job of the row on the queue, as the relay sent it and pg-boss left it. */
  const job = (tx: Tx, queue: string, id: string, aggregateKind: "route" | "pickup", state: string) =>
    tx.execute(sql`insert into pgboss.job (name, data, state) values (${queue}, ${JSON.stringify({ id, kind: "pickup-problem-reported", aggregateKind })}::jsonb, ${state}::pgboss.job_state)`)

  const rows = async (tx: Tx) =>
    Object.fromEntries(
      (await tx.execute<{ id: string; kind: string; published: boolean }>(sql`select id, kind, published_at is not null as published from wms.outbox_event where company_id = ${COMPANY}`)).map((found) => [found.id, [found.kind, found.published]]),
    )
  const jobs = async (tx: Tx) =>
    (await tx.execute<{ name: string; id: string; state: string }>(sql`select name, data->>'id' as id, state from pgboss.job where name like 'outbox.%' order by data->>'id', name`)).map((found) => [found.name, found.id, found.state])

  test("sends again every job of the old pair not done, gives every row of the old pair the new kind, and leaves a stop's problem as it was", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      // The rows as the release before wrote them: the trigger is this migration's, so it stands aside while they are written.
      await tx.execute(sql.raw(`alter table wms.outbox_event disable trigger "${ROUTE_PROBLEM_TRIGGER}"`))
      for (const id of [ROW.worked, ROW.waiting, ROW.dead, ROW.retrying]) await row(tx, id, "route", true)
      await row(tx, ROW.unrelayed, "route", false)
      await row(tx, ROW.onStop, "pickup", true)
      await tx.execute(sql.raw(`alter table wms.outbox_event enable trigger "${ROUTE_PROBLEM_TRIGGER}"`))
      await job(tx, OLD_QUEUE, ROW.worked, "route", "completed")
      await job(tx, OLD_QUEUE, ROW.waiting, "route", "created")
      await job(tx, OLD_QUEUE, ROW.dead, "route", "failed")
      await job(tx, DEAD, ROW.dead, "route", "created")
      await job(tx, OLD_QUEUE, ROW.retrying, "route", "retry")
      await job(tx, OLD_QUEUE, ROW.onStop, "pickup", "created")

      await tx.execute(sql.raw(resendRouteProblems()))
      await tx.execute(sql.raw(routeProblemKind()))

      assert.deepEqual(await rows(tx), {
        [ROW.worked]: ["route-problem-reported", true],
        [ROW.waiting]: ["route-problem-reported", false],
        [ROW.dead]: ["route-problem-reported", false],
        [ROW.retrying]: ["route-problem-reported", false],
        [ROW.unrelayed]: ["route-problem-reported", false],
        [ROW.onStop]: ["pickup-problem-reported", true],
      })
      assert.deepEqual(
        await jobs(tx),
        [
          [OLD_QUEUE, ROW.worked, "completed"],
          [OLD_QUEUE, ROW.waiting, "cancelled"],
          [DEAD, ROW.dead, "cancelled"],
          [OLD_QUEUE, ROW.dead, "failed"],
          [OLD_QUEUE, ROW.retrying, "cancelled"],
          [OLD_QUEUE, ROW.onStop, "created"],
        ],
        "a job done stays done, a job not done is cancelled for its row to be sent again, and a stop's problem waits on as it was",
      )
    })
  })

  test("writes the previous API's insert of the old pair as the new kind, and a stop's problem as it came", async () => {
    await rolledBack(owner.db, async (tx) => {
      await seed(tx)
      await tx.execute(sql`select set_config('wms.company_id', ${COMPANY}, true)`)
      await tx.execute(sql.raw(`set local role ${API_ROLE}`))
      await row(tx, ROW.unrelayed, "route", false)
      await row(tx, ROW.onStop, "pickup", false)
      assert.deepEqual(await rows(tx), { [ROW.unrelayed]: ["route-problem-reported", false], [ROW.onStop]: ["pickup-problem-reported", false] })
    })
  })
})
