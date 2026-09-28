// The write barrier's three steps (src/pilot/barrier.ts), as the restore and
// reset-to-seed jobs run them around the artifact upload that sits between the
// first two:
//
//   barrier.ts record  BARRIER_OPERATION, LOGIN_STATE_DIR: reads the two app
//                      roles' LOGIN — refusing while wms_api cannot log in, an
//                      earlier run's barrier still closed — and writes
//                      LOGIN_STATE_DIR/login-state.json (no credential), its
//                      sha256 the step's `sha256` output
//   barrier.ts close   LOGIN_STATE_COPY, LOGIN_STATE_SHA256: the record read
//                      back from the uploaded artifact must have that digest,
//                      name this run, this database and the roles as they are;
//                      only then both roles NOLOGIN and their sessions ended
//   barrier.ts open    LOGIN_STATE_FILE, EXPECTED_RUN_ID, EXPECTED_ATTEMPT,
//                      EXPECTED_COMMIT: the recorded states restored, after a
//                      restore's checks or by recover-logins; a role that can
//                      log in now but was recorded NOLOGIN is refused
//
// Every step reads DATABASE_ADMIN_URL and refuses a URL that is not the
// Pilot's (PILOT_SUPABASE_REF) or, without one, the local stack.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { createDb } from "../../src/client"
import {
  BARRIER_OPERATIONS,
  barrierOpen,
  checkRecord,
  closeBarrier,
  loginRecord,
  openLogins,
  parseLoginRecord,
  planRecovery,
  readLogins,
  spellLogins,
  type BarrierOperation,
} from "../../src/pilot/barrier"
import { databaseIdentity, expectPilot } from "../../src/pilot/identity"
import { sha256 } from "../../src/sha256"
import { output, required, step, summary } from "./step"

await step(async () => {
  const [mode] = process.argv.slice(2)
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const { sql, close } = createDb(url, { max: 1 })
  try {
    const identity = await databaseIdentity(sql, url)
    if (mode === "record") {
      const operation = required("BARRIER_OPERATION")
      if (!BARRIER_OPERATIONS.includes(operation as BarrierOperation)) throw new Error(`${operation} is not an operation that closes the barrier`)
      const logins = await readLogins(sql)
      barrierOpen(logins)
      const record = loginRecord({
        operation: operation as BarrierOperation,
        run: { id: required("GITHUB_RUN_ID"), attempt: required("GITHUB_RUN_ATTEMPT") },
        commit: required("GITHUB_SHA"),
        recordedAt: new Date().toISOString(),
        identity,
        logins,
      })
      const text = `${JSON.stringify(record, null, 2)}\n`
      const dir = required("LOGIN_STATE_DIR")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "login-state.json"), text)
      output("sha256", sha256(text))
      summary(`Recorded the logins before the barrier: ${spellLogins(record.logins)} (${identity}, login-state.json sha256 ${sha256(text)})`)
    } else if (mode === "close") {
      const text = readFileSync(required("LOGIN_STATE_COPY"), "utf8")
      const expected = required("LOGIN_STATE_SHA256")
      if (sha256(text) !== expected) throw new Error(`the uploaded login-state.json reads back with sha256 ${sha256(text)}, not ${expected}: the barrier stays open`)
      const record = parseLoginRecord(text)
      checkRecord(record, { identity, run: { id: required("GITHUB_RUN_ID"), attempt: required("GITHUB_RUN_ATTEMPT") } })
      const now = await readLogins(sql)
      if (JSON.stringify(now) !== JSON.stringify(record.logins)) throw new Error(`the logins changed since they were recorded (${spellLogins(now)}): the barrier stays open`)
      const { terminated } = await closeBarrier(sql)
      summary(`Barrier closed: wms_api and wms_worker NOLOGIN, ${terminated} session(s) ended, none left. On failure or cancellation they stay NOLOGIN: run recover-logins with this run's id.`)
    } else if (mode === "open") {
      const record = parseLoginRecord(readFileSync(required("LOGIN_STATE_FILE"), "utf8"))
      checkRecord(record, { identity, run: { id: required("EXPECTED_RUN_ID"), attempt: required("EXPECTED_ATTEMPT") }, commit: required("EXPECTED_COMMIT") })
      const plan = planRecovery(record, await readLogins(sql))
      if (plan.refused.length > 0) throw new Error(`Refused, nothing changed:\n${plan.refused.join("\n")}`)
      await openLogins(sql, plan.restore)
      summary(`Logins restored from the ${record.operation} of run ${record.run.id}: ${spellLogins(await readLogins(sql))}${plan.restore.length === 0 ? " (already as recorded)" : ""}`)
    } else {
      throw new Error("usage: barrier.ts record | close | open")
    }
  } finally {
    await close()
  }
})
