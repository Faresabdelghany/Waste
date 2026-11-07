// `pnpm --filter @waste/db check` (and `pnpm db:check` at the root): the
// journal check of Issue #152 against DATABASE_ADMIN_URL (`requireJournal`),
// the same rules `migrateDatabase` runs before it applies anything, under the
// same lock, and nothing written. Says what is applied and what is pending,
// and exits 1 with every problem when the journal disagrees with the
// migrations folder: a disposable database is then reset
// (migrations/README.md), and the Pilot is never migrated past it.
import { requireJournal } from "../src/migrate"
import { required, step } from "./step"

await step(async () => {
  await requireJournal(required("DATABASE_ADMIN_URL"), (line) => console.log(line))
})
