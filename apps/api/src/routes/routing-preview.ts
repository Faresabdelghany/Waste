// `POST /routing/preview` (#173, decided on #124 §4 and #132 §5): the guided
// setup's road through a drafted route's points — its depot first and its
// unloading station last where the draft places them — asked of the routing
// provider through the quota engine the API holds, interactive class, so it
// spends the reserve down to zero. It writes nothing of the domain: no Plan,
// since a Plan belongs to a Route and the preview has none, and no job. The
// answer is the road, one leg per consecutive pair of the body's points, or
// the reason there is none (`basis: "estimate"`), which the web draws as the
// straight dashed line: the directions quota spent, the minute's allowance
// spent — both with `resumesAt`, nothing queued for either — the key
// refused, or the points refused in the provider's own words.
//
// No transaction is held across the provider's call (#124 §4): the route's
// guard is `identify`, which ends the principal's transaction before the
// handler runs, and the handler opens two short ones of its own — the
// company's stored readings before the call, which the engine takes where
// they are newer than what it learned (`refresh`: the worker's exhaustion
// defers the preview without a 403 spent to learn it), and the directions
// reading after it (#132 §5: written by the API after a preview call). The
// engine never waits inside a request (`waits: false`): a 429 or a full
// minute is a deferral, and a single call is the most a preview makes of any
// one chunk.
//
// Answers are cached in this process's memory by the fingerprint of the
// request's inputs — the provider, the profile, the points in order — so
// across people and companies alike, since nothing else keys the road
// (#132 §5): the road, and the provider's refusal of the points, which
// asking again would only repeat; never a deferral or a key refused, which
// are the quota's and the key's state and not the request's. At most
// PREVIEW_CACHE_ENTRIES answers are held, each for a day, the least recently
// asked for let go first — the Pilot's process is memory-bound, and a
// 500-point answer is large — and two requests for one fingerprint at once
// share one call.
import { RoutingPreview, RoutingPreviewRequest, type RoutingPreviewLeg } from "@waste/contracts/routing-preview"
import type { Position2D } from "@waste/contracts/geojson"
import type { Database } from "@waste/db/client"
import { quotaRows, recordQuota } from "@waste/db/commands/routing-quota"
import { withCompany } from "@waste/db/tenant"
import { planFingerprint } from "@waste/domain/routing/fingerprint"
import { distinctConsecutive, samePosition } from "@waste/routing/geodesy"
import { DEFAULT_PROFILE, type RoutedLeg } from "@waste/routing/provider"
import type { Outcome, QuotaEngine } from "@waste/routing/quota"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type IdentifiedEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem, loggable, problem, validate } from "../problem"
import { describeJson } from "./shared"

const MODULE = "route-studio.schemes"

/** How many answers the cache holds. */
export const PREVIEW_CACHE_ENTRIES = 50
/** How long an answer stands: a day. */
export const PREVIEW_CACHE_MS = 24 * 60 * 60 * 1000

/** Why there is no road while the day's directions are spent, or the day has too few calls left for the points. */
export const QUOTA_SPENT = "the routing provider's directions quota is spent"
/** Why there is no road while the minute's allowance is spent: the pacer's, or the provider's 429. */
export const MINUTE_SPENT = "the routing provider's limit for the minute is reached"
/** What a preview the provider did not answer is told: the network, the provider's own 5xx, an answer it could not read. */
export const PROVIDER_SILENT = "The routing provider did not answer; ask for the preview again"

type Held = { answer: RoutingPreview; answeredAt: number }

/**
 * The answers asked for, by fingerprint: each stands for a day after it was
 * answered, and past PREVIEW_CACHE_ENTRIES the one least recently asked for
 * is let go (a Map keeps insertion order, and a hit moves its entry last).
 */
export class PreviewCache {
  private readonly held = new Map<string, Held>()

  get(key: string, now: number): RoutingPreview | undefined {
    const found = this.held.get(key)
    if (found === undefined) return undefined
    this.held.delete(key)
    if (now - found.answeredAt >= PREVIEW_CACHE_MS) return undefined
    this.held.set(key, found)
    return found.answer
  }

  set(key: string, answer: RoutingPreview, now: number): void {
    this.held.delete(key)
    this.held.set(key, { answer, answeredAt: now })
    while (this.held.size > PREVIEW_CACHE_ENTRIES) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) break
      this.held.delete(oldest)
    }
  }
}

/** A point repeated spans no road: a zero leg over it. */
const zeroLeg = (at: Position2D): RoutingPreviewLeg => ({ path: { type: "LineString", coordinates: [at, at] }, metres: 0, seconds: 0 })

/** The provider's legs over the distinct points, one per consecutive pair of the body's points again, a zero leg wherever a point repeats. */
function legsOver(points: readonly Position2D[], routed: readonly RoutedLeg[]): RoutingPreviewLeg[] {
  const legs: RoutingPreviewLeg[] = []
  let next = 0
  for (let index = 1; index < points.length; index += 1) {
    if (samePosition(points[index - 1], points[index])) {
      legs.push(zeroLeg(points[index]))
      continue
    }
    const leg = routed[next]
    if (leg === undefined) throw new Error(`routing preview: the provider answered ${routed.length} legs for ${distinctConsecutive(points).length} distinct points`)
    next += 1
    legs.push({ path: leg.geometry, metres: leg.metres, seconds: leg.seconds })
  }
  return legs
}

/** What the engine's outcome says to a person looking at the preview. */
function answerOf(provider: string, points: readonly Position2D[], outcome: Outcome<{ legs: RoutedLeg[] }>): RoutingPreview {
  switch (outcome.kind) {
    case "answered": {
      const legs = legsOver(points, outcome.result.legs)
      return {
        basis: "road",
        provider,
        legs,
        distanceMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
        durationSeconds: legs.reduce((sum, leg) => sum + leg.seconds, 0),
      }
    }
    case "deferred":
      return { basis: "estimate", provider, resumesAt: outcome.until.toISOString(), reason: outcome.cause === "minute" ? MINUTE_SPENT : QUOTA_SPENT }
    case "key-refused":
    case "refused":
      return { basis: "estimate", provider, resumesAt: null, reason: outcome.sentence }
  }
}

/** Whether an outcome stands for the same request asked again: the road and the provider's refusal of the points do; a deferral and a key refused are the quota's and the key's state, not the request's. */
const standsFor = (outcome: Outcome<unknown>): boolean => outcome.kind === "answered" || outcome.kind === "refused"

export type RoutingPreviewOptions = {
  /** The request pool: the handler's own two short transactions run on it. */
  pool: Database
  /** The provider behind the quota engine the preview asks through; it never waits inside a request. */
  engine: QuotaEngine
  now: () => Date
  /** Where the cause of a provider that did not answer goes. */
  log: (error: unknown) => void
}

export function routingPreviewRoutes(guard: MiddlewareHandler<IdentifiedEnv>, { pool, engine, now, log }: RoutingPreviewOptions) {
  const cache = new PreviewCache()
  const asking = new Map<string, Promise<RoutingPreview>>()

  /** One call through the engine, bracketed by the company's readings — taken before, written after when the engine learned something — and the answer cached where it stands. */
  async function ask(key: string, companyId: string, points: readonly Position2D[]): Promise<RoutingPreview> {
    const keys = { companyId, provider: engine.name }
    const rows = await withCompany(pool.db, companyId, (tx) => quotaRows(tx, keys))
    for (const { family, updatedAt, ...standing } of rows) engine.refresh(family, { ...standing, observedAt: updatedAt })
    const before = engine.state("directions").observedAt?.getTime() ?? null
    const distinct = distinctConsecutive(points)
    // Every point at one place spans no road, and asks nothing.
    const outcome: Outcome<{ legs: RoutedLeg[] }> = distinct.length < 2 ? { kind: "answered", result: { legs: [] } } : await engine.measure(distinct, { class: "interactive", profile: DEFAULT_PROFILE })
    const learned = engine.state("directions")
    if ((learned.observedAt?.getTime() ?? null) !== before) {
      try {
        await withCompany(pool.db, companyId, (tx) => recordQuota(tx, { ...keys, family: "directions" }, learned))
      } catch (error) {
        // Bookkeeping, not the preview's answer: the engine holds the reading, and the next call writes it again.
        log(loggable(error))
      }
    }
    const answer = answerOf(engine.name, points, outcome)
    if (standsFor(outcome)) cache.set(key, answer, now().getTime())
    return answer
  }

  return new Hono<IdentifiedEnv>().post(
    "/routing/preview",
    describeRoute({
      operationId: "previewRoute",
      summary: "The road through a drafted route's points, for the guided setup",
      description:
        "Measures the points in the order given — a drafted route's depot, its stops in generation's order and its unloading station, as the guided setup draws them — through the routing provider, directions only, and writes nothing: no Plan (a Plan belongs to a Route, and a draft has none) and no job. `basis: \"road\"` answers one leg per consecutive pair of the points, a point repeated (two bins at one address) a zero leg, with the totals and the `provider` whose geometry it is, for the attribution a map owes. `basis: \"estimate\"` answers that there is no road and why (`reason`): the directions quota is spent, or the minute's allowance is — `resumesAt` says when it opens again, and nothing is queued — or the provider refuses the key, or cannot route the points, in its own words (`resumesAt` null). The same points are answered from a cache for a day, for anyone; the routing quota is spent from its reserve, never waited for inside the request. The quota's reading is `GET /routing/quota`.",
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The road through the points, or the reason there is none.", RoutingPreview),
        400: describeProblem(`The body is not two to 502 positions of \`[longitude, latitude]\`, or carries a member it does not know.`),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        502: describeProblem("The routing provider did not answer; nothing was cached, and the preview may be asked again."),
      },
    }),
    guard,
    requireGrant(MODULE, "view"),
    validate("json", RoutingPreviewRequest),
    async (c) => {
      const { points } = c.req.valid("json")
      const key = planFingerprint({ provider: engine.name, profile: DEFAULT_PROFILE, solver: "baseline", stops: points })
      const held = cache.get(key, now().getTime())
      if (held !== undefined) return c.json(held)
      let pending = asking.get(key)
      if (pending === undefined) {
        pending = ask(key, c.get("principal").companyId, points).finally(() => asking.delete(key))
        asking.set(key, pending)
      }
      try {
        return c.json(await pending)
      } catch (error) {
        log(loggable(error))
        throw problem(502, { detail: PROVIDER_SILENT })
      }
    },
  )
}
