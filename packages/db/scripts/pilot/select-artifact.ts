// Chooses the artifact a restore or a recovery reads (src/pilot/github.ts):
// SOURCE_RUN_ID must be a dispatched run of this workflow on main, and of its
// artifacts named ARTIFACT_PREFIX-<run>-<attempt> the newest attempt's is
// taken. Outputs `id`, `attempt` and `commit` (the run's head) for the
// download step and the checks after it. Reads GITHUB_TOKEN (the job's, with
// `actions: read`), GITHUB_REPOSITORY and GITHUB_API_URL.
import { fetchSourceArtifact } from "../../src/pilot/github"
import { output, required, step, summary } from "./step"

await step(async () => {
  const pick = await fetchSourceArtifact({
    api: process.env.GITHUB_API_URL ?? "https://api.github.com",
    token: required("GITHUB_TOKEN"),
    repository: required("GITHUB_REPOSITORY"),
    workflowPath: ".github/workflows/pilot-database.yml",
    runId: required("SOURCE_RUN_ID"),
    prefix: required("ARTIFACT_PREFIX"),
  })
  output("id", String(pick.id))
  output("attempt", pick.attempt)
  output("commit", pick.commit)
  summary(`Source: ${pick.name} (artifact ${pick.id}) of run ${required("SOURCE_RUN_ID")} at commit ${pick.commit}`)
})
