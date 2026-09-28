// A release's step 8 (src/pilot/release.ts): Render's deploy hook, which is
// PILOT_RENDER_DEPLOY_HOOK and reaches this step alone, called with
// RELEASE_IMAGE, the image by digest the release resolved. Outputs and
// prints the deploy id; the hook's 200 is not a deployment, the observations
// after it are.
import { triggerDeploy } from "../../src/pilot/release"
import { output, required, step, summary } from "./step"

await step(async () => {
  const image = required("RELEASE_IMAGE")
  const { deployId } = await triggerDeploy(required("PILOT_RENDER_DEPLOY_HOOK"), image)
  output("deploy_id", deployId)
  summary(`Render accepted deploy ${deployId} of ${image}`)
})
