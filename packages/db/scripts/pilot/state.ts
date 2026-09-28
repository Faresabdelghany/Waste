// What the `check` operation reads beside the journal and the fingerprint
// (Issue #152): which database this is, and whether the service roles can log
// in — the one thing the fingerprint leaves out, since the Pilot's logins are
// its own. wms_api NOLOGIN on the Pilot means a restore or a reset closed the
// write barrier and never opened it: the check fails and says to run
// recover-logins. wms_worker is reported and not held to anything: it has no
// login until grant-logins gives it one, and does not exist before migration
// 0011; wms_sync has none until a PowerSync instance exists.
import { createDb } from "../../src/client"
import { databaseIdentity, expectPilot } from "../../src/pilot/identity"
import { readLoginsIfPresent, spellLogins } from "../../src/pilot/logins"
import { API_ROLE, SYNC_ROLE, WORKER_ROLE } from "../../src/roles"
import { required, step, summary } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const { sql, close } = createDb(url, { max: 1 })
  try {
    const logins = await readLoginsIfPresent(sql, [API_ROLE, WORKER_ROLE, SYNC_ROLE])
    summary(`${await databaseIdentity(sql, url)}: ${spellLogins(logins)}`)
    if (logins[API_ROLE] !== true) throw new Error("wms_api cannot log in: a restore or a reset closed the write barrier and never opened it. Run recover-logins with that run's id (supabase/README.md).")
  } finally {
    await close()
  }
})
