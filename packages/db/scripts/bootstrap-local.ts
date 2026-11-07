// `pnpm --filter @waste/db bootstrap` (and `pnpm db:bootstrap` at the root):
// lets every role the table (src/roles.ts) gives a URL of its own log in on
// the LOCAL stack with the password that URL carries — the API role from
// DATABASE_URL, and the worker role from WORKER_DATABASE_URL where that is
// set, an environment that runs no `apps/worker` having no worker login to
// give. The plan refuses any other host and any other user.
import { grantLogin, planLocalBootstrap } from "../src/bootstrap"
import { step } from "./step"

await step(async () => {
  const plan = planLocalBootstrap(process.env)
  for (const login of plan.logins) {
    await grantLogin(plan.adminUrl, login)
    console.log(`@waste/db: ${login.role} can log in on ${new URL(plan.adminUrl).hostname}`)
  }
  for (const { role, variable } of plan.unset) console.log(`@waste/db: ${variable} is not set, so ${role} keeps no login here`)
})
