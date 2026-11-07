// The write barrier and the LOGIN record (Issue #152). The rules over plain
// shapes first — what a login-state record must be, and what restoring one
// does to the roles as they are — then the barrier and its protocol against
// Postgres. Roles are cluster-wide and every other suite logs in as wms_api,
// so the database tests close the barrier on throwaway roles of their own,
// the functions taking the roles the operations fix.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, test } from "node:test"

import { createDb } from "../client"
import {
  BARRIER_ROLES,
  barrierOpen,
  behindBarrier,
  checkRecord,
  closeBarrier,
  loginRecord,
  openFromRecord,
  openLogins,
  parseLoginRecord,
  planRecovery,
  readLogins,
  readLoginsIfPresent,
  recordLogins,
  requireBarrierOpen,
  spellLogins,
} from "../pilot/barrier"
import { databaseUnderTest, withUser } from "./database"

const COMMIT = "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091"
const record = loginRecord({
  operation: "restore",
  run: { id: "18000000001", attempt: "1" },
  commit: COMMIT,
  recordedAt: "2026-09-29T08:00:00.000Z",
  identity: "supabase:abcdefghijklmnopqrst/postgres",
  logins: { wms_api: true, wms_worker: false },
})

describe("a login-state record", () => {
  test("is exactly the record the workflow writes, and parses back to itself", () => {
    assert.deepEqual(BARRIER_ROLES, ["wms_api", "wms_worker"])
    assert.deepEqual(parseLoginRecord(JSON.stringify(record)), record)
  })

  test("refuses anything else, naming what is wrong", () => {
    const refusals: [unknown, RegExp][] = [
      ["not json", /is not JSON/],
      [[], /is not an object/],
      [{ ...record, schema: "waste.pilot.login-state/2" }, /is not a waste\.pilot\.login-state\/1 record/],
      [{ ...record, password: "x" }, /carries other members/],
      [{ ...record, operation: "release" }, /names no restore or reset operation/],
      [{ ...record, run: { id: "18000000001; drop", attempt: "1" } }, /names no run/],
      [{ ...record, commit: "main" }, /names no commit/],
      [{ ...record, recordedAt: "yesterday" }, /has no time/],
      [{ ...record, identity: "" }, /names no database/],
      [{ ...record, logins: { wms_api: true } }, /does not name exactly wms_api and wms_worker/],
      [{ ...record, logins: { wms_api: true, wms_worker: false, wms_public: false } }, /does not name exactly/],
      [{ ...record, logins: { wms_api: "yes", wms_worker: false } }, /says nothing usable about wms_api/],
    ]
    for (const [value, reason] of refusals) {
      assert.throws(() => parseLoginRecord(typeof value === "string" ? value : JSON.stringify(value)), reason, JSON.stringify(value))
    }
  })
})

describe("requireBarrierOpen and checkRecord", () => {
  test("refuse to close a barrier over one already closed, since the record would restore nothing", () => {
    assert.doesNotThrow(() => requireBarrierOpen({ wms_api: true, wms_worker: false }))
    assert.throws(() => requireBarrierOpen({ wms_api: false, wms_worker: false }), /wms_api cannot log in: an earlier restore or reset closed the write barrier and never opened it\. Run recover-logins/)
    assert.equal(barrierOpen({ wms_api: null, wms_worker: true }), false, "a missing wms_api is no open barrier")
    assert.equal(barrierOpen({ wms_api: true }), true)
  })

  test("hold a record to its run, its commit and its database", () => {
    const expected = { identity: record.identity, run: record.run, commit: COMMIT }
    assert.doesNotThrow(() => checkRecord(record, expected))
    assert.doesNotThrow(() => checkRecord(record, { identity: record.identity, run: record.run }), "a close checks the run and the database, not a commit")
    assert.throws(() => checkRecord(record, { ...expected, run: { id: record.run.id, attempt: "2" } }), /is of run 18000000001 attempt 1, not run 18000000001 attempt 2/)
    assert.throws(() => checkRecord(record, { ...expected, commit: "0".repeat(40) }), /names commit 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091, not its run's 0{40}/)
    assert.throws(() => checkRecord(record, { ...expected, identity: "local/postgres" }), /is of supabase:abcdefghijklmnopqrst\/postgres, not local\/postgres/)
  })
})

describe("planRecovery", () => {
  test("restores what the barrier closed, leaves a role already as recorded, and refuses one changed since", () => {
    assert.deepEqual(planRecovery(record, { wms_api: false, wms_worker: false }), { restore: ["wms_api"], unchanged: ["wms_worker"], refused: [] })
    assert.deepEqual(planRecovery(record, { wms_api: true, wms_worker: false }), { restore: [], unchanged: ["wms_api", "wms_worker"], refused: [] })
    const changed = planRecovery(record, { wms_api: false, wms_worker: true })
    assert.deepEqual(changed.restore, ["wms_api"])
    assert.deepEqual(changed.refused, [
      "wms_worker can log in now, but could not when the barrier closed: somebody has changed it since, so the record no longer says what is right",
    ])
  })

  test("spells the states for a log", () => {
    assert.equal(spellLogins({ wms_api: true, wms_worker: false }), "wms_api LOGIN, wms_worker NOLOGIN")
    assert.equal(spellLogins({ wms_api: true, wms_worker: null }), "wms_api LOGIN, wms_worker missing")
  })
})

const database = databaseUnderTest()

describe("the barrier on a database", { skip: database.skip }, () => {
  test("closes: NOLOGIN on every role, their sessions ended and none left; opens the roles named again", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
    const roles = [`waste_barrier_${suffix}_a`, `waste_barrier_${suffix}_b`]
    const password = decodeURIComponent(new URL(database.adminUrl).password)
    const owner = createDb(database.adminUrl, { max: 1 })
    const session = createDb(withUser(database.adminUrl, roles[0]), { max: 1 })
    try {
      for (const role of roles) await owner.sql.unsafe(`create role ${role} login password '${password.replaceAll("'", "''")}'`)
      await session.sql`select 1`
      assert.deepEqual(await readLogins(owner.sql, roles), { [roles[0]]: true, [roles[1]]: true })

      const { terminated } = await closeBarrier(owner.sql, roles)
      assert.equal(terminated, 1, "the one open session was ended")
      assert.deepEqual(await readLogins(owner.sql, roles), { [roles[0]]: false, [roles[1]]: false })
      const [{ remaining }] = await owner.sql<{ remaining: number }[]>`select count(*)::int as remaining from pg_stat_activity where usename = ${roles[0]}`
      assert.equal(remaining, 0)
      const refused = createDb(withUser(database.adminUrl, roles[1]), { max: 1 })
      try {
        await assert.rejects(refused.sql`select 1`, /not permitted to log in/)
      } finally {
        await refused.sql.end({ timeout: 0 })
      }

      await openLogins(owner.sql, [roles[0]])
      assert.deepEqual(await readLogins(owner.sql, roles), { [roles[0]]: true, [roles[1]]: false })
      await assert.rejects(readLogins(owner.sql, ["waste_barrier_nobody"]), /the role waste_barrier_nobody does not exist/)
      assert.deepEqual(await readLoginsIfPresent(owner.sql, [roles[0], "waste_barrier_nobody"]), { [roles[0]]: true, waste_barrier_nobody: null })
      await assert.rejects(closeBarrier(owner.sql, ["wms_api; drop"]), /is not a plain role name/)
    } finally {
      await session.sql.end({ timeout: 0 })
      for (const role of roles) {
        await owner.sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${role}`
        await owner.sql.unsafe(`drop role if exists ${role}`)
      }
      await owner.close()
    }
  })
})

describe("the barrier's protocol on a database", { skip: database.skip }, () => {
  /** Two throwaway roles, the first able to log in and the second not, for one test. */
  const withRoles = async (body: (roles: string[], sql: ReturnType<typeof createDb>["sql"]) => Promise<void>) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
    const roles = [`waste_protocol_${suffix}_a`, `waste_protocol_${suffix}_b`]
    const owner = createDb(database.adminUrl, { max: 1 })
    try {
      await owner.sql.unsafe(`create role ${roles[0]} login`)
      await owner.sql.unsafe(`create role ${roles[1]} nologin`)
      await body(roles, owner.sql)
    } finally {
      for (const role of roles) await owner.sql.unsafe(`drop role if exists ${role}`)
      await owner.close()
    }
  }
  /** The first role stands for wms_api, which logs in wherever the API runs; the second for wms_worker. */
  const scopeOf = (roles: string[]) => ({ identity: "local/postgres", run: { id: "18000000001", attempt: "1" }, commit: COMMIT, barrier: { roles, alwaysLoggingIn: [roles[0]] } })

  test("records the logins, closes over the stored copy, does the work while no role can log in, and puts back what it recorded", () =>
    withRoles(async (roles, sql) => {
      const scope = scopeOf(roles)
      const recorded = await recordLogins(sql, { ...scope, operation: "restore" })
      assert.deepEqual(recorded.record.logins, { [roles[0]]: true, [roles[1]]: false })
      assert.deepEqual(parseLoginRecord(recorded.text, roles), recorded.record)
      const said: string[] = []
      const during = await behindBarrier(sql, { ...scope, recorded: recorded.text, stored: recorded.text, say: (line) => said.push(line) }, () => readLogins(sql, roles))
      assert.deepEqual(during, { [roles[0]]: false, [roles[1]]: false })
      assert.deepEqual(await readLogins(sql, roles), { [roles[0]]: true, [roles[1]]: false })
      assert.deepEqual(said, [
        `Barrier closed: ${roles[0]} and ${roles[1]} NOLOGIN, 0 session(s) ended, none left. On failure or cancellation they stay NOLOGIN: run recover-logins with this run's id.`,
        `Logins restored from the restore of run 18000000001: ${roles[0]} LOGIN, ${roles[1]} NOLOGIN`,
      ])
    }))

  test("records nothing while the role that logs in wherever the API runs cannot: an earlier run's barrier, to recover first", () =>
    withRoles(async (roles, sql) => {
      await sql.unsafe(`alter role ${roles[0]} nologin`)
      await assert.rejects(recordLogins(sql, { ...scopeOf(roles), operation: "restore" }), new RegExp(`^Error: ${roles[0]} cannot log in: an earlier restore or reset closed the write barrier and never opened it\\. Run recover-logins`))
    }))

  test("closes nothing over a stored copy that is not the record, or over logins changed since they were recorded", () =>
    withRoles(async (roles, sql) => {
      const scope = scopeOf(roles)
      const recorded = await recordLogins(sql, { ...scope, operation: "reset-to-seed" })
      let worked = false
      const work = async () => {
        worked = true
      }
      await assert.rejects(behindBarrier(sql, { ...scope, recorded: recorded.text, stored: `${recorded.text} `, say: () => {} }, work), /reads back with sha256 [0-9a-f]{64}, not [0-9a-f]{64}: the barrier stays open/)
      await sql.unsafe(`alter role ${roles[1]} login`)
      await assert.rejects(behindBarrier(sql, { ...scope, recorded: recorded.text, stored: recorded.text, say: () => {} }, work), /the logins changed since they were recorded .*: the barrier stays open/)
      assert.equal(worked, false)
      assert.deepEqual(await readLogins(sql, roles), { [roles[0]]: true, [roles[1]]: true })
    }))

  test("leaves every role NOLOGIN when the work fails, for recover-logins to put back from the record, which no other run's record can", () =>
    withRoles(async (roles, sql) => {
      const scope = scopeOf(roles)
      const recorded = await recordLogins(sql, { ...scope, operation: "restore" })
      await assert.rejects(
        behindBarrier(sql, { ...scope, recorded: recorded.text, stored: recorded.text, say: () => {} }, async () => {
          throw new Error("the restore failed")
        }),
        /the restore failed/,
      )
      assert.deepEqual(await readLogins(sql, roles), { [roles[0]]: false, [roles[1]]: false })
      await assert.rejects(openFromRecord(sql, recorded.text, { ...scope, run: { id: "18000000001", attempt: "2" } }), /is of run 18000000001 attempt 1, not run 18000000001 attempt 2/)
      const opened = await openFromRecord(sql, recorded.text, scope)
      assert.deepEqual([opened.restored, opened.logins], [[roles[0]], { [roles[0]]: true, [roles[1]]: false }])
    }))
})
