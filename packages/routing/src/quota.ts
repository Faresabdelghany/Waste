// The quota engine (#132, #171): every routing call goes through it, so the
// rules for spending one key's quota live in one place. Per family —
// directions, optimisation — it holds what the provider last said (its
// `x-ratelimit-remaining` and reset, never a counter of our own against a
// window we cannot see), when it learned it, and since when the family is
// exhausted or its key refused; the worker stores that after every job
// (`routing_quota`) and a fresh process adopts the stored row, so the state
// outlives a restart and the API sees it.
//
// Before a job's first call the engine asks whether the job may spend: a
// batch job only while the family would stay at or above its reserve after
// every call the job needs (a chunked measurement counts all its chunks),
// an interactive one down to zero and never beyond — otherwise the job is
// deferred to the reset plus up to a minute of jitter, and no call is made.
// A reading whose reset has passed describes a window that is gone, so the
// call goes ahead: the first job after a reset is the probe that re-opens
// the family. Each call is paced — at most `callsPerMinute` a minute per
// family, under the provider's 40 — and its answer read:
//
//   answered       — the reading adopted, exhaustion and refusal cleared;
//   429            — wait the Retry-After (the minute's window, at most a
//                    minute, where it names none) and try once more; a
//                    second 429 throws, and pg-boss retries the job (3, 30 s
//                    → 5 min); a warning line, never counted as spent;
//   quota 403      — refused, never retried (#118: repeated overruns
//                    suspend the key): the family closed from now until it
//                    reopens — the provider's reset, where that lies after
//                    the refusal and within a day of it, else an hour on,
//                    the window being unreadable — and every job of the
//                    family deferred to then without a call; the first job
//                    after it is the probe;
//   key refused    — 401, or a 403 without rate-limit headers: final, on an
//                    error line; every job of the family in the next hour is
//                    refused without a call, and the first after it asks
//                    again, in case the refusal passed or the key was
//                    restored. A stored refusal is reported, never obeyed —
//                    a restart may carry a new key — and an answer clears it;
//   400, 404       — final, in the provider's own words, the reading it
//                    carried the family's.
//
// A deferral short of a closed family waits for the provider's next reset,
// where it lies within a day, else an hour: it never waits for a window
// already gone, nor for years on a reset misread.
//
// The knobs are the Pilot's environment (#128's principle), defaulting to
// the Standard plan's own figures (STANDARD_PLAN); the clock, the sleep, the
// jitter and the log lines are injected, so the tests run it against the
// fake's scripted states on a clock they move.
import type { Position2D } from "@waste/contracts/geojson"
import type { RoutingQuotaStanding } from "@waste/domain/routing/quota"
import type { RoutingJobClass } from "@waste/domain/routing/vocabulary"

import { chunkPoints } from "./chunk"
import { DEFAULT_PROFILE, type MeasureResult, type OptimiseRequest, type OptimiseResult, type ProviderAnswer, type QuotaFamily, type QuotaReading, type RoutingProvider } from "./provider"

export type QuotaKnobs = {
  /** Where batch work stops, per family: the remaining a batch job leaves standing for the office's own calls. */
  reserves: Record<QuotaFamily, number>
  /** How many calls a minute each family makes. */
  callsPerMinute: number
}

/** The Standard plan's figures (#132 §1): 500 of the 2 000 directions held back, 100 of the 500 optimisations, 30 calls a minute under its 40. */
export const STANDARD_PLAN: QuotaKnobs = { reserves: { directions: 500, optimisation: 100 }, callsPerMinute: 30 }

/** The knobs as a process's environment sets them (ROUTING_DIRECTIONS_RESERVE, ROUTING_OPTIMISATION_RESERVE, ROUTING_CALLS_PER_MINUTE): each unset one is the Standard plan's figure. */
export function quotaKnobs({ directionsReserve, optimisationReserve, callsPerMinute }: { directionsReserve?: number; optimisationReserve?: number; callsPerMinute?: number }): QuotaKnobs {
  return {
    reserves: { directions: directionsReserve ?? STANDARD_PLAN.reserves.directions, optimisation: optimisationReserve ?? STANDARD_PLAN.reserves.optimisation },
    callsPerMinute: callsPerMinute ?? STANDARD_PLAN.callsPerMinute,
  }
}

export type EngineOptions = QuotaKnobs & {
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** In [0, 1): the share of the minute of jitter a deferral adds after the reset. */
  random?: () => number
  warn?: (line: string) => void
  error?: (line: string) => void
}

/** What the engine knows of a family — the provider's last reading and what it made of it (@waste/domain/routing/quota) — and when it learned it. */
export type QuotaState = RoutingQuotaStanding & {
  /** When this was learned: a response here, or the stored row it was adopted from. */
  observedAt: Date | null
}

/** What a job's request came to. */
export type Outcome<Result> =
  | { kind: "answered"; result: Result }
  /** Not now: the family is exhausted, a batch job would cross the reserve, or the job needs more calls than the day has left. No call was made after the refusal, and none is to be made before `until`. */
  | { kind: "deferred"; family: QuotaFamily; cause: "exhausted" | "reserve" | "insufficient"; until: Date }
  /** Final: the provider cannot answer this request. */
  | { kind: "refused"; sentence: string }
  /** Final: the provider refuses the key. */
  | { kind: "key-refused"; sentence: string }

/** The sentence a Plan fails with when the key is refused, and the office reads beside the banner. */
export const KEY_REFUSED = "the routing provider refused the key"

/** A call that may succeed if tried again later — the minute's limit twice running — thrown so pg-boss retries the job. */
export class RoutingRetryable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RoutingRetryable"
  }
}

const MINUTE_MS = 60_000
/** Up to a minute after the reset, so a queue of deferred jobs does not wake as one. */
const JITTER_MS = 60_000
/** How long a deferral waits when the provider's reset cannot be read — none named, one already past, one past a day — so an hour. */
const UNREAD_WINDOW_MS = 60 * MINUTE_MS
/** The provider's window is a day: no reset lies further away. */
const DAY_MS = 24 * 60 * MINUTE_MS
/** How long a refused key is left before the next job asks again. */
const KEY_PROBE_MS = 60 * MINUTE_MS

const UNKNOWN: QuotaState = { remaining: null, limit: null, resetAt: null, exhaustedAt: null, keyRefusedAt: null, observedAt: null }

type Family = {
  state: QuotaState
  /** When this process last saw the key refused, which it obeys for an hour; a stored refusal is only reported. */
  keyRefusedHere: number | null
  /** The instants of this family's calls within the last minute, oldest first. */
  calls: number[]
}

const readingOf = (quota: QuotaReading): Pick<QuotaState, "remaining" | "limit" | "resetAt"> => ({
  remaining: quota.remaining,
  limit: quota.limit,
  resetAt: quota.resetAt === null ? null : new Date(quota.resetAt),
})

export class QuotaEngine {
  /** The provider's name, the one the fingerprint and the quota rows are kept under. */
  readonly name: string
  private readonly provider: RoutingProvider
  private readonly reserves: Record<QuotaFamily, number>
  private readonly callsPerMinute: number
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly warn: (line: string) => void
  private readonly error: (line: string) => void
  private readonly families: Record<QuotaFamily, Family>

  constructor(provider: RoutingProvider, options: EngineOptions) {
    this.name = provider.name
    this.provider = provider
    this.reserves = options.reserves
    this.callsPerMinute = options.callsPerMinute
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.warn = options.warn ?? ((line) => console.warn(line))
    this.error = options.error ?? ((line) => console.error(line))
    this.families = {
      directions: { state: { ...UNKNOWN }, keyRefusedHere: null, calls: [] },
      optimisation: { state: { ...UNKNOWN }, keyRefusedHere: null, calls: [] },
    }
  }

  /** The family as the worker stores it. */
  state(family: QuotaFamily): QuotaState {
    return { ...this.families[family].state }
  }

  /**
   * Seeds a family this process has not heard of from its stored row: after
   * a restart. Once the process has learned something of the family itself
   * its own readings rule, since the row's stamp is another clock's.
   */
  adopt(family: QuotaFamily, stored: QuotaState): void {
    if (this.families[family].state.observedAt !== null || stored.observedAt === null) return
    this.families[family].state = { ...stored }
  }

  /** Measures a known sequence, in as many chunked requests as it needs; fewer than two points span no leg and cost nothing. */
  async measure(points: readonly Position2D[], { class: jobClass, profile = DEFAULT_PROFILE }: { class: RoutingJobClass; profile?: string }): Promise<Outcome<MeasureResult>> {
    if (points.length < 2) return { kind: "answered", result: { legs: [], provenance: { engineVersion: null, graphDate: null } } }
    const chunks = chunkPoints(points, this.provider.maxWaypoints)
    const refusal = this.admit("directions", jobClass, chunks.length)
    if (refusal !== null) return refusal
    const legs: MeasureResult["legs"] = []
    let provenance: MeasureResult["provenance"] | null = null
    for (const chunk of chunks) {
      const outcome = await this.call("directions", () => this.provider.measure({ profile, points: chunk }))
      // A refusal midway ends the job whole: legs measured before it are not an answer.
      if (outcome.kind !== "answered") return outcome
      legs.push(...outcome.result.legs)
      provenance ??= outcome.result.provenance
    }
    return { kind: "answered", result: { legs, provenance: provenance ?? { engineVersion: null, graphDate: null } } }
  }

  /** Orders and measures a stop set in one optimisation request. */
  async optimise(request: OptimiseRequest, { class: jobClass }: { class: RoutingJobClass }): Promise<Outcome<OptimiseResult>> {
    const refusal = this.admit("optimisation", jobClass, 1)
    if (refusal !== null) return refusal
    return this.call("optimisation", () => this.provider.optimise(request))
  }

  /** Whether a job of this class may make `calls` calls of the family now; the refusal it gets instead, when not. */
  private admit(family: QuotaFamily, jobClass: RoutingJobClass, calls: number): Outcome<never> | null {
    const { state, keyRefusedHere } = this.families[family]
    const now = this.now().getTime()
    if (keyRefusedHere !== null && now < keyRefusedHere + KEY_PROBE_MS) return { kind: "key-refused", sentence: KEY_REFUSED }
    if (state.exhaustedAt !== null) {
      const reopening = this.reopening(state.exhaustedAt, state.resetAt)
      // Past its reopening the family is probed by this job; until then nobody asks.
      return reopening > now ? { kind: "deferred", family, cause: "exhausted", until: this.after(reopening) } : null
    }
    if (state.remaining === null) return null
    // A reading whose reset has passed describes a window that is gone: the call goes ahead.
    if (state.resetAt !== null && state.resetAt.getTime() <= now) return null
    const floor = jobClass === "batch" ? this.reserves[family] : 0
    const left = state.remaining - calls
    if (left >= floor) return null
    const cause = state.remaining <= 0 ? "exhausted" : left < 0 ? "insufficient" : "reserve"
    return { kind: "deferred", family, cause, until: this.after(this.nextReset(state.resetAt, now)) }
  }

  /** One request, paced, its answer read; a 429 waited out and tried once more. */
  private async call<Result>(family: QuotaFamily, ask: () => Promise<ProviderAnswer<Result>>): Promise<Outcome<Result>> {
    const record = this.families[family]
    for (let attempt = 1; ; attempt += 1) {
      await this.pace(family)
      const answer = await ask()
      const now = this.now()
      switch (answer.kind) {
        case "answered":
          record.state = { ...readingOf(answer.quota), exhaustedAt: null, keyRefusedAt: null, observedAt: now }
          record.keyRefusedHere = null
          return { kind: "answered", result: answer.result }
        case "rate-limited": {
          if (answer.quota !== null) record.state = { ...record.state, ...readingOf(answer.quota), observedAt: now }
          if (attempt > 1) throw new RoutingRetryable(`routing: ${this.name} answered ${family} with 429 twice running; pg-boss retries the job`)
          const waitMs = Math.min(answer.retryAfterSeconds ?? 60, 60) * 1000
          this.warn(`routing: ${this.name} answered ${family} with 429, the minute's limit; waiting ${waitMs / 1000} s to try once more`)
          await this.sleep(waitMs)
          continue
        }
        case "quota-exhausted":
          record.state = { ...readingOf(answer.quota), remaining: 0, exhaustedAt: now, keyRefusedAt: null, observedAt: now }
          return { kind: "deferred", family, cause: "exhausted", until: this.after(this.reopening(now, record.state.resetAt)) }
        case "key-refused":
          record.state = { ...record.state, keyRefusedAt: now, observedAt: now }
          record.keyRefusedHere = now.getTime()
          this.error(`routing: ${this.name} refused the key on ${family} (HTTP ${answer.status}); every ${family} job fails for the next hour, then one asks again`)
          return { kind: "key-refused", sentence: KEY_REFUSED }
        case "refused":
          // The provider answered the request, in refusing it: its reading is the family's, the window open and the key good.
          if (answer.quota !== null) {
            record.state = { ...readingOf(answer.quota), exhaustedAt: null, keyRefusedAt: null, observedAt: now }
            record.keyRefusedHere = null
          }
          return { kind: "refused", sentence: answer.sentence }
      }
    }
  }

  /** Waits until the family has made fewer than `callsPerMinute` calls in the last minute, then counts this one. */
  private async pace(family: QuotaFamily): Promise<void> {
    const calls = this.families[family].calls
    for (;;) {
      const now = this.now().getTime()
      while (calls.length > 0 && calls[0] <= now - MINUTE_MS) calls.shift()
      if (calls.length < this.callsPerMinute) {
        calls.push(now)
        return
      }
      await this.sleep(calls[0] + MINUTE_MS - now)
    }
  }

  /** When a family refused for the day at `refused` opens again: the provider's reset, where it lies after the refusal and within a day of it; otherwise, the window unreadable, an hour after the refusal. */
  private reopening(refused: Date, resetAt: Date | null): number {
    const at = refused.getTime()
    const reset = resetAt?.getTime()
    return reset !== undefined && reset > at && reset <= at + DAY_MS ? reset : at + UNREAD_WINDOW_MS
  }

  /** The reset a deferral waits for: the provider's, where it lies ahead within a day; otherwise an hour from now. */
  private nextReset(resetAt: Date | null, now: number): number {
    const reset = resetAt?.getTime()
    return reset !== undefined && reset > now && reset <= now + DAY_MS ? reset : now + UNREAD_WINDOW_MS
  }

  /** An instant plus the jitter. */
  private after(instant: number): Date {
    return new Date(instant + Math.floor(this.random() * JITTER_MS))
  }
}
