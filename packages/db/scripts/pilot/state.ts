// What the `check` operation reads beside the journal and the fingerprint
// (Issue #152): which database this is, whether the service roles can log in
// — the one thing the fingerprint leaves out, since the Pilot's logins are its
// own — and whether the `powersync` publication holds exactly the synced
// tables, which the fingerprint covers only once nothing is pending. wms_api
// NOLOGIN on the Pilot means a restore or a reset closed the write barrier and
// never opened it: the check fails and says to run recover-logins. wms_worker
// is reported and not held to anything: it has no login until grant-logins
// gives it one, and does not exist before migration 0011; wms_sync has none
// until a PowerSync instance exists.
import { createDb } from "../../src/client"
import { readLoginsIfPresent, spellLogins } from "../../src/pilot/barrier"
import { databaseIdentity, expectPilot } from "../../src/pilot/identity"
import { publicationProblems, readPublicationTables } from "../../src/pilot/publication"
import { API_ROLE, SYNC_ROLE, WORKER_ROLE } from "../../src/roles"
import { syncedTableNames } from "../../src/sql/publication"
import { required, step, summary } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const { sql, close } = createDb(url, { max: 1 })
  try {
    const logins = await readLoginsIfPresent(sql, [API_ROLE, WORKER_ROLE, SYNC_ROLE])
    summary(`${await databaseIdentity(sql, url)}: ${spellLogins(logins)}`)
    const problems = publicationProblems(await readPublicationTables(sql), syncedTableNames())
    if (problems.length === 0) summary(`The powersync publication holds exactly the ${syncedTableNames().length} synced tables`)
    if (logins[API_ROLE] !== true) problems.unshift("wms_api cannot log in: a restore or a reset closed the write barrier and never opened it. Run recover-logins with that run's id (supabase/README.md).")
    if (problems.length > 0) throw new Error(problems.join("\n"))
  } finally {
    await close()
  }
})
