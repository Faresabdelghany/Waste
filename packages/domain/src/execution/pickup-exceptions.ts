// Pickup Exceptions (Issue #293, M5): a Pickup whose outcome the customer
// caused — failed or skipped for one of `PICKUP_EXCEPTION_REASONS`, or completed but
// tagged with a contaminant code — and the per-project rules that may charge
// one: the most specific rule in force on the stop's service date (a code
// beats any code, a reason beats no reason), its free count, and a ladder of
// products stepped by how many matching exceptions came before at the stop's
// place.
//
// The count is a read over stops, never over money rows: the earlier
// chargeable stops at the same place — the Property, or the Shared Collection
// Point for a stop at one, since two bins at one address share one ladder —
// that match the rule's outcome, reason and code, within the `windowDays`
// before the stop's service date, ordered by service date and then by id, a
// stop since corrected away no longer an exception and so not counted. An
// office stop or a work order is never charged, so it never steps the ladder
// either: the free count is spent on what could be charged. That makes a judgement the same
// under redelivery and out-of-order events, and the free ones need no
// zero-priced rows.
//
// The ladder is judged once, at each stop's event (the coordinator's rule on
// #293): a correction of an earlier stop moves that stop's own charge — a
// cancel, or a credit once invoiced — and never re-steps a later exception
// already charged; a later step left wrong by it is mended the same way, by
// the office, as any charge is. `chargesMovedByCorrection` is that rule.
//
// Only an emptying generation planned is chargeable: a stop the office added
// is no exception charge, as it is no pickup charge (finance/from-event.ts),
// and a work order is a visit, never a collection. The office still reads an
// office stop's exception in the place's history.
//
// Dates are ISO days; the module reads no clock, as every date rule here.
import { addDays } from "../route-schemes/recurrence"
import { PICKUP_EXCEPTION_REASONS, type PickupOrigin, type PickupOutcome, type PickupReason, type PickupService, type PickupStatus } from "./vocabulary"

/** A stop as an exception reads it; `place` is its Property's or its Shared Collection Point's id. */
export type PickupExceptionStop = {
  id: string
  status: PickupStatus
  reason: PickupReason | null
  contaminantCodeId: string | null
  origin: PickupOrigin
  service: PickupService
  serviceDate: string
  place: string
}

/** A project's rule, half-open in time (ADR-0005): `validTo` is the first day out of force. A null reason or code matches any. */
export type PickupExceptionRuleFacts = {
  id: string
  validFrom: string
  validTo: string | null
  outcome: PickupOutcome
  reason: PickupReason | null
  contaminantCodeId: string | null
  freeCount: number
  windowDays: number
  /** Products by charged occurrence; the last repeats. */
  ladder: readonly string[]
}

/** What the rules say of one exception: the rule, how many matching exceptions came before, and the ladder's product, null while free. */
export type PickupExceptionJudgement = { ruleId: string; index: number; free: boolean; productId: string | null }

const isPickupExceptionReason = (reason: PickupReason | null): boolean => reason !== null && (PICKUP_EXCEPTION_REASONS as readonly string[]).includes(reason)

/** Whether a stop is a Pickup Exception: missed for a reason the customer caused, or collected with a contaminant code. */
export function isPickupException(stop: Pick<PickupExceptionStop, "status" | "reason" | "contaminantCodeId">): boolean {
  if (stop.status === "failed" || stop.status === "skipped") return isPickupExceptionReason(stop.reason)
  return stop.status === "completed" && stop.contaminantCodeId !== null
}

/** Whether a Pickup Exception may be charged: at an emptying generation planned, never at the office's stop or a work order. */
export const isChargeable = (stop: PickupExceptionStop): boolean => isPickupException(stop) && stop.origin === "generation" && stop.service === "empty"

/** Whether the rule's outcome, reason and code are the stop's, in time or not. */
const matchesShape = (rule: PickupExceptionRuleFacts, stop: PickupExceptionStop): boolean =>
  rule.outcome === stop.status && (rule.reason === null || rule.reason === stop.reason) && (rule.contaminantCodeId === null || rule.contaminantCodeId === stop.contaminantCodeId)

const inForce = (rule: PickupExceptionRuleFacts, day: string): boolean => rule.validFrom <= day && (rule.validTo === null || day < rule.validTo)

/** How specific a rule is: a code counts over a reason, so a coded rule beats a reasoned one. */
const specificity = (rule: PickupExceptionRuleFacts): number => (rule.contaminantCodeId === null ? 0 : 2) + (rule.reason === null ? 0 : 1)

/** The rule that governs a stop: the most specific in force on its service date that matches it; the database refuses two alike in force at once, and the id breaks any other tie. */
export function ruleFor(rules: readonly PickupExceptionRuleFacts[], stop: PickupExceptionStop): PickupExceptionRuleFacts | undefined {
  if (!isPickupException(stop)) return undefined
  return rules
    .filter((rule) => inForce(rule, stop.serviceDate) && matchesShape(rule, stop))
    .sort((a, b) => specificity(b) - specificity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
}

/** Whether `earlier` comes before `stop` in the ladder's order: by service date, then by id. */
const before = (earlier: PickupExceptionStop, stop: PickupExceptionStop): boolean => earlier.serviceDate < stop.serviceDate || (earlier.serviceDate === stop.serviceDate && earlier.id < stop.id)

/**
 * What the rules say of a stop, given the stops at its place as they stand:
 * null where it is no chargeable exception or no rule governs it, else its
 * rule, the count of earlier matching exceptions in the window, and the
 * ladder's product once the free count is spent.
 */
export function judgeException(stop: PickupExceptionStop, rules: readonly PickupExceptionRuleFacts[], history: readonly PickupExceptionStop[]): PickupExceptionJudgement | null {
  if (!isChargeable(stop)) return null
  const rule = ruleFor(rules, stop)
  if (rule === undefined) return null
  const windowStart = addDays(stop.serviceDate, -rule.windowDays)
  const index = history.filter(
    (earlier) => earlier.id !== stop.id && earlier.place === stop.place && earlier.serviceDate >= windowStart && before(earlier, stop) && isChargeable(earlier) && matchesShape(rule, earlier),
  ).length
  if (index < rule.freeCount || rule.ladder.length === 0) return { ruleId: rule.id, index, free: true, productId: null }
  return { ruleId: rule.id, index, free: false, productId: rule.ladder[Math.min(index - rule.freeCount, rule.ladder.length - 1)] }
}

/** The exception charges a correction of a stop moves: its own, never a later stop's, whose step was judged once, at its own event. */
export const chargesMovedByCorrection = <Charge extends { pickupId: string }>(correctedPickupId: string, charges: readonly Charge[]): Charge[] =>
  charges.filter((charge) => charge.pickupId === correctedPickupId)
