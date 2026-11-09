// `GET /routing/quota` (#171, decided on #132 §5): what the quota engine last
// knew of each request family of the provider this deployment routes with,
// for the one banner Route Studio and the guided setup's footer show while a
// family is exhausted or the key refused. The rows are the worker's, written
// after every job that asked the provider (@waste/db/commands/routing-quota),
// and per company like every table — the provider's key is one account the
// companies share, so with the Pilot's one company they are its readings
// whole (ADR-0009); a row of another provider is not this deployment's. A
// route's own waiting is its active Plan's `deferredUntil`, never a join to
// this. The grant is `route-studio.routes` `view`, the module the Plans are
// read under (#124 §5).
import { RoutingQuota } from "@waste/contracts/routing-quota"
import { quotaRows } from "@waste/db/commands/routing-quota"

import type { RouteDeps } from "../deps"
import { describeJson, routes } from "../operation"

const MODULE = "route-studio.routes"

const instant = (value: Date | null): string | null => (value === null ? null : value.toISOString())

export function routingQuotaRoutes(deps: RouteDeps) {
  const { routing } = deps
  return routes(deps).get(
    "/routing/quota",
    {
      operationId: "getRoutingQuota",
      summary: "The routing provider's quota, as the worker last read it",
      description:
        "The provider this deployment routes with and, per request family (`directions`, `optimisation`), what its quota engine last knew: the provider's own reading — `remaining` and `limit` off `x-ratelimit-*`, `resetAt` when the daily window resets — and since when the family is exhausted (`exhaustedAt`: its jobs wait for `resetAt`) or the key refused (`keyRefusedAt`: \"Routing unavailable: key refused\"). A family appears once the provider has been asked of it; the fake reports no limit, so its counts are null. Written by the worker after every job that asked the provider; a route's own waiting is its active Plan's `deferredUntil`.",
      module: MODULE,
      action: "view",
      responses: {
        200: describeJson("The provider and a reading per family asked of it.", RoutingQuota),
      },
    },
    async (c) => {
      const rows = await quotaRows(c.get("tx"), { companyId: c.get("principal").companyId, provider: routing.name })
      const answer: RoutingQuota = {
        provider: routing.name,
        families: rows.map((row) => ({
          family: row.family,
          remaining: row.remaining,
          limit: row.limit,
          resetAt: instant(row.resetAt),
          exhaustedAt: instant(row.exhaustedAt),
          keyRefusedAt: instant(row.keyRefusedAt),
          updatedAt: row.updatedAt.toISOString(),
        })),
      }
      return c.json(answer)
    },
  )
}
