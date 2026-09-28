// The last two steps of a Pilot release (Issue #152, decided in #133): the
// deploy, and the proof that it is live.
//
// The deploy is Render's deploy hook with `imgURL=<image>@sha256:<digest>`
// — the exact image the release resolved and verified, never a moving tag.
// The hook's URL carries its key, so it is a secret: it reaches this step
// alone and appears in no message. Its 200 means Render accepted the request,
// not that anything is deployed; the id it answers is recorded for
// diagnostics.
//
// The proof is three consecutive observations ten seconds apart within ten
// minutes, each one GET /healthz answering 200 with `build.commit` the
// released commit and a clock that is fresh (within a minute of this
// runner's) and later than the previous observation's, and GET /readyz
// answering 200, both with `Cache-Control: no-store` and asked with the
// cache-bypass request headers. Anything else — an old build, a failure, a
// stale or unmoved clock, a cached or non-ready answer — resets the count, so
// a release is proven by the new process answering steadily and not by one
// lucky answer from an old one or a cache.
import type { HealthResponse } from "@waste/contracts/health"

export const OBSERVATIONS_NEEDED = 3
export const OBSERVE_INTERVAL_MS = 10_000
export const OBSERVE_TIMEOUT_MS = 600_000
/** How far /healthz's clock may be from the runner's before its answer counts as stale. */
export const CLOCK_SKEW_MS = 60_000

export type ProbeAnswer = { status: number; cacheControl: string | null; body: unknown } | { error: string }
export type Observation = { at: string; healthz: ProbeAnswer; readyz: ProbeAnswer }
export type Verdict = { ok: true; time: string } | { ok: false; reason: string }

/** The contracts' body, read structurally: this package runs no zod (schema/geometry.ts says why), so the shape is checked here. */
const isHealth = (body: unknown): body is HealthResponse => {
  const value = body as Partial<HealthResponse> | null
  return value !== null && typeof value === "object" && value.status === "ok" && typeof value.time === "string" && "build" in value
}

function probeProblem(path: string, answer: ProbeAnswer): string | undefined {
  if ("error" in answer) return `GET ${path} failed: ${answer.error}`
  if (answer.status !== 200) return `GET ${path} answered ${answer.status}`
  if (answer.cacheControl !== "no-store") return `GET ${path} answered Cache-Control: ${answer.cacheControl ?? "none"}, not no-store`
  return undefined
}

/** One observation judged against the released commit and the previous good observation's clock. */
export function judgeObservation(observation: Observation, { commit, previousTime }: { commit: string; previousTime: string | null }): Verdict {
  const healthProblem = probeProblem("/healthz", observation.healthz)
  if (healthProblem !== undefined) return { ok: false, reason: healthProblem }
  const { body } = observation.healthz as { body: unknown }
  if (!isHealth(body)) return { ok: false, reason: "GET /healthz answered a body that is not a health response" }
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
  /** The image the release deployed, for the failure's message. */
  image?: string
  probe?: (path: "/healthz" | "/readyz") => Promise<ProbeAnswer>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** Observes until three consecutive observations pass, or throws after ten minutes with the last thing it saw. */
export async function observeRelease({
  apiUrl,
  commit,
  image,
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
      throw new Error(
        `No three consecutive observations of build ${commit}${image === undefined ? "" : ` (${image})`} within ${OBSERVE_TIMEOUT_MS / 1000} s; last: ${last}`,
      )
    }
    await sleep(OBSERVE_INTERVAL_MS)
  }
}

/** The one fetch these calls make: always to a URL they built. */
export type Fetch = (input: URL, init?: RequestInit) => Promise<Response>

/** An image the hook may deploy: a GHCR package pinned by digest. */
const PINNED_IMAGE = /^ghcr\.io\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*@sha256:[0-9a-f]{64}$/

/** Calls Render's deploy hook with the image by digest; answers the deploy id Render gave, never the hook. */
export async function triggerDeploy(hookUrl: string, image: string, { fetch = globalThis.fetch }: { fetch?: Fetch } = {}): Promise<{ deployId: string }> {
  if (!PINNED_IMAGE.test(image)) throw new Error(`${image} is not an image pinned by digest (ghcr.io/<package>@sha256:<digest>)`)
  const notAHook = new Error("PILOT_RENDER_DEPLOY_HOOK is not a Render deploy hook (https://api.render.com/deploy/srv-…?key=…)")
  let url: URL
  try {
    url = new URL(hookUrl)
  } catch {
    throw notAHook
  }
  if (url.protocol !== "https:" || url.hostname !== "api.render.com" || !/^\/deploy\/srv-[a-z0-9]+$/.test(url.pathname) || !url.searchParams.has("key")) throw notAHook
  url.searchParams.set("imgURL", image)
  const response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`The deploy hook answered ${response.status}`)
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const id = (body as { deploy?: { id?: unknown } } | null)?.deploy?.id
  if (typeof id !== "string" || id === "") throw new Error("The deploy hook answered no deploy id")
  return { deployId: id }
}
