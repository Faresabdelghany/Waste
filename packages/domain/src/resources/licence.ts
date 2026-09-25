// Whether a driver may take a vehicle out (Issue #101): the pure half of
// route-schemes/fleet-profiles.ts's `driverHoldsLicence`, over the vocabulary's
// tokens instead of the prototype's display tuple, and with a day, since a
// licence that has run out by the day asked does not hold. The web keeps its
// readers over records until the adapter (#81) maps them onto these.
//
// Two rules, both from the fleet readers (#37). `IMPLIED_BY` is the
// implication between the classes: `ce` covers `c` covers `b`, so a holder of
// the higher class drives the lower vehicle. And unknown never passes: a driver
// with no class on record is eligible for nothing, however the vehicle is
// classed, so the one case that cannot be verified is seen and corrected on
// the record rather than waved through. The expiry is the last day the
// licence holds: a licence expiring on the day asked still holds that day.
//
// `licenceRefusal` says why a driver may not, or nothing when they may, and
// `licenceSentence` spells it for the API's 400 and the adapter's form alike,
// so an allocation and a collection group refuse in the same words. The
// class is spelled uppercase in a sentence (`a C licence`), as a person
// reads it off the card.
import { LICENCE_CLASSES, type LicenceClass } from "./vocabulary"

/** The classes whose holder may drive a vehicle of the key's class: `ce` implies `c`, `c` implies `b`. */
export const IMPLIED_BY: Readonly<Record<LicenceClass, readonly LicenceClass[]>> = {
  b: ["b", "c", "ce"],
  c: ["c", "ce"],
  ce: ["ce"],
}

export function isLicenceClass(value: unknown): value is LicenceClass {
  return typeof value === "string" && (LICENCE_CLASSES as readonly string[]).includes(value)
}

/** What the rule reads of a driver: the highest class held, or null for none on record, and the last day it holds, or null for no expiry recorded. */
export type Licence = {
  licenceClass: LicenceClass | null
  /** `YYYY-MM-DD`, the last day the licence holds; null when the record carries none. */
  licenceExpiry: string | null
}

/** Why a driver may not take a vehicle of the required class on the day. */
export type LicenceRefusal =
  | { reason: "no-class" }
  | { reason: "class-too-low"; required: LicenceClass }
  | { reason: "expired"; licenceExpiry: string }

/**
 * Why the driver may not drive a vehicle of `required` on `onDay`, or
 * undefined when they may. The class is judged before the expiry: a driver
 * whose class is too low is told so whether or not the licence has also run
 * out, since the class is the thing to fix. `onDay` is a `YYYY-MM-DD` day;
 * comparing two such strings compares the days.
 */
export function licenceRefusal(driver: Licence, required: LicenceClass, onDay: string): LicenceRefusal | undefined {
  if (driver.licenceClass === null) return { reason: "no-class" }
  if (!IMPLIED_BY[required].includes(driver.licenceClass)) return { reason: "class-too-low", required }
  if (driver.licenceExpiry !== null && driver.licenceExpiry < onDay) return { reason: "expired", licenceExpiry: driver.licenceExpiry }
  return undefined
}

/** Whether the driver may drive a vehicle of the class on the day; an unknown licence never may. */
export function holdsLicence(driver: Licence, required: LicenceClass, onDay: string): boolean {
  return licenceRefusal(driver, required, onDay) === undefined
}

/** A class as a person reads it off the card: `ce` is `CE`. */
export const displayLicenceClass = (licenceClass: LicenceClass): string => licenceClass.toUpperCase()

/**
 * The refusal as a sentence, naming the driver and the vehicle: "Mads Jensen
 * holds no licence class on record", "Mads Jensen needs a C licence for
 * WH-24", "Mads Jensen's licence expires on 2026-09-05, before the window
 * ends". `windowEnds` is what the day asked was — the window's end for an
 * allocation, the scheme's start for a group — so the last sentence says what
 * the day meant.
 */
export function licenceSentence(refusal: LicenceRefusal, names: { driver: string; vehicle: string }, windowEnds = "the window ends"): string {
  switch (refusal.reason) {
    case "no-class":
      return `${names.driver} holds no licence class on record`
    case "class-too-low":
      return `${names.driver} needs a ${displayLicenceClass(refusal.required)} licence for ${names.vehicle}`
    case "expired":
      return `${names.driver}'s licence expires on ${refusal.licenceExpiry}, before ${windowEnds}`
  }
}
