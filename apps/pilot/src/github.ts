// The one GitHub client of the Pilot's operations (Issue #152): the deploy
// branch, CI's check runs, the release order and a source run's artifacts are
// all read and written through it, on one repository's REST API under the
// job's own token, with GitHub's media type and API version, bounded, never
// following a redirect. A refusal says GitHub's status and its message and
// never the token.

/** The one fetch these calls make: always to a URL they built. */
export type Fetch = (input: URL, init?: RequestInit) => Promise<Response>

/** GitHub's API, as GITHUB_API_URL names it on a runner. */
export const GITHUB_API = "https://api.github.com"

/** `<owner>/<name>`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type RepositoryOptions = {
  /** `<owner>/<name>`: GITHUB_REPOSITORY. */
  repository: string
  /** The job's token: GITHUB_TOKEN. Appears in no message. */
  token: string
  /** GitHub's API; github.com's unless a test says otherwise. */
  apiUrl?: string
  fetch?: Fetch
}

export type Repository = {
  /** A request on a path relative to the repository (`/git/refs`), answered as GitHub answered it. */
  call(path: string, init?: { method?: string; body?: unknown }): Promise<Response>
  /** A GET whose JSON body is answered, refused naming what it was `doing` unless GitHub said yes. */
  read<T>(path: string, doing: string): Promise<T>
}

/** GitHub's `message` from an error body, where it gave one. */
async function githubSaid(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown } | null
    return typeof body?.message === "string" ? body.message : `status ${response.status}`
  } catch {
    return `status ${response.status}`
  }
}

export async function refuse(response: Response, doing: string): Promise<never> {
  throw new Error(`GitHub answered ${response.status} ${doing}: ${await githubSaid(response)}`)
}

export function gitHubRepository({ repository, token, apiUrl = GITHUB_API, fetch = globalThis.fetch }: RepositoryOptions): Repository {
  if (!REPOSITORY.test(repository)) throw new Error(`GITHUB_REPOSITORY is not <owner>/<name>: ${repository}`)
  if (token === "") throw new Error("GITHUB_TOKEN is not set")
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" }
  const call: Repository["call"] = (path, { method = "GET", body } = {}) =>
    fetch(new URL(`/repos/${repository}${path}`, apiUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(30_000) })
  return {
    call,
    async read<T>(path: string, doing: string): Promise<T> {
      const response = await call(path)
      if (!response.ok) await refuse(response, doing)
      return (await response.json()) as T
    },
  }
}
