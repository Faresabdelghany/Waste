// Where a restore or a recovery reads from (Issue #152): the one input they
// take is a run id, and the run must be a run of the protected workflow
// itself, on main, dispatched by hand — so a backup or a login-state record
// comes only from this workflow's own approved runs, never from a pull
// request's or another workflow's artifacts. Of that run's artifacts the
// newest attempt's of the kind asked for is taken, and one that has expired,
// that another run uploaded, or that two artifacts claim, is refused. The
// GitHub API is read with the job's token (`actions: read`).
import type { Fetch } from "./release"

export type WorkflowRun = {
  id: number
  path: string
  head_branch: string
  head_sha: string
  event: string
  repository: { full_name: string }
}

export type RunArtifact = {
  id: number
  name: string
  expired: boolean
  created_at: string
  workflow_run?: { id: number; head_branch: string; head_sha: string }
}

type Expected = { repository: string; workflowPath: string }

/** Refuses a run that is not a dispatched run of this workflow on main. */
export function checkSourceRun(run: WorkflowRun, { repository, workflowPath }: Expected): void {
  if (run.repository.full_name !== repository) throw new Error(`Run ${run.id} is a run of ${run.repository.full_name}, not of ${repository}`)
  if (run.path !== workflowPath) throw new Error(`Run ${run.id} is a run of ${run.path}, not of ${workflowPath}`)
  if (run.head_branch !== "main") throw new Error(`Run ${run.id} ran on ${run.head_branch}, not main`)
  if (run.event !== "workflow_dispatch") throw new Error(`Run ${run.id} was triggered by ${run.event}, not by hand`)
}

export type ArtifactPick = { id: number; name: string; attempt: string }

/** The newest attempt's artifact named `<prefix>-<run>-<attempt>`, refusing what cannot be trusted to be it. */
export function selectArtifact(artifacts: readonly RunArtifact[], { prefix, run }: { prefix: string; run: WorkflowRun }): ArtifactPick {
  const pattern = new RegExp(`^${prefix}-${run.id}-(\\d+)$`)
  const named = artifacts.filter((artifact) => pattern.test(artifact.name))
  if (named.length === 0) throw new Error(`Run ${run.id} has no ${prefix} artifact`)
  const attempt = Math.max(...named.map((artifact) => Number(pattern.exec(artifact.name)?.[1])))
  const newest = named.filter((artifact) => Number(pattern.exec(artifact.name)?.[1]) === attempt)
  if (newest.length > 1) throw new Error(`${newest.length} artifacts are named ${newest[0].name}: refusing to choose`)
  const [chosen] = newest
  if (chosen.expired) throw new Error(`${chosen.name} has expired: the break-glass path in supabase/README.md is the way on`)
  if (chosen.workflow_run !== undefined && chosen.workflow_run.id !== run.id) throw new Error(`${chosen.name} was uploaded by run ${chosen.workflow_run.id}, not ${run.id}`)
  return { id: chosen.id, name: chosen.name, attempt: String(attempt) }
}

export type SourceArtifactOptions = Expected & {
  /** The API's origin, GITHUB_API_URL. */
  api: string
  token: string
  runId: string
  prefix: string
  fetch?: Fetch
}

/** Reads the source run and its artifacts, checks the run, and answers the artifact to download with the run's commit. */
export async function fetchSourceArtifact({ api, token, runId, prefix, fetch = globalThis.fetch, ...expected }: SourceArtifactOptions): Promise<ArtifactPick & { commit: string }> {
  if (!/^\d+$/.test(runId)) throw new Error(`"${runId}" is not a run id`)
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(new URL(path, api), {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`)
    return (await response.json()) as T
  }
  const base = `/repos/${expected.repository}/actions/runs/${runId}`
  const run = await read<WorkflowRun>(base)
  checkSourceRun(run, expected)
  const { artifacts } = await read<{ artifacts: RunArtifact[] }>(`${base}/artifacts?per_page=100`)
  return { ...selectArtifact(artifacts, { prefix, run }), commit: run.head_sha }
}
