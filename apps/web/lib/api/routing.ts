// What the web asks the API of routing (#173): the guided setup's road
// preview (`POST /routing/preview`), the quota the two banners read (`GET
// /routing/quota`), one Plan with its legs (`GET /plans/:id`, fetched only
// when a map draws), and the optimise door a failed Plan's Retry knocks on
// (`POST /routes/:id/optimise`). The routing provider is the API's: no key
// and no provider request ever leaves the browser. The contracts are types
// here; a runtime zod import would land in every workspace route's bundle.
import type { Position2D } from "@waste/contracts/geojson"
import type { OptimiseAnswer, PlanDetail } from "@waste/contracts/plans"
import type { RoutingPreview } from "@waste/contracts/routing-preview"
import type { RoutingQuota } from "@waste/contracts/routing-quota"

import { command, get, type ApiClient } from "./client"

/** The road through the points in order, or the estimate and why; `signal` ends the request when nobody wants the answer any more. */
export function previewRoad(client: ApiClient, points: readonly Position2D[], signal?: AbortSignal): Promise<RoutingPreview> {
  return command<RoutingPreview>(signal === undefined ? client : { ...client, signal }, "/routing/preview", { points })
}

/** The provider's quota as the worker and the preview last read it. */
export function routingQuota(client: ApiClient): Promise<RoutingQuota> {
  return get<RoutingQuota>(client, "/routing/quota")
}

/** One Plan with its legs. */
export function planDetail(client: ApiClient, planId: string, signal?: AbortSignal): Promise<PlanDetail> {
  return get<PlanDetail>(signal === undefined ? client : { ...client, signal }, `/plans/${encodeURIComponent(planId)}`)
}

/** Asks for a Plan over a route's open stops: the Plan it got, and why it is a baseline when it is. */
export function optimiseRoute(client: ApiClient, routeServerId: string): Promise<OptimiseAnswer> {
  return command<OptimiseAnswer>(client, `/routes/${encodeURIComponent(routeServerId)}/optimise`)
}
