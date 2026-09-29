// A release's step 2 (src/pilot/release.ts): CI's proof of RELEASE_COMMIT
// before anything is written — the check runs named in RELEASE_CHECKS
// (comma-separated: CI's job names) completed with success on it, read
// under GITHUB_TOKEN (`checks: read`), or the release stops here. What the
// resolved image used to prove in this step, now that Suga builds the image
// itself.
import { requireChecks } from "../../src/pilot/release"
import { required, step, summary } from "../step"

await step(async () => {
  const sha = required("RELEASE_COMMIT")
  const names = required("RELEASE_CHECKS")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  if (names.length === 0) throw new Error("RELEASE_CHECKS names no check run")
  await requireChecks({ repository: required("GITHUB_REPOSITORY"), sha, names, token: required("GITHUB_TOKEN") })
  summary(`CI proved ${sha}: ${names.map((name) => `"${name}"`).join(", ")} completed with success`)
})
