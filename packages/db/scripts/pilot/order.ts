// A release's first step (src/pilot/release.ts, ADR-0011): whether
// RELEASE_COMMIT may be released at all — on main, and not older than what
// the deploy branch PILOT_DEPLOY_BRANCH already releases — read under
// GITHUB_TOKEN (`contents: read`) before the job that holds a secret starts.
// Outputs `proceed` (true or false) and `released`; a commit off main fails
// the step, an older one only skips the release, saying why.
import { resolveReleaseOrder } from "../../src/pilot/release"
import { output, required, step, summary } from "../step"

await step(async () => {
  const sha = required("RELEASE_COMMIT")
  const verdict = await resolveReleaseOrder({ repository: required("GITHUB_REPOSITORY"), branch: required("PILOT_DEPLOY_BRANCH"), sha, token: required("GITHUB_TOKEN") })
  output("proceed", String(verdict.proceed))
  output("released", verdict.released ?? "")
  summary(verdict.proceed ? `Releasing ${sha}: ${verdict.reason}` : `Not releasing ${sha}: ${verdict.reason}`)
  if (!verdict.proceed) console.log(`::notice title=Release skipped::${verdict.reason}`)
})
