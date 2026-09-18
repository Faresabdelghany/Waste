// `pnpm --filter @waste/db bootstrap` (and `pnpm db:bootstrap` at the root):
// lets the API role log in on the LOCAL stack with the password DATABASE_URL
// carries. The plan refuses any other host and any other user.
import { grantLogin, planLocalBootstrap } from "../src/bootstrap"

const adminUrl = process.env.DATABASE_ADMIN_URL
const appUrl = process.env.DATABASE_URL
if (!adminUrl || !appUrl) {
  console.error("DATABASE_ADMIN_URL and DATABASE_URL must both be set (see .env.example at the repository root)")
  process.exit(1)
}
const plan = planLocalBootstrap({ adminUrl, appUrl })
await grantLogin(plan.adminUrl, { role: plan.role, password: plan.password })
console.log(`@waste/db: ${plan.role} can log in on ${new URL(adminUrl).hostname}`)
