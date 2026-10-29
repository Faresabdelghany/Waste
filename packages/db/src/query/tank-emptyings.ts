// A tank's last emptying (M11 of #293): its container's latest completed
// stop, by the day its route ran, and the litres the driver recorded there.
// The one reading the API's register answers and generation's due-from-last
// cadence reckons from (`tankDueOn`, @waste/domain/route-schemes/due-from-last),
// so the day a tank is due on the office's screen is the day the run plans
// it from. A container with no completed stop is not in the map.
import { and, desc, eq, inArray, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup, proofOfService, route } from "../schema/execution"

export type TankEmptying = { on: string; pickupId: string; volumeLitres: number | null }

export async function lastEmptyings(tx: Tx, companyId: string, containerIds: readonly string[]): Promise<Map<string, TankEmptying>> {
  if (containerIds.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([pickup.containerId], {
      containerId: pickup.containerId,
      on: route.operatingDate,
      pickupId: pickup.id,
      // The stop's latest volume: a reading put right is recorded again.
      volumeLitres: sql<number | null>`(
        select ${proofOfService.volumeLitres} from ${proofOfService}
        where ${proofOfService.companyId} = ${pickup.companyId} and ${proofOfService.pickupId} = ${pickup.id} and ${proofOfService.kind} = 'volume'
        order by ${proofOfService.id} desc limit 1
      )`,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(and(eq(pickup.companyId, companyId), inArray(pickup.containerId, [...containerIds]), eq(pickup.status, "completed")))
    .orderBy(pickup.containerId, desc(route.operatingDate), desc(pickup.outcomeAt), desc(pickup.id))
  return new Map(rows.flatMap((row) => (row.containerId === null ? [] : [[row.containerId, { on: row.on, pickupId: row.pickupId, volumeLitres: row.volumeLitres }] as const])))
}
