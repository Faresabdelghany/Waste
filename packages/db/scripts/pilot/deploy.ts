// A release's step 8 (src/pilot/release.ts): one release commit on the
// deploy branch Suga builds from, PILOT_DEPLOY_BRANCH — RELEASE_COMMIT's tree
// plus apps/pilot/release.json naming it — in GITHUB_REPOSITORY under
// GITHUB_TOKEN, the job's own token, which reaches this step alone. Outputs
// which commit the branch named before and names now; the commit is not a
// deployment, the observations after it are.
import { releaseToDeployBranch } from "../../src/pilot/release"
import { output, required, step, summary } from "../step"

await step(async () => {
  const branch = required("PILOT_DEPLOY_BRANCH")
  const sha = required("RELEASE_COMMIT")
  const { moved, previous, head, commit } = await releaseToDeployBranch({ repository: required("GITHUB_REPOSITORY"), branch, sha, token: required("GITHUB_TOKEN") })
  output("previous", previous ?? "")
  output("head", head)
  summary(
    moved
      ? `${branch} is at ${head}, releasing ${commit}${previous === null ? "" : ` over ${previous}`}; Suga builds it and rolls the new image out`
      : `${branch} already releases ${commit} (its head ${head}); nothing to push`,
  )
})
