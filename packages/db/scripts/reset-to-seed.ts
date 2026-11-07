// `pnpm --filter @waste/db reset-to-seed`: the demo company swept and written
// back as the seed says (src/reset-to-seed.ts, Issue #142), as the owner
// DATABASE_ADMIN_URL logs in as, in one transaction. On the Pilot it runs only
// as the `reset-to-seed` operation of the protected workflow, inside the write
// barrier (supabase/README.md); here it refuses a URL that is not the local
// stack, and it is never something to run while an API, a worker or a test
// suite is using the database. It takes no argument: the company it resets is
// the demo company, whose id the seed fixes. Prints what it swept, what it
// kept, and what becomes of the outbox and of the jobs pg-boss still holds
// for the company.
import { expectPilot } from "../src/pilot/identity"
import { resetToSeed, spellReset } from "../src/reset-to-seed"
import { required, step, summary } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, undefined)
  for (const line of spellReset(await resetToSeed(url), url)) summary(line)
})
