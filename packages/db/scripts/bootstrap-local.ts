// `pnpm --filter @waste/db bootstrap` (and `pnpm db:bootstrap` at the root):
// lets the API role log in on the LOCAL stack with the password DATABASE_URL
// carries. Refuses any other host: on a hosted project the operator runs
// ALTER ROLE by hand with a password that is not in a .env file.
import { grantLogin } from "../src/bootstrap"

const adminUrl = process.env.DATABASE_ADMIN_URL
const appUrl = process.env.DATABASE_URL
if (!adminUrl || !appUrl) {
  console.error("DATABASE_ADMIN_URL and DATABASE_URL must both be set (see .env.example at the repository root)")
  process.exit(1)
}
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])
const adminHost = new URL(adminUrl).hostname
if (!LOCAL_HOSTS.has(adminHost)) {
  console.error(`bootstrap is for the local stack; DATABASE_ADMIN_URL points at ${adminHost}. On a hosted project run ALTER ROLE wms_api WITH LOGIN PASSWORD ... by hand.`)
  process.exit(1)
}
const app = new URL(appUrl)
await grantLogin(adminUrl, { role: decodeURIComponent(app.username), password: decodeURIComponent(app.password) })
console.log(`@waste/db: ${app.username} can log in on ${adminHost}`)
