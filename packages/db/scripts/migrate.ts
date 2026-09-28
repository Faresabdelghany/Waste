// `pnpm --filter @waste/db migrate` (and `pnpm db:migrate` at the root):
// applies the migrations to DATABASE_ADMIN_URL, behind the journal check
// (src/journal-check.ts), and says which it applied. Notices from the
// migrations (an extension already present, a role already there) go to
// stderr.
import { migrateDatabase } from "../src/migrate"
import { required, step } from "./pilot/step"

await step(async () => {
  const { applied } = await migrateDatabase(required("DATABASE_ADMIN_URL"), { onnotice: (notice) => console.error(`postgres ${notice.severity}: ${notice.message}`) })
  console.log(applied.length === 0 ? "@waste/db: no migration pending" : `@waste/db: applied ${applied.join(", ")}`)
})
