// `pnpm --filter @waste/db migrate` (and `pnpm db:migrate` at the root):
// applies the migrations to DATABASE_ADMIN_URL, behind the journal check
// (src/journal-check.ts), and says which it applied. Notices from the
// migrations (an extension already present, a role already there) go to
// stderr.
import { migrateAndSay } from "../src/migrate"
import { required, step } from "./step"

await step(async () => {
  await migrateAndSay(required("DATABASE_ADMIN_URL"), { log: (line) => console.log(line), notice: (line) => console.error(line) })
})
