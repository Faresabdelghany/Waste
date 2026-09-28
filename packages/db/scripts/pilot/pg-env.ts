// Prints libpq's environment for DATABASE_ADMIN_URL as `export` lines, for
// pilot-backup.sh and pilot-restore.sh to evaluate (src/pilot/pg-env.ts says
// why). Its output holds the password: the scripts capture it into a shell
// variable and evaluate it, and never print it or write it down.
import { libpqEnvironment, shellExports } from "../../src/pilot/pg-env"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set")
  process.exit(1)
}
process.stdout.write(`${shellExports(libpqEnvironment(url))}\n`)
