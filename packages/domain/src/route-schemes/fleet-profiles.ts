// Fleet readers for the guided setup (2026-09-16 redesign): what a vehicle
// or driver record says about itself in the fields the wizard needs —
// callsign, type, capacity, the licence class a vehicle requires and the one
// a driver holds. Pure data logic (type-only import of BusinessRecord).
//
// The licence class is a typed field on both records (issue #37): a driver's
// `licenceClass` (B, C or CE, the highest held — CE covers C, C covers B) with
// an optional `licenceExpiry`, a vehicle's `requiredLicenceClass`. Nothing is
// parsed out of a display fact and nothing is derived from capacity: a record
// whose field is absent or not one of the three reads as unknown.
// Safety rule: unknown never passes. A driver whose licence cannot be read is
// NOT eligible for any vehicle, and a vehicle whose class cannot be read can
// judge nobody — the driver is still listed, disabled, with the reason beside
// the name, so the one case that cannot be verified is seen and corrected on
// the record rather than waved through.
//
// The implication itself (CE covers C covers B) is spelled once, in
// resources/licence.ts over the vocabulary's lowercase tokens (Issue #101);
// this module keeps the prototype's uppercase display tuple, maps a display
// class onto its token, and asks `coversClass`. The tokens and the display
// tuple are held together by resources/__tests__/vocabulary.test.ts.

import { groupDriverIssue, type JudgedDay } from "../planning/checks"
import type { BusinessRecord } from "../prototype-record"
import { typedString } from "../record-values"
import { coversClass } from "../resources/licence"
import type { LicenceClass as LicenceClassToken } from "../resources/vocabulary"
import { vehicleTypeOfRecord } from "./matching"
import { isIsoDate } from "./recurrence"

/** What the readers need of a fleet record — a fixture, a created record, or a test's stand-in. */
export type FleetRecord = Pick<BusinessRecord, "id" | "name" | "context" | "facts" | "submittedValues">

/** The licence classes a driver may hold and a vehicle may require, lowest first: the display spelling of the vocabulary's `LICENCE_CLASSES`. */
export const LICENCE_CLASSES = ["B", "C", "CE"] as const satisfies readonly Uppercase<LicenceClassToken>[]

export type LicenceClass = (typeof LICENCE_CLASSES)[number]

/** The display class as the vocabulary's token: `CE` is `ce`. */
const tokenOf = (licenceClass: LicenceClass): LicenceClassToken => licenceClass.toLowerCase() as LicenceClassToken

export function isLicenceClass(value: unknown): value is LicenceClass {
  return typeof value === "string" && (LICENCE_CLASSES as readonly string[]).includes(value)
}

/** The typed licence class a record carries under the key, or null when it carries none the vocabulary knows. */
function licenceClassOf(record: FleetRecord, key: string): LicenceClass | null {
  const value = typedString(record.submittedValues, key)
  return isLicenceClass(value) ? value : null
}

export type VehicleProfile = {
  id: string
  /** "WH-24" — the callsign before the plate in the record name. */
  callsign: string
  /** Canonical vehicle type when the record names one, else the context's type text. */
  type: string | null
  capacityT: number | null
  /** The class a driver needs to take it out; null when the record does not say. */
  licenceClass: LicenceClass | null
  isTrailer: boolean
}

/** "18 t" / "18" / "Rear loader 18 t · Nordhavn" → 18; null when nothing numeric precedes a t. */
export function parseTonnes(text: string | undefined): number | null {
  if (!text) return null
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*t\b/i) ?? text.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/)
  if (!match) return null
  const value = Number(match[1].replace(",", "."))
  return Number.isFinite(value) ? value : null
}

export function vehicleProfile(record: FleetRecord): VehicleProfile {
  const facts = record.facts ?? {}
  const contextType = record.context.split(" · ")[0]?.trim() ?? ""
  const isTrailer =
    typedString(record.submittedValues, "resourceKind") === "trailer" ||
    /trailer/i.test(record.context) ||
    /trailer/i.test(facts.Type ?? "")
  const capacityT =
    parseTonnes(facts.Capacity) ?? parseTonnes(typedString(record.submittedValues, "capacity")) ?? parseTonnes(contextType)
  const type =
    vehicleTypeOfRecord(record) ??
    (contextType ? contextType.replace(/\s*\d+(?:[.,]\d+)?\s*t\b.*$/i, "").trim() || null : null)
  return {
    id: record.id,
    callsign: record.name.split(" · ")[0]?.trim() || record.name,
    type,
    capacityT,
    licenceClass: licenceClassOf(record, "requiredLicenceClass"),
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
export function collectionVehicles<T extends FleetRecord>(records: readonly T[]): T[] {
  return records.filter((record) => !vehicleProfile(record).isTrailer)
}

export type DriverProfile = {
  id: string
  name: string
  /** The highest class held; null = unknown, which is NOT eligible. */
  licenceClass: LicenceClass | null
  /** The day the licence runs out, `YYYY-MM-DD`; null when the record carries none. */
  licenceExpiry: string | null
}

export function driverProfile(record: FleetRecord): DriverProfile {
  const expiry = typedString(record.submittedValues, "licenceExpiry")
  return {
    id: record.id,
    name: record.name,
    licenceClass: licenceClassOf(record, "licenceClass"),
    licenceExpiry: expiry !== undefined && isIsoDate(expiry) ? expiry : null,
  }
}

/** Whether the driver may drive a vehicle of the class; an unknown licence, or an unknown class, never may. The implication is resources/licence.ts's. */
export function driverHoldsLicence(driver: DriverProfile, licenceClass: LicenceClass | null): boolean {
  if (driver.licenceClass === null || licenceClass === null) return false
  return coversClass(tokenOf(driver.licenceClass), tokenOf(licenceClass))
}

export const NO_LICENCE_ON_RECORD = "No licence on record"
export const NO_VEHICLE_LICENCE_CLASS = "Vehicle has no licence class on record"

export type DriverEligibility = {
  driver: DriverProfile
  eligible: boolean
  /** Short reason shown beside a disabled driver. */
  reason?: string
}

/**
 * Why a driver may or may not take a vehicle of the class. The vehicle's
 * reason comes first: a vehicle without a class can judge nobody, so every
 * driver says so and the person corrects the vehicle record once. With
 * `on` — the day a collection group's driver is judged on and the vehicle's
 * label (#178) — a licence that has run out by that day does not hold
 * either, refused in the sentence the API answers for the group
 * (planning/checks.ts's `groupDriverIssue`), so a picker and the API turn one
 * driver down in the same words. Without it only the class is judged.
 */
export function driverEligibility(
  driver: DriverProfile,
  licenceClass: LicenceClass | null,
  on?: { judged: JudgedDay; vehicleLabel: string },
): DriverEligibility {
  if (licenceClass === null) return { driver, eligible: false, reason: NO_VEHICLE_LICENCE_CLASS }
  if (driver.licenceClass === null) return { driver, eligible: false, reason: NO_LICENCE_ON_RECORD }
  if (!driverHoldsLicence(driver, licenceClass)) {
    return { driver, eligible: false, reason: `Needs ${licenceClass} licence` }
  }
  if (on !== undefined) {
    const issue = groupDriverIssue(
      {
        vehicle: { label: on.vehicleLabel, requiredLicenceClass: tokenOf(licenceClass) },
        driver: { name: driver.name, licenceClass: tokenOf(driver.licenceClass), licenceExpiry: driver.licenceExpiry },
      },
      on.judged,
    )
    if (issue !== undefined) return { driver, eligible: false, reason: issue }
  }
  return { driver, eligible: true }
}

/**
 * Every driver for the driver select, each with its eligibility for the
 * vehicle — ineligible drivers stay listed, disabled, with the reason.
 * Without a vehicle nothing can be judged, so everyone is listed enabled.
 * `judged`, when given, is the day the group's driver is held to their
 * licence on (`schemeLicenceDay`), and a licence run out by then is judged
 * as the API judges it.
 */
export function driverOptions(
  drivers: readonly DriverProfile[],
  vehicle: VehicleProfile | null | undefined,
  judged?: JudgedDay,
): DriverEligibility[] {
  if (!vehicle) return drivers.map((driver) => ({ driver, eligible: true }))
  const on = judged === undefined ? undefined : { judged, vehicleLabel: vehicle.callsign }
  return drivers.map((driver) => driverEligibility(driver, vehicle.licenceClass, on))
}

export function eligibleDrivers(
  drivers: readonly DriverProfile[],
  vehicle: VehicleProfile | null | undefined,
): DriverProfile[] {
  return driverOptions(drivers, vehicle)
    .filter((option) => option.eligible)
    .map((option) => option.driver)
}

/** "Mads Jensen · CE" — the driver select's option text; name alone when the licence is unknown. */
export function driverOptionLabel(driver: DriverProfile): string {
  return driver.licenceClass !== null ? `${driver.name} · ${driver.licenceClass}` : driver.name
}

/** Why the driver may not take the vehicle, for a submit check; undefined when they may (or nothing is judged). */
export function driverIneligibilityReason(
  driver: FleetRecord | undefined,
  vehicle: FleetRecord | undefined,
): string | undefined {
  if (!driver || !vehicle) return undefined
  return driverEligibility(driverProfile(driver), vehicleProfile(vehicle).licenceClass).reason
}
