// Where a restore or a recovery reads from (Issue #152): the one input they
// take is a run id, and the run must be a run of the protected workflow
// itself, on main, dispatched by hand or started by CI's success on main
// (the automatic release, ADR-0011) — so a backup or a login-state record
// comes only from this workflow's own runs, never from a pull request's or
// another workflow's artifacts. Of that run's artifacts the newest attempt's
// of the kind asked for is taken, and one that has expired, that another run
// uploaded, or that two artifacts claim, is refused. The GitHub API is read
// with the job's token (`actions: read`).
import { artifactsOf, type ArtifactKind } from "@waste/db/pilot/phase"

import { gitHubRepository, type RepositoryOptions } from "./github"

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

/** The triggers of this workflow's own runs: by hand, and the automatic release after CI on main. */
const SOURCE_EVENTS: readonly string[] = ["workflow_dispatch", "workflow_run"]

export function checkSourceRun(run: WorkflowRun, { repository, workflowPath }: Expected): void {
  if (run.repository.full_name !== repository) throw new Error(`Run ${run.id} is a run of ${run.repository.full_name}, not of ${repository}`)
  if (run.path !== workflowPath) throw new Error(`Run ${run.id} is a run of ${run.path}, not of ${workflowPath}`)
  if (run.head_branch !== "main") throw new Error(`Run ${run.id} ran on ${run.head_branch}, not main`)
  if (!SOURCE_EVENTS.includes(run.event)) throw new Error(`Run ${run.id} was triggered by ${run.event}, not by hand or by CI's success on main`)
}

export type ArtifactPick = { id: number; name: string; attempt: string }

/** The newest attempt's artifact of the kind, named `<kind>-<run>-<attempt>`, refusing what cannot be trusted to be it. */
export function selectArtifact(artifacts: readonly RunArtifact[], { kind, run }: { kind: ArtifactKind; run: WorkflowRun }): ArtifactPick {
  const pattern = artifactsOf(kind, String(run.id))
  const named = artifacts.filter((artifact) => pattern.test(artifact.name))
  if (named.length === 0) throw new Error(`Run ${run.id} has no ${kind} artifact`)
  const attempt = Math.max(...named.map((artifact) => Number(pattern.exec(artifact.name)?.[1])))
  const newest = named.filter((artifact) => Number(pattern.exec(artifact.name)?.[1]) === attempt)
  if (newest.length > 1) throw new Error(`${newest.length} artifacts are named ${newest[0].name}: refusing to choose`)
  const [chosen] = newest
  if (chosen.expired) throw new Error(`${chosen.name} has expired: the break-glass path in supabase/README.md is the way on`)
  if (chosen.workflow_run !== undefined && chosen.workflow_run.id !== run.id) throw new Error(`${chosen.name} was uploaded by run ${chosen.workflow_run.id}, not ${run.id}`)
  return { id: chosen.id, name: chosen.name, attempt: String(attempt) }
}

export type SourceArtifactOptions = RepositoryOptions & {
  /** The workflow whose runs alone may be read from: this one's file. */
  workflowPath: string
  runId: string
  kind: ArtifactKind
}

export async function fetchSourceArtifact({ runId, kind, workflowPath, ...github }: SourceArtifactOptions): Promise<ArtifactPick & { commit: string }> {
  if (!/^\d+$/.test(runId)) throw new Error(`"${runId}" is not a run id`)
  const { read } = gitHubRepository(github)
  const run = await read<WorkflowRun>(`/actions/runs/${runId}`, `reading run ${runId}`)
  checkSourceRun(run, { repository: github.repository, workflowPath })
  const { artifacts } = await read<{ artifacts: RunArtifact[] }>(`/actions/runs/${runId}/artifacts?per_page=100`, `reading the artifacts of run ${runId}`)
  return { ...selectArtifact(artifacts, { kind, run }), commit: run.head_sha }
}
