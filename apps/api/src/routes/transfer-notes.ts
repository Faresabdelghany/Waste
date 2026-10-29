// What an unload's waste transfer note is made of (O18 of #290, row 8.6),
// read for `GET /unloads/:id/transfer-note` (routes/unloads.ts): the unload's
// own row, its fraction with the waste code and the hazardous flag, the
// station that took the load, the company that holds and carries the waste,
// the project's language, clock and name, and the vehicle and driver it came
// on — the session's on a driver-recorded row, the route's actual crew on an
// office capture, else its planned crew. The domain's model
// (@waste/domain/execution/transfer-note) and the renderer (@waste/documents)
// make the file of it.
//
// The unload is a ledger row and never changes; the company, the station and
// the fraction are read as they stand, since nothing froze them on the row,
// so a renamed station prints its new name on a note asked for again. The
// ETag over the bytes says when it did.
//
// A load the station refused was not transferred, and a corrected unload's
// weights are its correction's: neither has a note (`noteRefusal`).
import type { Tx } from "@waste/db/client"
import { route, session } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { company, project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { documentLanguageOf } from "@waste/domain/finance/invoice-document"
import type { TransferNoteInput } from "@waste/domain/execution/transfer-note"
import { and, eq } from "drizzle-orm"

import { problem } from "../problem"
import { dayInTimezone } from "./days"
import { labelOf, type UnloadRow } from "./execution-shapes"

/** The time an instant falls at on a project's clock, `14:32`. */
const timeIn = (instant: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant)

/** Why an unload has no transfer note, as the 409 says it; null where it has one. */
export function noteRefusal(row: UnloadRow): ReturnType<typeof problem> | null {
  if (row.refusalReason !== null) return problem(409, { detail: `Unload ${row.id} was refused by the station: a load turned away was not transferred and has no transfer note` })
  if (row.reviewStatus === "corrected" && row.reviewCorrectionUnloadId !== null) return problem(409, { detail: `This unload was corrected by unload ${row.reviewCorrectionUnloadId}; its transfer note is that one's` })
  return null
}

/** The rows one unload's note is rendered from, under its company. */
export async function transferNoteInputOf(tx: Tx, companyId: string, row: UnloadRow): Promise<TransferNoteInput> {
  const [[holder], [scope], [ran], [station], [fraction], [crew]] = await Promise.all([
    tx.select({ legalName: company.legalName, registrationNumber: company.registrationNumber, postalAddress: company.postalAddress }).from(company).where(eq(company.id, companyId)),
    tx.select({ name: project.name, language: project.language, timezone: project.timezone }).from(project).where(and(eq(project.companyId, companyId), eq(project.id, row.projectId))),
    tx
      .select({ number: route.number, actualVehicleId: route.actualVehicleId, actualDriverId: route.actualDriverId, plannedVehicleId: route.plannedVehicleId, plannedDriverId: route.plannedDriverId })
      .from(route)
      .where(and(eq(route.companyId, companyId), eq(route.id, row.routeId))),
    tx.select({ name: unloadingStation.name, code: unloadingStation.code, address: unloadingStation.address }).from(unloadingStation).where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, row.unloadingStationId))),
    tx.select({ name: wasteFraction.name, wasteCode: wasteFraction.wasteCode, hazardous: wasteFraction.hazardous }).from(wasteFraction).where(and(eq(wasteFraction.companyId, companyId), eq(wasteFraction.id, row.wasteFractionId))),
    row.sessionId === null
      ? Promise.resolve([])
      : tx.select({ vehicleId: session.vehicleId, driverId: session.driverId }).from(session).where(and(eq(session.companyId, companyId), eq(session.id, row.sessionId))),
  ])
  if (holder === undefined || scope === undefined || ran === undefined || station === undefined || fraction === undefined) throw new Error(`transferNoteInputOf: unload ${row.id} is missing a row it names under company ${companyId}`)
  const vehicleId = crew?.vehicleId ?? ran.actualVehicleId ?? ran.plannedVehicleId
  const driverId = crew?.driverId ?? ran.actualDriverId ?? ran.plannedDriverId
  const [[truck], [person]] = await Promise.all([
    vehicleId === null ? Promise.resolve([]) : tx.select({ registration: vehicle.registration }).from(vehicle).where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, vehicleId))),
    driverId === null ? Promise.resolve([]) : tx.select({ name: driver.name }).from(driver).where(and(eq(driver.companyId, companyId), eq(driver.id, driverId))),
  ])
  return {
    language: documentLanguageOf(scope.language),
    unloadId: row.id,
    occurredOn: dayInTimezone(row.occurredAt, scope.timezone),
    occurredAt: timeIn(row.occurredAt, scope.timezone),
    timezone: scope.timezone,
    projectName: scope.name,
    holder,
    carrier: { vehicleRegistration: truck?.registration ?? null, driverName: person?.name ?? null, routeLabel: labelOf(ran) },
    station,
    waste: { fractionName: fraction.name, wasteCode: fraction.wasteCode, hazardous: fraction.hazardous, netKg: row.netKg, grossKg: row.grossKg, tareKg: row.tareKg },
    weighbridgeTicket: row.weighbridgeTicket,
    note: row.note,
  }
}
