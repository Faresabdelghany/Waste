// A release's step 9 (src/pilot/release.ts): three consecutive observations,
// ten seconds apart within ten minutes, of PILOT_API_URL's /healthz naming
// RELEASE_COMMIT and /readyz 200, both uncached. On timeout it fails naming
// the commit, RELEASE_IMAGE and the last thing it saw.
import { observeRelease } from "../../src/pilot/release"
import { required, step, summary } from "./step"

await step(async () => {
  const commit = required("RELEASE_COMMIT")
  const image = required("RELEASE_IMAGE")
  const { observations } = await observeRelease({ apiUrl: required("PILOT_API_URL"), commit, image })
  summary(`Live: build ${commit} (${image}) answered three consecutive observations, after ${observations} in all`)
})
