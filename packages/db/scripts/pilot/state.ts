// What the `check` operation reads beside the journal and the fingerprint
// (Issue #152): which database this is and whether the roles a URL of their
// own logs in as can log in — the one thing the fingerprint leaves out of
// them, since the Pilot's logins are its own. wms_api NOLOGIN on the Pilot
// means a restore or a reset closed the write barrier and never opened it:
// the check fails and says to run recover-logins. wms_worker is reported and
// not held to anything: it has no login until grant-logins gives it one, and
// does not exist before migration 0011.
import { createDb } from "../../src/client"
import { BARRIER_CLOSED, barrierOpen, readLoginsIfPresent, spellLogins } from "../../src/pilot/barrier"
import { databaseIdentity, expectPilot } from "../../src/pilot/identity"
import { GRANTED_ROLES } from "../../src/roles"
import { required, step, summary } from "../step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const { sql, close } = createDb(url, { max: 1 })
  try {
    const logins = await readLoginsIfPresent(sql, GRANTED_ROLES.map((role) => role.name))
    summary(`${await databaseIdentity(sql, url)}: ${spellLogins(logins)}`)
    if (!barrierOpen(logins)) throw new Error(BARRIER_CLOSED)
  } finally {
    await close()
  }
})
