// `pnpm --filter @waste/db rehearse-restore`: the Pilot's backup and restore
// rehearsed on the local stack (src/pilot/rehearsal.ts), write barrier
// included on the real app roles, so it is CI's step before the suites and
// never something to run while an API or a worker is using the database.
// Needs PostgreSQL client 17 and age on PATH; refuses any host but this one.
import { rehearseRestore } from "../../src/pilot/rehearsal"
import { required, step, summary } from "../step"

await step(async () => {
  const { journalRows, logins } = await rehearseRestore(required("DATABASE_ADMIN_URL"), { barrier: true, log: (line) => console.log(line) })
  summary(`Restore rehearsed on the local stack: ${journalRows} journal rows, the fingerprint unchanged, logins ${logins ?? "untouched"}`)
})
