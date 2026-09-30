// What the office is told of routing (#173, decided on #132 §5 and #124 §6):
// the sentences the banners, the guided setup's step 4 and the maps share,
// spelled once. Pure; the components read them.
//
// - When the quota resumes, as a person reads a clock: "resumes at 14:32",
//   "resumes tomorrow at 09:00".
// - The banner Route Studio and step 4 show while a request family of the
//   provider is exhausted or its key refused, off `GET /routing/quota` alone.
// - What a drafted route's numbers are in step 4: the road's, or the
//   prototype's estimate and why there is no road.
// - The attribution a map owes the provider's geometry (CC-BY-SA 4.0): the
//   directions sentence, and the optimisation one for a trip an optimiser
//   ordered; the fake's straight legs are nobody's data and owe none.
import type { RoutingQuota, RoutingQuotaFamily } from "@waste/contracts/routing-quota"

/** The directions attribution OpenRouteService's results carry (#124 §6). */
export const ORS_ATTRIBUTION = "© openrouteservice by HeiGIT | Data from OpenStreetMap"
/** The attribution of a trip VROOM ordered on OpenRouteService (#124 §6). */
export const VROOM_ATTRIBUTION = "Developed by vroom | Hosted by HeiGIT | Routing by openrouteservice | Data from OpenStreetMap"

/** The provider whose results owe the attribution. */
export const OPENROUTESERVICE = "openrouteservice"

/** What #132 §4 says the office reads when the provider refuses the key. */
export const KEY_REFUSED_SENTENCE = "Routing unavailable: key refused"
/** The start of every sentence that waits for the quota (#132 §5). */
export const WAITING_FOR_QUOTA = "Waiting for routing quota"

const clock = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`

const dayOf = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** When the quota opens again, on the browser's clock: "resumes at 14:32", "resumes tomorrow at 09:00", further out "resumes on 3 Oct at 09:00". */
export function resumesPhrase(resumesAt: string, now: Date): string {
  const at = new Date(resumesAt)
  if (Number.isNaN(at.getTime())) return "resumes later"
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000)
  if (days <= 0) return `resumes at ${clock(at)}`
  if (days === 1) return `resumes tomorrow at ${clock(at)}`
  return `resumes on ${at.getDate()} ${SHORT_MONTHS[at.getMonth()]} at ${clock(at)}`
}

/** What each request family is to the office. */
const FAMILY_NOUN: Record<RoutingQuotaFamily, string> = {
  directions: "road measurements",
  optimisation: "optimisations",
}

export type QuotaBanner = { tone: "refused" | "waiting"; sentence: string }

/**
 * The banner the quota's reading calls for, or null while every family
 * answers: the key refused before anything else, since nothing waits it out;
 * otherwise each family whose day is spent and whose reset lies ahead, with
 * when it resumes. A reset gone by is a window gone: the next call probes it.
 */
export function quotaBanner(quota: RoutingQuota | null | undefined, now: Date): QuotaBanner | null {
  if (!quota) return null
  if (quota.families.some((family) => family.keyRefusedAt !== null)) return { tone: "refused", sentence: KEY_REFUSED_SENTENCE }
  const waiting = quota.families.filter((family) => family.exhaustedAt !== null && (family.resetAt === null || Date.parse(family.resetAt) > now.getTime()))
  if (waiting.length === 0) return null
  const parts = waiting.map((family) => `${FAMILY_NOUN[family.family]} ${family.resetAt === null ? "resume later" : resumesPhrase(family.resetAt, now).replace(/^resumes/, "resume")}`)
  return { tone: "waiting", sentence: `${WAITING_FOR_QUOTA}: ${parts.join("; ")}` }
}

/** What step 4 knows of a drafted route's road, for its label. */
export type PreviewRoadReading =
  | { status: "ready" }
  | { status: "pending" }
  | { status: "estimate"; resumesAt: string | null }
  | { status: "failed" }
  | { status: "off" }

/**
 * What step 4 says a drafted route's numbers are: the road's, or the
 * prototype's estimate — plain where there is nothing to ask (one stop, no
 * API), and otherwise why: the road on its way, the quota resuming at a
 * time, or no road to be had.
 */
export function previewBasisLabel(road: PreviewRoadReading | undefined, { roadBasis, stops, now }: { roadBasis: boolean; stops: number; now: Date }): string {
  if (roadBasis) return "Road"
  if (stops < 2 || road === undefined || road.status === "off") return "Estimate"
  if (road.status === "pending") return "Estimate · road loading"
  if (road.status === "estimate" && road.resumesAt !== null) return `Estimate · ${resumesPhrase(road.resumesAt, now)}`
  return "Estimate · road unavailable"
}

/** Whose geometry a drawn road is, as the attribution reads it. */
export type AttributionSource = { provider: string; optimised: boolean }

/** The attribution lines the drawn roads owe, each once, the directions sentence first; none for a road that is no provider's data. */
export function attributionFor(sources: Iterable<AttributionSource>): string[] {
  let directions = false
  let optimised = false
  for (const source of sources) {
    if (source.provider !== OPENROUTESERVICE) continue
    if (source.optimised) optimised = true
    else directions = true
  }
  return [...(directions ? [ORS_ATTRIBUTION] : []), ...(optimised ? [VROOM_ATTRIBUTION] : [])]
}
