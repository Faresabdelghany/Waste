// Fleet readers for the guided setup (2026-09-16 redesign): what a vehicle
// or driver record says about itself in the fields the wizard needs —
// callsign, type, capacity, licence class, and the licences a driver holds.
// Pure data logic (type-only import of BusinessRecord).
//
// Gap adapter: vehicle records carry no licence class, so it is derived from
// capacity (anything over 3.5 t needs C; a trailer needs CE). Driver
// licences are free text in facts.Licence ("C/CE + crane · valid 2028"); a
// driver whose licences cannot be read is treated as eligible for every
// vehicle rather than hidden.

import type { BusinessRecord } from "../data/business-modules"
import { vehicleTypeOfRecord } from "./matching"

type RecordLike = Pick<BusinessRecord, "id" | "name" | "context" | "facts" | "submittedValues">

export type LicenceClass = "B" | "C" | "CE"

export type VehicleProfile = {
  id: string
  /** "WH-24" — the callsign before the plate in the record name. */
  callsign: string
  /** Canonical vehicle type when the record names one, else the context's type text. */
  type: string | null
  capacityT: number | null
  licenceClass: LicenceClass
  isTrailer: boolean
}

const stringOf = (record: RecordLike, key: string): string | undefined => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** "18 t" / "18" / "Rear loader 18 t · Nordhavn" → 18; null when nothing numeric precedes a t. */
export function parseTonnes(text: string | undefined): number | null {
  if (!text) return null
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*t\b/i) ?? text.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/)
  if (!match) return null
  const value = Number(match[1].replace(",", "."))
  return Number.isFinite(value) ? value : null
}

const LIGHT_VEHICLE_MAX_T = 3.5

export function vehicleProfile(record: RecordLike): VehicleProfile {
  const facts = record.facts ?? {}
  const contextType = record.context.split(" · ")[0]?.trim() ?? ""
  const isTrailer =
    stringOf(record, "resourceKind") === "trailer" ||
    /trailer/i.test(record.context) ||
    /trailer/i.test(facts.Type ?? "")
  const capacityT =
    parseTonnes(facts.Capacity) ?? parseTonnes(stringOf(record, "capacity")) ?? parseTonnes(contextType)
  const type =
    vehicleTypeOfRecord(record) ??
    (contextType ? contextType.replace(/\s*\d+(?:[.,]\d+)?\s*t\b.*$/i, "").trim() || null : null)
  const licenceClass: LicenceClass = isTrailer
    ? "CE"
    : capacityT !== null && capacityT <= LIGHT_VEHICLE_MAX_T
      ? "B"
      : "C"
  return {
    id: record.id,
    callsign: record.name.split(" · ")[0]?.trim() || record.name,
    type,
    capacityT,
    licenceClass,
    isTrailer,
  }
}

/** "WH-24 · Rear loader · 18 t" — the vehicle select's option text. */
export function vehicleOptionLabel(profile: VehicleProfile): string {
  return [profile.callsign, profile.type, profile.capacityT !== null ? `${profile.capacityT} t` : null]
    .filter(Boolean)
    .join(" · ")
}

/** Vehicles a collection group can run with: powered vehicles, no trailers. */
export function collectionVehicles<T extends RecordLike>(records: readonly T[]): T[] {
  return records.filter((record) => !vehicleProfile(record).isTrailer)
}

export type DriverProfile = {
  id: string
  name: string
  /** Licence classes read from the record; empty = unknown. */
  licences: LicenceClass[]
}

const LICENCE_CLASSES: readonly LicenceClass[] = ["B", "C", "CE"]

/** "C/CE + crane · valid 2028" → ["C", "CE"]; unknown text → []. */
export function parseLicences(text: string | undefined): LicenceClass[] {
  if (!text) return []
  const head = text.split(" · ")[0] ?? text
  const found = new Set<LicenceClass>()
  for (const token of head.split(/[\/+,\s]+/)) {
    const upper = token.trim().toUpperCase()
    if ((LICENCE_CLASSES as readonly string[]).includes(upper)) found.add(upper as LicenceClass)
  }
  return LICENCE_CLASSES.filter((licence) => found.has(licence))
}

export function driverProfile(record: RecordLike): DriverProfile {
  const facts = record.facts ?? {}
  const licences = parseLicences(facts.Licence)
  return {
    id: record.id,
    name: record.name,
    licences: licences.length > 0 ? licences : parseLicences(stringOf(record, "licenceClass")),
  }
}

/** CE implies C, C implies B. */
const IMPLIED_BY: Record<LicenceClass, readonly LicenceClass[]> = {
  B: ["B", "C", "CE"],
  C: ["C", "CE"],
  CE: ["CE"],
}

/** Whether the driver may drive a vehicle of the class; unknown licences are eligible. */
export function driverHoldsLicence(driver: DriverProfile, licenceClass: LicenceClass): boolean {
  if (driver.licences.length === 0) return true
  return driver.licences.some((held) => IMPLIED_BY[licenceClass].includes(held))
}

export function eligibleDrivers(
  drivers: readonly DriverProfile[],
  vehicle: VehicleProfile | null | undefined,
): DriverProfile[] {
  if (!vehicle) return [...drivers]
  return drivers.filter((driver) => driverHoldsLicence(driver, vehicle.licenceClass))
}

/** "Mads Jensen · C, CE" — the driver select's option text; name alone when licences are unknown. */
export function driverOptionLabel(driver: DriverProfile): string {
  return driver.licences.length > 0 ? `${driver.name} · ${driver.licences.join(", ")}` : driver.name
}
