// `pnpm --filter @waste/db migrate` (and `pnpm db:migrate` at the root):
// applies the migrations to DATABASE_ADMIN_URL. Notices from the migrations
// (an extension already present, a role already there) go to stderr.
import { migrateDatabase } from "../src/migrate"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
await migrateDatabase(url, { onnotice: (notice) => console.error(`postgres ${notice.severity}: ${notice.message}`) })
console.log("@waste/db: migrations applied")
