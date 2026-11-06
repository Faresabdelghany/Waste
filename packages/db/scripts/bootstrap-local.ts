// `pnpm --filter @waste/db bootstrap` (and `pnpm db:bootstrap` at the root):
// lets the API role log in on the LOCAL stack with the password DATABASE_URL
// carries, and the worker role (Issue #97 part B) with the one
// WORKER_DATABASE_URL carries where that is set, an environment that runs no
// `apps/worker` having no worker login to give. The plans refuse any other
// host and any other user.
import { grantLogin, planLocalBootstrap, planWorkerBootstrap, type LocalBootstrapPlan } from "../src/bootstrap"

const adminUrl = process.env.DATABASE_ADMIN_URL
const appUrl = process.env.DATABASE_URL
if (!adminUrl || !appUrl) {
  console.error("DATABASE_ADMIN_URL and DATABASE_URL must both be set (see .env.example at the repository root)")
  process.exit(1)
}
const plans: LocalBootstrapPlan[] = [planLocalBootstrap({ adminUrl, appUrl })]
const workerUrl = process.env.WORKER_DATABASE_URL
if (workerUrl) plans.push(planWorkerBootstrap({ adminUrl, workerUrl }))
for (const plan of plans) {
  await grantLogin(plan.adminUrl, { role: plan.role, password: plan.password })
  console.log(`@waste/db: ${plan.role} can log in on ${new URL(adminUrl).hostname}`)
}
if (!workerUrl) console.log("@waste/db: WORKER_DATABASE_URL is not set, so the worker role keeps no login here")
