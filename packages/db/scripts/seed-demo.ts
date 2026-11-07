// `pnpm --filter @waste/db seed` (and `pnpm db:seed` at the root): writes the
// demo company to DATABASE_ADMIN_URL, locally or on the hosted project, which
// is the point of its fixed ids. Idempotent, so running it after every
// migration costs nothing: a run that finds the database already saying all of
// it writes no row and exits 0 like any other.
import { seedDemo, spellSeed } from "../src/seed/demo"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
console.log(spellSeed(await seedDemo(url), url))
