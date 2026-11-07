// A scale ticket on the wire with its lines (M16a of #293): the columns, the
// row types and `scaleTicketOf`, which the scale house answers and
// `scale-ticket-completed` and `scale-ticket-voided` carry.
import type { ScaleTicket } from "@waste/contracts/scale-house"
import { and, asc, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { scaleTicket, scaleTicketLine } from "../schema/scale-house"
import { instantOf, stampsOf } from "./times"

export const scaleTicketColumns = {
  id: scaleTicket.id,
  projectId: scaleTicket.projectId,
  createdAt: scaleTicket.createdAt,
  updatedAt: scaleTicket.updatedAt,
  number: scaleTicket.number,
  unloadingStationId: scaleTicket.unloadingStationId,
  vehiclePlate: scaleTicket.vehiclePlate,
  trailerPlate: scaleTicket.trailerPlate,
  containerRef: scaleTicket.containerRef,
  vehicleId: scaleTicket.vehicleId,
  party: scaleTicket.party,
  customerId: scaleTicket.customerId,
  agreementId: scaleTicket.agreementId,
  visitorName: scaleTicket.visitorName,
  grossKg: scaleTicket.grossKg,
  weighedInAt: scaleTicket.weighedInAt,
  tareKg: scaleTicket.tareKg,
  tareSource: scaleTicket.tareSource,
  vehicleTareId: scaleTicket.vehicleTareId,
  weighedOutAt: scaleTicket.weighedOutAt,
  netKg: scaleTicket.netKg,
  status: scaleTicket.status,
  routeId: scaleTicket.routeId,
  unloadId: scaleTicket.unloadId,
  unmatchedReason: scaleTicket.unmatchedReason,
  voidReason: scaleTicket.voidReason,
  voidNote: scaleTicket.voidNote,
  voidedAt: scaleTicket.voidedAt,
  note: scaleTicket.note,
  recordedBy: scaleTicket.recordedBy,
}

export type ScaleTicketRow = Pick<typeof scaleTicket.$inferSelect, keyof typeof scaleTicketColumns>

export const scaleLineColumns = {
  id: scaleTicketLine.id,
  ticketId: scaleTicketLine.ticketId,
  position: scaleTicketLine.position,
  wasteFractionId: scaleTicketLine.wasteFractionId,
  originMunicipality: scaleTicketLine.originMunicipality,
  netKg: scaleTicketLine.netKg,
  productId: scaleTicketLine.productId,
  volumeLitres: scaleTicketLine.volumeLitres,
}

export type ScaleLineRow = Pick<typeof scaleTicketLine.$inferSelect, keyof typeof scaleLineColumns>

export const scaleTicketOf = (row: ScaleTicketRow, lines: readonly ScaleLineRow[]): ScaleTicket => ({
  id: row.id,
  ...stampsOf(row),
  projectId: row.projectId,
  number: row.number,
  unloadingStationId: row.unloadingStationId,
  vehiclePlate: row.vehiclePlate,
  trailerPlate: row.trailerPlate,
  containerRef: row.containerRef,
  vehicleId: row.vehicleId,
  party: row.party,
  customerId: row.customerId,
  agreementId: row.agreementId,
  visitorName: row.visitorName,
  grossKg: row.grossKg,
  weighedInAt: row.weighedInAt.toISOString(),
  tareKg: row.tareKg,
  tareSource: row.tareSource,
  vehicleTareId: row.vehicleTareId,
  weighedOutAt: instantOf(row.weighedOutAt),
  netKg: row.netKg,
  status: row.status,
  lines: lines.map((line) => ({ id: line.id, position: line.position, wasteFractionId: line.wasteFractionId, originMunicipality: line.originMunicipality, netKg: line.netKg, productId: line.productId, volumeLitres: line.volumeLitres })),
  routeId: row.routeId,
  unloadId: row.unloadId,
  unmatchedReason: row.unmatchedReason,
  voidReason: row.voidReason,
  voidNote: row.voidNote,
  voidedAt: instantOf(row.voidedAt),
  note: row.note,
  recordedBy: row.recordedBy,
})

/** The tickets with their lines, in position order, read in one statement. */
export async function scaleTicketsOf(tx: Tx, companyId: string, rows: readonly ScaleTicketRow[]): Promise<ScaleTicket[]> {
  if (rows.length === 0) return []
  const lines = await tx
    .select(scaleLineColumns)
    .from(scaleTicketLine)
    .where(
      and(
        eq(scaleTicketLine.companyId, companyId),
        inArray(
          scaleTicketLine.ticketId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(scaleTicketLine.ticketId), asc(scaleTicketLine.position))
  const byTicket = new Map<string, ScaleLineRow[]>()
  for (const line of lines) byTicket.set(line.ticketId, [...(byTicket.get(line.ticketId) ?? []), line])
  return rows.map((row) => scaleTicketOf(row, byTicket.get(row.id) ?? []))
}
