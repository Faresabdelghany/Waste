// `pnpm --filter @waste/db check` (and `pnpm db:check` at the root): the
// journal check of Issue #152 against DATABASE_ADMIN_URL, the same rules
// `migrateDatabase` runs before it applies anything, under the same lock, and
// nothing written. Says what is applied and what is pending — and, in a
// workflow, outputs the pending count as `pending` — and exits 1 with every
// problem when the journal disagrees with the migrations folder: a disposable
// database is then reset (migrations/README.md), and the Pilot is never
// migrated past it.
import { count } from "@waste/domain/text"

import { checkDatabaseJournal } from "../src/migrate"
import { output } from "./pilot/step"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
const report = await checkDatabaseJournal(url)
const pending = report.pending.length === 0 ? "none pending" : `${count(report.pending.length, "pending migration")}: ${report.pending.join(", ")}`
console.log(`@waste/db: journal on ${new URL(url).hostname}: ${count(report.applied.length, "migration")} applied, ${pending}`)
if (process.env.GITHUB_OUTPUT) output("pending", String(report.pending.length))
if (report.problems.length > 0) {
  console.error(`@waste/db: the journal disagrees with the migrations folder:`)
  for (const problem of report.problems) console.error(`- ${problem}`)
  process.exit(1)
}
