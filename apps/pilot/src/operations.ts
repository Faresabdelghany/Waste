// The Pilot's operations (Issue #152), each the phases its job runs, in
// order, one workflow step each. .github/workflows/pilot-database.yml is their
// thin caller — the checkout, the workspace, a phase's environment, and
// between two phases the artifact the phase before named — and
// `operations.test.ts` holds its jobs to these lists. The database's phases
// are @waste/db's (src/pilot/phases.ts); the ones here talk to GitHub or to
// the released Pilot. What an operation is, and its admission, is
// operation.ts; the context a phase gets (the Pilot-target check, the layout
// of files and artifacts) is @waste/db's src/pilot/phase.ts.
import { BACKUP_ARTIFACT, LOGIN_STATE_ARTIFACT, removePlaintext, writeSourceRun, type ArtifactKind, type Context, type Phase } from "@waste/db/pilot/phase"
import { checkPhases, grantLoginsPhases, recoverLoginsPhases, redrivePhases, releasePhases, resetToSeedPhases, restorePhases } from "@waste/db/pilot/phases"

import { fetchSourceArtifact } from "./artifacts"
import { GITHUB_API, type RepositoryOptions } from "./github"
import { admitting, fromMain, servicesSuspended, sourceRunNamed, type Operation } from "./operation"
import { observeRelease, releaseToDeployBranch, requireChecks, resolveReleaseOrder } from "./release"

/** This workflow's file: a restore or a recovery reads only from its own runs. */
export const WORKFLOW = ".github/workflows/pilot-database.yml"

const github = (context: Context): RepositoryOptions => ({
  repository: context.required("GITHUB_REPOSITORY"),
  token: context.required("GITHUB_TOKEN"),
  apiUrl: context.env.GITHUB_API_URL || GITHUB_API,
})

/** Whether this release deploys the Pilot image, or is a database-only release. */
const deploying = (context: Context): boolean => context.env.DEPLOY_API === "true"

/** A release's first phase, in a job without a secret: whether RELEASE_COMMIT is released at all — on main, and not older than what the deploy branch already releases (ADR-0011). Outputs `proceed`; an older commit only skips the release, saying why. */
const order: Phase = {
  name: "order",
  async run(context) {
    const sha = context.required("RELEASE_COMMIT")
    const verdict = await resolveReleaseOrder({ ...github(context), branch: context.required("PILOT_DEPLOY_BRANCH"), sha })
    context.output("proceed", String(verdict.proceed))
    context.output("released", verdict.released ?? "")
    context.summary(verdict.proceed ? `Releasing ${sha}: ${verdict.reason}` : `Not releasing ${sha}: ${verdict.reason}`)
    if (!verdict.proceed) console.log(`::notice title=Release skipped::${verdict.reason}`)
  },
}

/** What is released, said; and where the Pilot image is deployed, CI's proof of the commit (REQUIRED_CHECKS green on it) before anything is written. */
const prove: Phase = {
  name: "prove",
  async run(context) {
    const sha = context.required("RELEASE_COMMIT")
    const branch = context.required("PILOT_DEPLOY_BRANCH")
    const kind = deploying(context) ? `a release of the database and the Pilot image: the ${branch} branch gets this commit's tree` : `a database-only release: the ${branch} branch does not move, no URL read`
    const by = context.env.GITHUB_EVENT_NAME === "workflow_run" ? "after CI on main" : "by hand"
    context.summary(`Commit ${sha}, ${by}: ${kind}; seed: ${context.env.RUN_SEED}`)
    if (!deploying(context)) return
    const { names } = await requireChecks({ ...github(context), sha })
    context.summary(`CI proved ${sha}: ${names.map((name) => `"${name}"`).join(", ")} completed with success`)
  },
}

/** One release commit on the deploy branch Suga builds from, after the migrations and the fingerprint passed. Outputs where the branch was and is; the commit is not a deployment, the observations after it are. */
const deploy: Phase = {
  name: "deploy",
  async run(context) {
    if (!deploying(context)) return context.log("A database-only release: the deploy branch does not move.")
    const branch = context.required("PILOT_DEPLOY_BRANCH")
    const { moved, from, head, commit } = await releaseToDeployBranch({ ...github(context), branch, sha: context.required("RELEASE_COMMIT") })
    context.output("from", from ?? "")
    context.output("head", head)
    context.summary(
      moved
        ? `${branch} is at ${head}${from === null ? " (created)" : `, moved from ${from}`}, releasing ${commit}; Suga builds it and rolls the new image out`
        : `${branch} at ${head} already releases ${commit}; nothing to push`,
    )
  },
}

/** Three consecutive observations of the released build within ten minutes; the old build's answers while Suga builds count as not yet. */
const observe: Phase = {
  name: "observe",
  async run(context) {
    if (!deploying(context)) return context.log("A database-only release: no URL is read.")
    const commit = context.required("RELEASE_COMMIT")
    const { observations } = await observeRelease({ apiUrl: context.required("PILOT_API_URL"), commit })
    context.summary(`Live: build ${commit} answered three consecutive observations, after ${observations} in all`)
  },
}

/** A restore's or a recovery's first phase: SOURCE_RUN_ID's newest artifact of the kind, refused unless the run is this workflow's on main. Outputs the artifact's `id` and the `path` to download it to, and keeps the choice for the phases after the download. */
const choosing = (kind: ArtifactKind): Phase => ({
  name: "choose",
  async run(context) {
    const runId = context.required("SOURCE_RUN_ID")
    const pick = await fetchSourceArtifact({ ...github(context), workflowPath: WORKFLOW, runId, kind })
    writeSourceRun(context, kind, { run: { id: runId, attempt: pick.attempt }, commit: pick.commit, artifact: { id: pick.id, name: pick.name } })
    context.output("id", String(pick.id))
    context.output("path", context.layout.source(kind).dir)
    context.summary(`Source: ${pick.name} (artifact ${pick.id}) of run ${runId} at commit ${pick.commit}`)
  },
})

const operated = fromMain("The Pilot's database is operated from main only")

export const OPERATIONS: readonly Operation[] = [
  { name: "check", admit: operated, phases: [checkPhases.inspect] },
  {
    name: "release",
    admit: fromMain("The Pilot is released from main only"),
    phases: [order, prove, releasePhases.backUp, releasePhases.migrate, deploy, observe, removePlaintext],
  },
  {
    name: "reset-to-seed",
    admit: admitting(operated, servicesSuspended("reset")),
    phases: [resetToSeedPhases.backUp, resetToSeedPhases.record, resetToSeedPhases.sweep, removePlaintext],
  },
  { name: "grant-logins", admit: operated, phases: [grantLoginsPhases.grant] },
  {
    name: "restore",
    admit: admitting(operated, servicesSuspended("restore"), sourceRunNamed),
    phases: [choosing(BACKUP_ARTIFACT), restorePhases.backUp, restorePhases.decrypt, restorePhases.record, restorePhases.apply, removePlaintext],
  },
  {
    name: "recover-logins",
    admit: admitting(operated, sourceRunNamed),
    phases: [choosing(LOGIN_STATE_ARTIFACT), recoverLoginsPhases.recover],
  },
  { name: "redrive", admit: operated, phases: [redrivePhases.redrive] },
]
