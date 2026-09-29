// A release's step 9 (src/pilot/release.ts): three consecutive observations,
// ten seconds apart within ten minutes, of PILOT_API_URL's /healthz naming
// RELEASE_COMMIT and /readyz 200, both uncached — the old build's answers
// while Suga builds and rolls out count as "not yet". On timeout it fails
// naming the commit and the last thing it saw.
import { observeRelease } from "../../src/pilot/release"
import { required, step, summary } from "../step"

await step(async () => {
  const commit = required("RELEASE_COMMIT")
  const { observations } = await observeRelease({ apiUrl: required("PILOT_API_URL"), commit })
  summary(`Live: build ${commit} answered three consecutive observations, after ${observations} in all`)
})
