// A release's step 2 (src/pilot/release.ts): CI's proof of RELEASE_COMMIT
// before anything is written — the check runs REQUIRED_CHECKS names (CI's
// verify and pilot-image jobs, held to ci.yml's job names by the release
// test) completed with success on it, read under GITHUB_TOKEN
// (`checks: read`), or the release stops here. What the resolved image used
// to prove in this step, now that Suga builds the image itself.
import { REQUIRED_CHECKS, requireChecks } from "../../src/pilot/release"
import { required, step, summary } from "../step"

await step(async () => {
  const sha = required("RELEASE_COMMIT")
  const { names } = await requireChecks({ repository: required("GITHUB_REPOSITORY"), sha, names: REQUIRED_CHECKS, token: required("GITHUB_TOKEN") })
  summary(`CI proved ${sha}: ${names.map((name) => `"${name}"`).join(", ")} completed with success`)
})
