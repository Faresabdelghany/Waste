// The `grant-logins` operation (src/pilot/credentials.ts): LOGIN for exactly
// wms_api and wms_worker, with the passwords the `pilot` environment's
// PILOT_DATABASE_URL and PILOT_WORKER_DATABASE_URL carry, through the owner's
// DATABASE_ADMIN_URL. Every URL is held to the Pilot's session pooler
// (PILOT_DATABASE_HOST), the project (PILOT_SUPABASE_REF), the database and its
// own role before anything runs, and every password is masked in the log
// first. Runs inside GitHub Actions only, since masking is a runner's command.
import { grantLogin } from "../../src/bootstrap"
import { createDb } from "../../src/client"
import { planPilotLogins } from "../../src/pilot/credentials"
import { expectPilot } from "../../src/pilot/identity"
import { readLogins, spellLogins } from "../../src/pilot/logins"
import { required, step, summary } from "./step"

await step(async () => {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("grant-logins runs inside the protected workflow only")
  const adminUrl = required("DATABASE_ADMIN_URL")
  const ref = required("PILOT_SUPABASE_REF")
  expectPilot(adminUrl, ref)
  const plan = planPilotLogins({ adminUrl, apiUrl: required("PILOT_DATABASE_URL"), workerUrl: required("PILOT_WORKER_DATABASE_URL") }, { ref, host: required("PILOT_DATABASE_HOST") })
  for (const secret of plan.secrets) console.log(`::add-mask::${secret}`)
  for (const login of plan.logins) await grantLogin(adminUrl, login)
  const { sql, close } = createDb(adminUrl, { max: 1 })
  try {
    summary(`Granted LOGIN with the environment's passwords: ${spellLogins(await readLogins(sql))}`)
  } finally {
    await close()
  }
})
