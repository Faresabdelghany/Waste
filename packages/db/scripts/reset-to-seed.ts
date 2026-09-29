// `pnpm --filter @waste/db reset-to-seed`: the demo company swept and written
// back as the seed says (src/reset-to-seed.ts, Issue #142), as the owner
// DATABASE_ADMIN_URL logs in as, in one transaction. On the Pilot it runs only
// as the `reset-to-seed` operation of the protected workflow, inside the write
// barrier (supabase/README.md); anywhere else it refuses a URL that is not the
// local stack, like every Pilot script, and it is never something to run while
// an API, a worker or a test suite is using the database. It takes no
// argument: the company it resets is the demo company, whose id the seed
// fixes. Prints what it swept, what it kept, and what becomes of the outbox
// and of the jobs pg-boss still holds for the company.
import { count } from "@waste/domain/text"

import { expectPilot } from "../src/pilot/identity"
import { COUNTER_DEFAULTS, resetToSeed } from "../src/reset-to-seed"
import { required, step, summary } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const report = await resetToSeed(url)
  const rows = report.swept.reduce((total, { rows: swept }) => total + swept, 0)
  summary(`Reset the demo company ${report.companyId} on ${new URL(url).hostname} to its seed, in one transaction.`)
  summary(`Swept ${count(rows, "row")} from ${count(report.swept.length, "table")}, children first${report.swept.map(({ table, rows: swept }) => `, ${table} ${swept}`).join("")}.`)
  summary(
    `Kept Organisation & Access — the company, its projects, service providers, roles, grants, User Accounts and their access — so every Login stays bound; ` +
      `the seeded rows are back at the seed's word, and ${count(report.otherAccounts, "account")} the seed does not name ${report.otherAccounts === 1 ? "is" : "are"} as it was.`,
  )
  const counters = `${COUNTER_DEFAULTS.nextRouteNumber}, ${COUNTER_DEFAULTS.nextTicketNumber} and ${COUNTER_DEFAULTS.nextInvoiceNumber}`
  summary(
    `The seed wrote ${count(report.written, "row")}; the route, ticket and invoice counters ${report.countersReset ? "were put back to" : "were already at"} ${counters}, as a fresh seed leaves them.`,
  )
  summary(
    report.unsentEvents === 0
      ? "Outbox: no unpublished event was swept."
      : `Outbox: ${count(report.unsentEvents, "unpublished event")} went with the sweep and will never be relayed.`,
  )
  summary(
    report.waitingJobs === null
      ? "pg-boss: not installed on this database, so no job waits."
      : report.waitingJobs === 0
        ? "pg-boss: no waiting job names the company."
        : `pg-boss: ${count(report.waitingJobs, "waiting job")} still ${report.waitingJobs === 1 ? "names" : "name"} the company and ${report.waitingJobs === 1 ? "is" : "are"} left on ${report.waitingJobs === 1 ? "its queue" : "their queues"}: ` +
          "when a worker takes one it meets a tenant without the rows it names, and either finds nothing to do or fails, is retried and ends failed — an outbox consumer's copy on outbox.dead, which is not to be redriven.",
  )
})
