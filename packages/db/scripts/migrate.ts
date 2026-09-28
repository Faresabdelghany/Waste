// `pnpm --filter @waste/db migrate` (and `pnpm db:migrate` at the root):
// applies the migrations to DATABASE_ADMIN_URL, behind the journal check
// (src/journal-check.ts), and says which it applied. Notices from the
// migrations (an extension already present, a role already there) go to
// stderr.
import { migrateDatabase } from "../src/migrate"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
const { applied } = await migrateDatabase(url, { onnotice: (notice) => console.error(`postgres ${notice.severity}: ${notice.message}`) })
console.log(applied.length === 0 ? "@waste/db: no migration pending" : `@waste/db: applied ${applied.join(", ")}`)
