// An Unload recorded, written once for every door that records one (Issue
// #104, #112 §3, O9 and O27 of #290): the driver's `record-unload` (apps/api's
// routes/driver.ts), the office's capture and correction (routes/unloads.ts,
// routes/weight-control.ts) and a weighbridge's ticket matched to a route, by
// its batch, by hand or at the scale house (routes/weighbridge.ts,
// routes/scale-house.ts). An unload is a ledger row: appended, never updated,
// a wrong one corrected by a new row naming the old (#104 §2).
//
// What the doors differ on is theirs: the driver's row names its session,
// its device, its place and its photo, under the id its device minted; an
// office row names none of them (`unload_session_shape`), `dispatch`, or
// `integration` for a weighbridge's reading. Whether the station takes the
// fraction (`stationTakes`) is asked by every door of an accepted load and
// answered by each its own way: the office's capture refuses it at the field
// in the station's sentence (`notTaken`), while the driver's load is tipped,
// so it is recorded all the same and the office told.
import { doesNotTake, takesNoneSet } from "@waste/domain/execution/unloads"
import type { ExecutionSource } from "@waste/domain/execution/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import { wasteFraction } from "../schema/catalogue"
import { unload } from "../schema/execution"
import { unloadingStation, unloadingStationFraction } from "../schema/places"

type Columns = typeof unload.$inferInsert

/** What an unload says: the route it is on, where and what was tipped, when, by whose word and from which source, the weights, the station's ticket, a note, a refusal; and what only the driver's carries. */
export type UnloadDraft = Pick<Columns, "projectId" | "routeId" | "unloadingStationId" | "wasteFractionId" | "occurredAt" | "recordedBy" | "grossKg" | "tareKg" | "netKg" | "weighbridgeTicket" | "note" | "refusalReason" | "refusalNote"> & {
  source: ExecutionSource
  /** The device's id for the driver's row; the server mints an office row's. */
  id?: string
} & Partial<Pick<Columns, "sessionId" | "deviceId" | "location" | "objectKey">>

/** Appends one unload; answers the row. */
export async function recordUnload(tx: Tx, companyId: string, draft: UnloadDraft): Promise<typeof unload.$inferSelect> {
  const [row] = await tx
    .insert(unload)
    .values({ sessionId: null, deviceId: null, location: null, objectKey: null, ...draft, id: draft.id ?? newId(), companyId })
    .returning()
  return row
}

/** What a station says of a fraction an unload names: both names, whether the station takes it, and whether the station names any fraction it takes. */
export type StationTakes = { stationName: string; fractionName: string; takes: boolean; takesAny: boolean }

/** The station's accepted fractions against the one an unload names, in one statement; both are the company's already, checked by the door. A station that names none takes nothing, as the route's assignment holds it. */
export async function stationTakes(tx: Tx, companyId: string, stationId: string, fractionId: string): Promise<StationTakes> {
  const accepted = and(eq(unloadingStationFraction.companyId, companyId), eq(unloadingStationFraction.unloadingStationId, unloadingStation.id))
  const [row] = await tx
    .select({
      stationName: unloadingStation.name,
      fractionName: wasteFraction.name,
      takes: sql<boolean>`exists (select 1 from ${unloadingStationFraction} where ${and(accepted, eq(unloadingStationFraction.wasteFractionId, wasteFraction.id))})`,
      takesAny: sql<boolean>`exists (select 1 from ${unloadingStationFraction} where ${accepted})`,
    })
    .from(unloadingStation)
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, companyId), eq(wasteFraction.id, fractionId)))
    .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, stationId)))
    .limit(1)
  if (row === undefined) throw new Error(`station ${stationId} or fraction ${fractionId} is not company ${companyId}'s, which the door checked`)
  return row
}

/** What an accepted unload of a fraction the station does not take is told: the station's sentence, or that it names none. */
export const notTaken = (takes: StationTakes): string => (takes.takesAny ? doesNotTake(takes.stationName, takes.fractionName) : takesNoneSet(takes.stationName))
