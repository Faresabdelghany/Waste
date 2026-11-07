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
//
// An office row is told as it is recorded (`recordOfficeUnload`):
// `unload-recorded`, carrying the unload as every door answers it
// (`unloadAnswered`, shapes/unloads.ts; a row just appended has no review by
// construction, `NO_REVIEW`), dated when the load was tipped. The
// correction emits nothing (#112 §7.26: the outbox carries what another
// context acts on, and the reader of a weight is Finance itself), and the
// driver door tells each event its command made, this one among them.
import type { Unload } from "@waste/contracts/unloads"
import { doesNotTake, takesNoneSet } from "@waste/domain/execution/unloads"
import type { ExecutionSource, UnloadRefusalReason } from "@waste/domain/execution/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import { wasteFraction } from "../schema/catalogue"
import { route, unload } from "../schema/execution"
import { unloadingStation, unloadingStationFraction } from "../schema/places"
import { NO_REVIEW, unloadAnswered, type UnloadRow } from "../shapes/unloads"
import { emit } from "./outbox"
import { lockRow } from "./shared"

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

/** What an office unload says: the route it is on, the project the route is in, where and what was tipped, when, by whose word, the weights, the station's ticket and a note. */
export type OfficeUnload = {
  projectId: string
  routeId: string
  unloadingStationId: string
  wasteFractionId: string
  occurredAt: Date
  recordedBy: string
  grossKg: number | null
  tareKg: number | null
  netKg: number
  weighbridgeTicket: string | null
  note: string | null
  /** Why the station refused the load (O9 of #290), null for one it took; a correction copies its original's. */
  refusalReason: UnloadRefusalReason | null
  refusalNote: string | null
  /** Whose reading it is: the office's, `dispatch`, unless a weighbridge's ticket is written as it (`integration`, O27 of #290). */
  source?: "dispatch" | "integration"
}

/** Appends one office unload — `dispatch`, or a weighbridge's `integration` — and answers the row with the reading a new row has. */
export async function appendUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<UnloadRow> {
  const row = await recordUnload(tx, companyId, { ...draft, source: draft.source ?? "dispatch" })
  return { ...row, ...NO_REVIEW }
}

/** An office unload appended and told: answered as every door answers an unload, and `unload-recorded` written with that answer, dated when the load was tipped. */
export async function recordOfficeUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<Unload> {
  const row = await appendUnload(tx, companyId, draft)
  const answered = await unloadAnswered(tx, companyId, row)
  await emit(tx, { companyId }, { aggregateId: row.id, kind: "unload-recorded", payload: answered, projectId: row.projectId, occurredAt: draft.occurredAt })
  return answered
}

/** Whose word an unload is on: the company and the account recording it. A Principal is one. */
export type Recorder = { companyId: string; user: { id: string } }

/** Writes a matched weighbridge ticket's Unload on its route under the route's lock, `integration`, and tells it; answers the Unload's id. */
export async function writeUnload(tx: Tx, recorder: Recorder, ticket: { routeId: string; wasteFractionId: string; unloadingStationId: string; weighedAt: Date; grossKg: number | null; tareKg: number | null; netKg: number; ticketNumber: string }): Promise<{ unloadId: string; projectId: string }> {
  await lockRow(tx, route, { companyId: recorder.companyId, id: ticket.routeId })
  const [ran] = await tx.select({ projectId: route.projectId }).from(route).where(and(eq(route.companyId, recorder.companyId), eq(route.id, ticket.routeId)))
  if (ran === undefined) throw new Error(`route ${ticket.routeId} vanished under its lock`)
  const answered = await recordOfficeUnload(tx, recorder.companyId, {
    projectId: ran.projectId,
    routeId: ticket.routeId,
    unloadingStationId: ticket.unloadingStationId,
    wasteFractionId: ticket.wasteFractionId,
    occurredAt: ticket.weighedAt,
    recordedBy: recorder.user.id,
    grossKg: ticket.grossKg,
    tareKg: ticket.tareKg,
    netKg: ticket.netKg,
    weighbridgeTicket: ticket.ticketNumber,
    note: null,
    refusalReason: null,
    refusalNote: null,
    source: "integration",
  })
  return { unloadId: answered.id, projectId: answered.projectId }
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
