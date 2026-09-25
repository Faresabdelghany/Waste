// Whether a driver may take a vehicle out (Issue #101): the rule
// route-schemes/fleet-profiles.ts's `driverHoldsLicence` reads for the web,
// spelled once here over the vocabulary's tokens and with a day, since a
// licence that has run out by the day asked does not hold. The web's module
// delegates to `coversClass` through one case mapping (`B` ↔ `b`), so the
// implication table lives here alone; its display tuple stays until the
// adapter (#81) maps it.
//
// Two rules, both from the fleet readers (#37). `IMPLIED_BY` is the
// implication between the classes: `ce` covers `c` covers `b`, so a holder of
// the higher class drives the lower vehicle. And unknown never passes: a driver
// with no class on record is eligible for nothing, however the vehicle is
// classed, so the one case that cannot be verified is seen and corrected on
// the record rather than waved through.
//
// The expiry is the last day the licence holds, a `YYYY-MM-DD` day, and so is
// `onDay`: comparing two such strings compares the days, and nothing else
// compares — an instant (`2026-09-05T22:00:00Z`) sorts after the day it falls
// on and would read a licence as expired on its last valid day, so a day that
// is not one is refused by `licenceRefusal` with a thrown error, not judged.
// The caller that has an instant turns it into a day first: the allocation
// route (#101, slice 6) takes the window's end, `plannedTo`, renders it as a
// calendar day in the project's timezone (`Intl.DateTimeFormat` with the
// project's `timezone`, `en-CA` for `YYYY-MM-DD`), and asks whether the
// licence holds on that day — the day the reservation ends, where the driver
// is still meant to be driving. A collection group asks on the day its
// scheme's period starts or today, whichever is later.
//
// `licenceRefusal` says why a driver may not, or nothing when they may, and
// `licenceSentence` spells it for the API's 400 and the adapter's form alike,
// so an allocation and a collection group refuse in the same words. The
// class is spelled uppercase in a sentence (`a C licence`), as a person
// reads it off the card.
import { isIsoDate } from "../route-schemes/recurrence"
import { LICENCE_CLASSES, type LicenceClass } from "./vocabulary"

/** The classes whose holder may drive a vehicle of the key's class: `ce` implies `c`, `c` implies `b`. */
export const IMPLIED_BY: Readonly<Record<LicenceClass, readonly LicenceClass[]>> = {
  b: ["b", "c", "ce"],
  c: ["c", "ce"],
  ce: ["ce"],
}

/** Whether a holder of `held` may drive a vehicle requiring `required`: the implication table, and nothing about a day. */
export const coversClass = (held: LicenceClass, required: LicenceClass): boolean => IMPLIED_BY[required].includes(held)

/** Whether the value is one of the three tokens; the web's display spelling (`CE`) is not. */
export function isLicenceClassToken(value: unknown): value is LicenceClass {
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
 * out, since the class is the thing to fix. `onDay` is a `YYYY-MM-DD` day
 * that is on the calendar; anything else — an instant included — is a bug
 * in the caller and is thrown, since the comparison below would answer it
 * wrongly and quietly.
 */
export function licenceRefusal(driver: Licence, required: LicenceClass, onDay: string): LicenceRefusal | undefined {
  if (!isIsoDate(onDay)) {
    throw new Error(`licenceRefusal: "${onDay}" is not a YYYY-MM-DD day; turn an instant into the day it falls on in the project's timezone first`)
  }
  if (driver.licenceClass === null) return { reason: "no-class" }
  if (!coversClass(driver.licenceClass, required)) return { reason: "class-too-low", required }
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
