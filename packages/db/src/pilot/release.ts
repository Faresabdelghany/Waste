// The last two steps of a Pilot release (Issue #152, decided in #133; on
// Suga since #149): the deploy, and the proof that it is live.
//
// The deploy is one commit written on the deploy branch, `pilot`, through
// GitHub's git data API under the job's own token (`contents: write` on the
// release job alone): the released commit's tree plus
// `apps/pilot/release.json` naming that commit, with the branch's head and
// the released commit as parents. Suga builds the image from that branch on
// every push, so the commit is the deployment, and writing it only after the
// migrations and the fingerprint passed is what keeps the database from ever
// being behind the code it serves (#133's door). The file is why the commit
// is not a plain fast-forward of the branch to main's commit: Suga passes no
// commit id into its builds (its build arguments are values typed into the
// service's form), and `build.commit` on /healthz — what the proof below
// reads — has to come from the tree the host builds; the image's Dockerfile
// writes the file into build.json wherever it is present, and CI's
// SOURCE_COMMIT otherwise. The ref update is never forced, so the branch
// fast-forwards by construction (its head is a parent) and main's history is
// in its ancestry; a branch that does not exist yet is created (the first
// release), and one whose head already has the release tree is left alone
// (a release dispatched again). Whatever the branch held before is not in
// the new tree, so a branch moved by hand never reaches the image past the
// next release. Before any of it, `requireChecks` holds the commit to CI's
// proof, what the resolved image proved in the old step 2. The token
// reaches these steps alone and appears in no message.
//
// The proof is three consecutive observations ten seconds apart within ten
// minutes, each one GET /healthz answering 200 with `build.commit` the
// released commit and a clock that is fresh (within a minute of this
// runner's) and later than the previous observation's, and GET /readyz
// answering 200, both with `Cache-Control: no-store` and asked with the
// cache-bypass request headers. Anything else — an old build, a failure, a
// stale or unmoved clock, a cached or non-ready answer — resets the count, so
// a release is proven by the new process answering steadily and not by one
// lucky answer from an old one or a cache. Between the push and Suga's
// rollout the old build keeps answering, and the observer says "not yet" on
// each such answer until the new one takes over; Suga's build and rollout
// take about a minute, well inside the ten.
import { HealthResponse, PROBE_CACHE_CONTROL } from "@waste/contracts/health"

export const OBSERVATIONS_NEEDED = 3
export const OBSERVE_INTERVAL_MS = 10_000
export const OBSERVE_TIMEOUT_MS = 600_000
/** How far /healthz's clock may be from the runner's before its answer counts as stale. */
export const CLOCK_SKEW_MS = 60_000

export type ProbeAnswer = { status: number; cacheControl: string | null; body: unknown } | { error: string }
export type Observation = { at: string; healthz: ProbeAnswer; readyz: ProbeAnswer }
export type Verdict = { ok: true; time: string } | { ok: false; reason: string }

/** The contracts' body, parsed with the contracts' own schema, so what a release accepts is exactly what the API promises. */
const parseHealth = (body: unknown): HealthResponse | undefined => {
  const parsed = HealthResponse.safeParse(body)
  return parsed.success ? parsed.data : undefined
}

function probeProblem(path: string, answer: ProbeAnswer): string | undefined {
  if ("error" in answer) return `GET ${path} failed: ${answer.error}`
  if (answer.status !== 200) return `GET ${path} answered ${answer.status}`
  if (answer.cacheControl !== PROBE_CACHE_CONTROL) return `GET ${path} answered Cache-Control: ${answer.cacheControl ?? "none"}, not ${PROBE_CACHE_CONTROL}`
  return undefined
}

/** One observation judged against the released commit and the previous good observation's clock. */
export function judgeObservation(observation: Observation, { commit, previousTime }: { commit: string; previousTime: string | null }): Verdict {
  const healthProblem = probeProblem("/healthz", observation.healthz)
  if (healthProblem !== undefined) return { ok: false, reason: healthProblem }
  const body = parseHealth((observation.healthz as { body: unknown }).body)
  if (body === undefined) return { ok: false, reason: "GET /healthz answered a body that is not a health response" }
  if (body.build === null) return { ok: false, reason: "GET /healthz names no build" }
  if (body.build.commit !== commit) return { ok: false, reason: `GET /healthz is build ${body.build.commit}, not the released ${commit}` }
  const skew = Math.abs(Date.parse(body.time) - Date.parse(observation.at))
  if (!(skew <= CLOCK_SKEW_MS)) return { ok: false, reason: `GET /healthz's clock is ${Math.round(skew / 1000)} s away from this runner's: a stale answer` }
  if (previousTime !== null && !(Date.parse(body.time) > Date.parse(previousTime))) return { ok: false, reason: "GET /healthz's clock did not advance since the last observation" }
  const readyProblem = probeProblem("/readyz", observation.readyz)
  if (readyProblem !== undefined) return { ok: false, reason: readyProblem }
  return { ok: true, time: body.time }
}

/** Asks one probe as a release does: past every cache, bounded, no redirects followed. */
export async function askProbe(apiUrl: string, path: "/healthz" | "/readyz"): Promise<ProbeAnswer> {
  const response = await fetch(new URL(path, apiUrl), {
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body }
}

export type ObserveOptions = {
  apiUrl: string
  commit: string
  probe?: (path: "/healthz" | "/readyz") => Promise<ProbeAnswer>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** Observes until three consecutive observations pass, or throws after ten minutes with the last thing it saw. */
export async function observeRelease({
  apiUrl,
  commit,
  probe = (path) => askProbe(apiUrl, path),
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => console.log(line),
}: ObserveOptions): Promise<{ observations: number }> {
  const ask = async (path: "/healthz" | "/readyz"): Promise<ProbeAnswer> => {
    try {
      return await probe(path)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const deadline = now().getTime() + OBSERVE_TIMEOUT_MS
  let consecutive = 0
  let previousTime: string | null = null
  let last = "no observation yet"
  for (let count = 1; ; count += 1) {
    const at = now().toISOString()
    const verdict = judgeObservation({ at, healthz: await ask("/healthz"), readyz: await ask("/readyz") }, { commit, previousTime })
    if (verdict.ok) {
      consecutive += 1
      previousTime = verdict.time
      last = `build ${commit} ready at ${verdict.time}`
      log(`observation ${count}: ${consecutive} of ${OBSERVATIONS_NEEDED} — ${last}`)
      if (consecutive >= OBSERVATIONS_NEEDED) return { observations: count }
    } else {
      consecutive = 0
      previousTime = null
      last = verdict.reason
      log(`observation ${count}: not yet — ${verdict.reason}`)
    }
    if (now().getTime() + OBSERVE_INTERVAL_MS > deadline) {
      throw new Error(`No three consecutive observations of build ${commit} within ${OBSERVE_TIMEOUT_MS / 1000} s; last: ${last}`)
    }
    await sleep(OBSERVE_INTERVAL_MS)
  }
}

/** The one fetch these calls make: always to a URL they built. */
export type Fetch = (input: URL, init?: RequestInit) => Promise<Response>

/** A full commit id, as GitHub names one. */
const COMMIT_ID = /^[0-9a-f]{40}$/
/** `<owner>/<name>`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** A plain branch name: no `refs/`, no slash, nothing git would refuse. */
const BRANCH = /^[A-Za-z0-9_.-]+$/

/** Where the release commit names the released commit: the file the Pilot image reads into build.json (apps/pilot/Dockerfile). Absent on main; present on every commit of the deploy branch. */
export const RELEASE_FILE = "apps/pilot/release.json"

/** What every call to GitHub carries: the job's token, GitHub's media type and API version. */
const githubHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" })

/** GitHub's `message` from an error body, where it gave one. */
const githubSaid = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { message?: unknown } | null
    return typeof body?.message === "string" ? body.message : `status ${response.status}`
  } catch {
    return `status ${response.status}`
  }
}

type GitHubCall = (path: string, init: { method: string; body?: unknown }) => Promise<Response>

/** A caller on one repository's API under one token; every path is relative to the repository. */
const githubRepository = (repository: string, token: string, apiUrl: string, fetch: Fetch): GitHubCall => {
  const headers = githubHeaders(token)
  return (path, init) => fetch(new URL(`/repos/${repository}${path}`, apiUrl), { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual", signal: AbortSignal.timeout(30_000) })
}

const refuse = async (response: Response, doing: string): Promise<never> => {
  throw new Error(`GitHub answered ${response.status} ${doing}: ${await githubSaid(response)}`)
}

export type DeployBranchOptions = {
  /** `<owner>/<name>`: GITHUB_REPOSITORY. */
  repository: string
  /** The deploy branch Suga tracks: PILOT_DEPLOY_BRANCH, `pilot`. */
  branch: string
  /** The released commit, on main: RELEASE_COMMIT. */
  sha: string
  /** The job's token, with `contents: write`: GITHUB_TOKEN. Appears in no message. */
  token: string
  /** GitHub's API; github.com's unless a test says otherwise. */
  apiUrl?: string
  fetch?: Fetch
}

export type DeployBranchRelease = {
  /** Whether this call wrote a release commit; false where the branch's tree was already the release tree. */
  moved: boolean
  /** The branch's head before: a commit, or null where the branch did not exist. */
  from: string | null
  /** The branch's head after: the release commit, or the head as found where nothing moved. */
  head: string
  /** The released commit, as the file on the branch names it. */
  commit: string
}

/**
 * Releases a commit of main to the deploy branch by writing one commit on
 * it through GitHub's git data API: the released commit's tree plus
 * `apps/pilot/release.json` naming that commit, on the branch's head and the
 * released commit as parents — so the branch fast-forwards (the update is
 * never forced), main's history is in its ancestry, and whatever the branch
 * held before is not in its tree. Suga builds the branch's head, and the
 * image writes the file into build.json, which is how /healthz on the Pilot
 * names the released commit when the host injects none. Whether anything
 * needs writing is read off the trees: a branch whose head already has the
 * release tree is left alone (a release dispatched again), one with any
 * other tree — a hand-pushed commit on top of the last release included — is
 * released over, and one that does not exist is created. Answers where the
 * branch was and is.
 */
export async function releaseToDeployBranch({ repository, branch, sha, token, apiUrl = "https://api.github.com", fetch = globalThis.fetch }: DeployBranchOptions): Promise<DeployBranchRelease> {
  if (!REPOSITORY.test(repository)) throw new Error(`GITHUB_REPOSITORY is not <owner>/<name>: ${repository}`)
  if (!BRANCH.test(branch)) throw new Error(`PILOT_DEPLOY_BRANCH is not a plain branch name: ${branch}`)
  if (!COMMIT_ID.test(sha)) throw new Error(`RELEASE_COMMIT is not a full commit id: ${sha}`)
  if (token === "") throw new Error("GITHUB_TOKEN is not set")
  const ref = `refs/heads/${branch}`
  const call = githubRepository(repository, token, apiUrl, fetch)
  const shaOf = async (response: Response, what: string): Promise<string> => {
    const value = ((await response.json()) as { sha?: unknown }).sha
    if (typeof value !== "string" || !COMMIT_ID.test(value)) throw new Error(`GitHub answered no id for ${what}`)
    return value
  }
  const treeOf = async (commit: string, what: string): Promise<string> => {
    const response = await call(`/git/commits/${commit}`, { method: "GET" })
    if (!response.ok) await refuse(response, `reading ${what}`)
    const tree = ((await response.json()) as { tree?: { sha?: unknown } }).tree?.sha
    if (typeof tree !== "string" || !COMMIT_ID.test(tree)) throw new Error(`GitHub answered no tree for ${what}`)
    return tree
  }

  // Where the branch is.
  const current = await call(`/git/ref/heads/${branch}`, { method: "GET" })
  let head: string | null = null
  if (current.status !== 404) {
    if (!current.ok) await refuse(current, `reading ${ref}`)
    const object = ((await current.json()) as { object?: { sha?: unknown } }).object?.sha
    if (typeof object !== "string" || !COMMIT_ID.test(object)) throw new Error(`GitHub answered no commit for ${ref}`)
    head = object
  }

  // The release tree: the released commit's, plus the file naming it. Writing a tree that exists answers the same id, so this also asks whether the branch already has it.
  const baseTree = await treeOf(sha, `commit ${sha}`)
  const tree = await call("/git/trees", { method: "POST", body: { base_tree: baseTree, tree: [{ path: RELEASE_FILE, mode: "100644", type: "blob", content: `${JSON.stringify({ commit: sha })}\n` }] } })
  if (!tree.ok) await refuse(tree, "writing the release tree")
  const releaseTree = await shaOf(tree, "the release tree")
  if (head !== null && (await treeOf(head, `${ref}'s head ${head}`)) === releaseTree) return { moved: false, from: head, head, commit: sha }

  // The release commit: on the branch's head and the released commit, so the branch fast-forwards and main's history is in its ancestry; on the released commit alone where there is no branch, or where the branch stands on that very commit (made by hand from main's tip). Where the head is a hand-pushed commit above an earlier release of this same commit, the released commit is already an ancestor of the head: git takes such a redundant parent, and GitHub has so far; if GitHub ever refuses it, this is the line to look at.
  const commit = await call("/git/commits", {
    method: "POST",
    body: {
      message: `Release ${sha} to the Pilot\n\nThe tree of ${sha} on main plus ${RELEASE_FILE}, which names it: the commit Suga builds the Pilot image from (.github/workflows/pilot-database.yml, release step 8).`,
      tree: releaseTree,
      parents: head === null || head === sha ? [sha] : [head, sha],
    },
  })
  if (!commit.ok) await refuse(commit, "writing the release commit")
  const releaseCommit = await shaOf(commit, "the release commit")

  // The branch onto it: created where there was none, else a non-forced update, which GitHub refuses unless it is a fast-forward.
  if (head === null) {
    const created = await call("/git/refs", { method: "POST", body: { ref, sha: releaseCommit } })
    if (!created.ok) await refuse(created, `creating ${ref}`)
  } else {
    const moved = await call(`/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: releaseCommit, force: false } })
    if (!moved.ok) await refuse(moved, `moving ${ref}`)
  }
  return { moved: true, from: head, head: releaseCommit, commit: sha }
}

/**
 * The check runs a release requires green on the commit: CI's `verify` and
 * `pilot-image` jobs, by the `name:` each carries in .github/workflows/ci.yml
 * (a check run is named after its job). A constant and never a separated
 * string, since the first name has commas in it; the release test holds it
 * to the workflow file, so a renamed job fails a test and not a release.
 */
export const REQUIRED_CHECKS: readonly string[] = ["Install, typecheck, lint, test, build", "Build pilot image"]

export type RequireChecksOptions = {
  /** `<owner>/<name>`: GITHUB_REPOSITORY. */
  repository: string
  /** The released commit: RELEASE_COMMIT. */
  sha: string
  /** The check runs that must have completed with success on it; REQUIRED_CHECKS unless a test says otherwise. */
  names?: readonly string[]
  /** The job's token, with `checks: read`: GITHUB_TOKEN. */
  token: string
  apiUrl?: string
  fetch?: Fetch
}

export type CheckRun = { name: string; status: string; conclusion: string | null; html_url?: string }

/**
 * Judges the check runs GitHub lists for the released commit against the
 * names a release requires: every one present, completed and successful,
 * else one sentence naming what is not. Pure. A name with several runs (a
 * re-run) is judged by its newest, which GitHub lists first.
 */
export function judgeChecks(runs: readonly CheckRun[], names: readonly string[]): { ok: true } | { ok: false; reason: string } {
  for (const name of names) {
    const run = runs.find((candidate) => candidate.name === name)
    if (run === undefined) return { ok: false, reason: `no check run named "${name}": CI did not run on this commit (a change under docs/ or *.md alone skips it, and a commit off main has none); release a commit CI ran on` }
    if (run.status !== "completed") return { ok: false, reason: `"${name}" is ${run.status}, not completed: wait for CI` }
    if (run.conclusion !== "success") return { ok: false, reason: `"${name}" concluded ${run.conclusion ?? "nothing"}, not success${run.html_url === undefined ? "" : ` (${run.html_url})`}` }
  }
  return { ok: true }
}

/**
 * Refuses a release of a commit CI has not proved: reads the commit's check
 * runs and holds them to `judgeChecks`. The old door resolved a published
 * image here and refused where CI had built none; with Suga building the
 * image itself this is what keeps a red or unfinished commit from being
 * migrated for and pushed to the deploy branch.
 */
export async function requireChecks({ repository, sha, names = REQUIRED_CHECKS, token, apiUrl = "https://api.github.com", fetch = globalThis.fetch }: RequireChecksOptions): Promise<{ names: readonly string[] }> {
  if (!REPOSITORY.test(repository)) throw new Error(`GITHUB_REPOSITORY is not <owner>/<name>: ${repository}`)
  if (!COMMIT_ID.test(sha)) throw new Error(`RELEASE_COMMIT is not a full commit id: ${sha}`)
  if (token === "") throw new Error("GITHUB_TOKEN is not set")
  const call = githubRepository(repository, token, apiUrl, fetch)
  const response = await call(`/commits/${sha}/check-runs?per_page=100`, { method: "GET" })
  if (!response.ok) await refuse(response, `reading the check runs of ${sha}`)
  const runs = ((await response.json()) as { check_runs?: unknown }).check_runs
  if (!Array.isArray(runs)) throw new Error(`GitHub answered no check runs for ${sha}`)
  const verdict = judgeChecks(runs as CheckRun[], names)
  if (!verdict.ok) throw new Error(`Commit ${sha} is not released: ${verdict.reason}`)
  return { names }
}
