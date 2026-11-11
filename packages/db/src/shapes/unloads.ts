// An Unload on the wire (Issue #104, #112 §5, O9 and O27 of #290): the
// columns, the row type with Weight control's reading beside it, and the one
// answer every door gives — the route's read, the office's capture, the
// driver door's replay and `unload-recorded`'s payload: `unloadsAnswered`.
import type { WeightReviewState } from "@waste/contracts/finance"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { LoadReading, Unload } from "@waste/contracts/unloads"
import { loadReading, onBoardByUnload } from "@waste/domain/execution/unloads"
import { possibleDuplicates } from "@waste/domain/execution/weighbridge"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { reviewStatus, weightReviewOf } from "../query/weight-review"
import { pickup, proofOfService, unload } from "../schema/execution"
import { project } from "../schema/organisation"

export const unloadColumns = {
  id: unload.id,
  recordedAt: unload.recordedAt,
  projectId: unload.projectId,
  routeId: unload.routeId,
  sessionId: unload.sessionId,
  unloadingStationId: unload.unloadingStationId,
  wasteFractionId: unload.wasteFractionId,
  source: unload.source,
  occurredAt: unload.occurredAt,
  recordedBy: unload.recordedBy,
  deviceId: unload.deviceId,
  location: unload.location,
  grossKg: unload.grossKg,
  tareKg: unload.tareKg,
  netKg: unload.netKg,
  weighbridgeTicket: unload.weighbridgeTicket,
  objectKey: unload.objectKey,
  note: unload.note,
  refusalReason: unload.refusalReason,
  refusalNote: unload.refusalNote,
}

// Weight control's reading beside every Unload (Issue #112, §5): the latest
// `weight_review` of the row — its decision folded onto the status, its id,
// and the new Unload a correction wrote — joined LATERAL through
// `weightReviewOf` (@waste/db/query/weight-review, the `assetStateOf` shape:
// one backward probe per row into `weight_review_unload_id_idx`, never a
// fold of the whole ledger), so a page, a single read, the route's detail,
// the driver door's replay and the answer to a capture all say the same thing
// about an unload's weight. A row just appended has no review by
// construction and reads through `NO_REVIEW` instead of a join.

/** The reading's columns beside the unload's own, as the one statement below selects them; null on a LATERAL left join that found no review, `captured` from the fold either way. */
const reviewColumns = (review: ReturnType<typeof weightReviewOf>) => ({
  reviewStatus: reviewStatus(review.decision),
  reviewId: review.reviewId,
  reviewCorrectionUnloadId: review.correctionUnloadId,
})

export type ReviewRead = { reviewStatus: WeightReviewStatus; reviewId: string | null; reviewCorrectionUnloadId: string | null }

export type UnloadRow = Pick<typeof unload.$inferSelect, keyof typeof unloadColumns> & ReviewRead

/** The reading an unload has before anybody looks: what a capture and a correction answer, since a row just made has none by construction. */
export const NO_REVIEW: ReviewRead = { reviewStatus: "captured", reviewId: null, reviewCorrectionUnloadId: null }

/**
 * The one statement every unload is read through: the row with the review
 * ledger's reading joined LATERAL — one probe per row for its latest review
 * (`weightReviewOf`). The subquery is handed back beside the query for a
 * filter over it (`GET /unloads?reviewStatus=`).
 */
export function unloadsFrom(tx: Tx, companyId: string) {
  const review = weightReviewOf(tx, companyId, unload.id)
  return { review, query: tx.select({ ...unloadColumns, ...reviewColumns(review) }).from(unload).leftJoinLateral(review, sql`true`) }
}

/** The reading as the wire spells it: `captured` with two nulls where no review exists, else the latest decision with its review and, on a correction, the new row. */
export const weightReviewOfRow = (row: ReviewRead): WeightReviewState => ({ status: row.reviewStatus, latestReviewId: row.reviewId, correctionUnloadId: row.reviewCorrectionUnloadId })

/** The unload on the wire, its review reading beside it, and the load on board where `unloadsAnswered` read one. */
export function unloadOf(row: UnloadRow, load: LoadReading | null = null, possibleDuplicates: readonly string[] = []): Unload {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    unloadingStationId: row.unloadingStationId,
    wasteFractionId: row.wasteFractionId,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    deviceId: row.deviceId,
    location: row.location as FlatPoint | null,
    grossKg: row.grossKg,
    tareKg: row.tareKg,
    netKg: row.netKg,
    weighbridgeTicket: row.weighbridgeTicket,
    objectKey: row.objectKey,
    note: row.note,
    weightReview: weightReviewOfRow(row),
    refusal: row.refusalReason === null ? null : { reason: row.refusalReason, note: row.refusalNote },
    load,
    possibleDuplicates: [...possibleDuplicates],
  }
}

/**
 * Each unload's load on board against its weighbridge net (O9 of #290): what
 * the stops of its fraction weighed since the route's last accepted unload of
 * it (`onBoardByUnload`), read against the project's tolerance
 * (`loadReading`). The window needs every unload of the route, not only the
 * rows answered, and each stop's latest weight at the instant the stop was
 * first weighed, so a weight corrected after the truck tipped stays with the
 * load it was tipped in. A row with no stop weighed before it is absent.
 */
async function loadsOf(tx: Tx, companyId: string, rows: readonly UnloadRow[]): Promise<Map<string, LoadReading>> {
  if (rows.length === 0) return new Map()
  const routeIds = [...new Set(rows.map((row) => row.routeId))]
  const projectIds = [...new Set(rows.map((row) => row.projectId))]
  const unloads = await tx
    .select({ id: unload.id, routeId: unload.routeId, wasteFractionId: unload.wasteFractionId, occurredAt: unload.occurredAt, refusalReason: unload.refusalReason })
    .from(unload)
    .where(and(eq(unload.companyId, companyId), inArray(unload.projectId, projectIds), inArray(unload.routeId, routeIds)))
  const weights = await tx
    .select({
      routeId: proofOfService.routeId,
      wasteFractionId: pickup.wasteFractionId,
      occurredAt: sql<Date>`min(${proofOfService.occurredAt})`.mapWith(proofOfService.occurredAt),
      weightKg: sql<number | null>`(array_agg(${proofOfService.weightKg} order by ${proofOfService.id} desc))[1]`,
    })
    .from(proofOfService)
    .innerJoin(pickup, and(eq(pickup.companyId, proofOfService.companyId), eq(pickup.id, proofOfService.pickupId)))
    .where(and(eq(proofOfService.companyId, companyId), inArray(proofOfService.projectId, projectIds), inArray(proofOfService.routeId, routeIds), eq(proofOfService.kind, "weight")))
    .groupBy(proofOfService.pickupId, proofOfService.routeId, pickup.wasteFractionId)
  const tolerances = new Map(
    (await tx.select({ id: project.id, tolerance: project.weightTolerancePercent }).from(project).where(and(eq(project.companyId, companyId), inArray(project.id, projectIds)))).map((row) => [row.id, row.tolerance]),
  )
  type UnloadAt = Parameters<typeof onBoardByUnload>[0][number]
  type WeightAt = Parameters<typeof onBoardByUnload>[1][number]
  const byRoute = new Map<string, { unloads: UnloadAt[]; weights: WeightAt[] }>(routeIds.map((routeId) => [routeId, { unloads: [], weights: [] }]))
  for (const row of unloads) byRoute.get(row.routeId)?.unloads.push({ id: row.id, wasteFractionId: row.wasteFractionId, occurredAt: row.occurredAt.toISOString(), refused: row.refusalReason !== null })
  for (const row of weights) if (row.weightKg !== null) byRoute.get(row.routeId)?.weights.push({ wasteFractionId: row.wasteFractionId, occurredAt: row.occurredAt.toISOString(), weightKg: row.weightKg })
  const onBoard = new Map<string, number>()
  for (const ofRoute of byRoute.values()) for (const [id, kg] of onBoardByUnload(ofRoute.unloads, ofRoute.weights)) onBoard.set(id, kg)
  const loads = new Map<string, LoadReading>()
  for (const row of rows) {
    const onBoardKg = onBoard.get(row.id)
    const tolerance = tolerances.get(row.projectId)
    const reading = onBoardKg === undefined || tolerance === undefined ? null : loadReading({ netKg: row.netKg, onBoardKg }, tolerance)
    if (reading !== null) loads.set(row.id, reading)
  }
  return loads
}

/**
 * Each unload's possible duplicates (O27 of #290): a weighbridge's Unload and
 * one recorded by hand on the same route and fraction, both taken and both
 * still open to review (`possibleDuplicates`). Read over every unload of the
 * rows' routes, not only the rows answered, with each one's review reading, so
 * the pair is told on whichever of the two a page holds.
 */
async function duplicatesOf(tx: Tx, companyId: string, rows: readonly UnloadRow[]): Promise<Map<string, string[]>> {
  if (rows.length === 0) return new Map()
  const routeIds = [...new Set(rows.map((row) => row.routeId))]
  const projectIds = [...new Set(rows.map((row) => row.projectId))]
  const siblings = await unloadsFrom(tx, companyId).query.where(and(eq(unload.companyId, companyId), inArray(unload.projectId, projectIds), inArray(unload.routeId, routeIds)))
  return possibleDuplicates(
    siblings.map((sibling) => ({
      id: sibling.id,
      routeId: sibling.routeId,
      wasteFractionId: sibling.wasteFractionId,
      source: sibling.source,
      refused: sibling.refusalReason !== null,
      settled: sibling.reviewStatus === "rejected" || sibling.reviewStatus === "corrected",
    })),
  )
}

/** Unloads as every door answers them: each with its review reading, its load on board (`loadsOf`) and its possible duplicates (`duplicatesOf`), in the rows' order. */
export async function unloadsAnswered(tx: Tx, companyId: string, rows: readonly UnloadRow[]): Promise<Unload[]> {
  const [loads, duplicates] = await Promise.all([loadsOf(tx, companyId, rows), duplicatesOf(tx, companyId, rows)])
  return rows.map((row) => unloadOf(row, loads.get(row.id) ?? null, duplicates.get(row.id) ?? []))
}

export async function unloadAnswered(tx: Tx, companyId: string, row: UnloadRow): Promise<Unload> {
  const [answered] = await unloadsAnswered(tx, companyId, [row])
  return answered
}

export async function unloadsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<UnloadRow[]> {
  return await unloadsFrom(tx, companyId)
    .query.where(and(eq(unload.companyId, companyId), eq(unload.routeId, routeId)))
    .orderBy(asc(unload.id))
}
