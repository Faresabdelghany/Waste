// Recycling-centre visits (Issue #393, M4 of #293): who a visit was for, and
// what its project's Visit Rule says it costs.
//
// Identification, in the order the design on #393 sets (`identifyVisit`): a
// plate or a card names the Access Credential in force on the visit's day
// with that value, and none is `unknown-identifier`; then the visit must have
// an Agreement to be charged to, else `not-fee-paying`; then a blocked
// credential is `credential-blocked`. A household — reached by its
// credential's Property, or by the Property the attendant found by its
// address — is charged to the Agreement it pays under: a Subscription in
// force at the Property on the day, or at a Shared Collection Point it is a
// member of, under a signed Agreement, the lowest id of several
// (`feePayingAgreement`). A business's credential is charged to the
// Agreement it names, while that Agreement is signed and in force on the
// day; one cancelled or ended since pays for nothing. A refused visit is
// still recorded, with whom it reached.
//
// The charge (`visitCharge`), under the rule in force on the visit's day; no
// rule charges nothing. A household's visit whose fractions are all free is
// neither counted nor charged; otherwise it is the n-th counted visit of its
// Property in the calendar year, ordered by instant and then id, included
// while n is within the free visits and charged at ladder step n − free
// after, the last step repeating. A visit with no fractions recorded — a
// gate's read — counts. A business's visit is included where its Agreement
// holds the rule's annual-access product in force on the day, and charged at
// the rule's per-visit product otherwise; free fractions are a household's
// rule alone.
//
// A Likely trade (`likelyTrades`) is a Property with at least the rule's
// threshold of counted visits in its window: a reading, never stored.
//
// The history a charge counts over is the caller's read: the admitted visits
// not voided. A void never re-steps a later visit already charged: each is
// judged once, at its own event, as a Pickup Exception's ladder is
// (execution/pickup-exceptions.ts). Instants are ISO 8601 in UTC
// (`toISOString`), so they order as text; days are ISO days, and the module
// reads no clock.
import type { AgreementStatus } from "../registry/vocabulary"
import { addDays } from "../route-schemes/recurrence"
import type { SiteVisitOutcome, SiteVisitRefusalReason, VisitChargeBasis } from "./vocabulary"

/** Whom a visit was for: a household's Property with the Agreement it pays under, or a business's Customer and the Agreement its credential names. */
export type VisitHolder = { kind: "household"; propertyId: string; agreementId: string | null } | { kind: "business"; customerId: string; agreementId: string }

/** An Access Credential in force on the visit's day, as identification reads it. */
export type CredentialFacts = {
  id: string
  blocked: boolean
  holder: { kind: "household"; propertyId: string } | { kind: "business"; customerId: string; agreementId: string }
}

/** What the visit was identified by: a plate or a card with the credential in force for it, if any, or the Property the attendant found. */
export type Identified = { by: "plate" | "card"; credential: CredentialFacts | null } | { by: "property"; propertyId: string }

/** What identification answers: admitted or refused with the reason, the credential read, and whom the visit reached. */
export type Identification = {
  outcome: SiteVisitOutcome
  refusalReason: SiteVisitRefusalReason | null
  credentialId: string | null
  holder: VisitHolder | null
}

/** One Agreement a Property's subscriptions on the day run under, as fee-paying reads it. */
export type FeePayingCandidate = { agreementId: string; status: AgreementStatus }

/** The Agreement a household pays under: the lowest id of the signed ones, or null where none is. */
export function feePayingAgreement(candidates: readonly FeePayingCandidate[]): string | null {
  const signed = candidates.filter((candidate) => candidate.status === "active").map((candidate) => candidate.agreementId)
  return signed.length === 0 ? null : signed.reduce((lowest, id) => (id < lowest ? id : lowest))
}

/** The Agreement a business's credential names, which identification asks whether it is signed and in force on the day; null for a household or no credential. */
export function businessAgreementOf(identified: Identified): string | null {
  return identified.by !== "property" && identified.credential?.holder.kind === "business" ? identified.credential.holder.agreementId : null
}

/** The household Property identification will ask fee-paying of, or null for a business's credential or none. */
export function householdPropertyOf(identified: Identified): string | null {
  if (identified.by === "property") return identified.propertyId
  return identified.credential?.holder.kind === "household" ? identified.credential.holder.propertyId : null
}

/**
 * Who a visit was for, in the identification order: the credential in force
 * on the day, else `unknown-identifier` for a plate or a card; then
 * `not-fee-paying` where `payingAgreementId` is null — for a household the
 * Agreement it pays under, for a business its credential's Agreement while
 * signed and in force on the day; then a blocked credential
 * `credential-blocked`.
 */
export function identifyVisit(identified: Identified, payingAgreementId: string | null): Identification {
  if (identified.by === "property") {
    const holder: VisitHolder = { kind: "household", propertyId: identified.propertyId, agreementId: payingAgreementId }
    return payingAgreementId === null ? { outcome: "refused", refusalReason: "not-fee-paying", credentialId: null, holder } : { outcome: "admitted", refusalReason: null, credentialId: null, holder }
  }
  const { credential } = identified
  if (credential === null) return { outcome: "refused", refusalReason: "unknown-identifier", credentialId: null, holder: null }
  // A business's visit names the credential's Agreement whether or not it still pays: the ledger says whose plate was turned away.
  const holder: VisitHolder = credential.holder.kind === "business" ? credential.holder : { ...credential.holder, agreementId: payingAgreementId }
  if (payingAgreementId === null) return { outcome: "refused", refusalReason: "not-fee-paying", credentialId: credential.id, holder }
  if (credential.blocked) return { outcome: "refused", refusalReason: "credential-blocked", credentialId: credential.id, holder }
  return { outcome: "admitted", refusalReason: null, credentialId: credential.id, holder }
}

/** A project's Visit Rule, half-open in time (ADR-0005): `validTo` is the first day out of force. */
export type VisitRuleFacts = {
  id: string
  validFrom: string
  validTo: string | null
  /** A household's free visits per calendar year. */
  freeVisits: number
  /** The per-visit products charged once the free visits are spent; the last repeats. */
  ladder: readonly string[]
  /** Fractions whose visits are neither counted nor charged: garden, hazardous, electrical. */
  freeFractionIds: readonly string[]
  /** What a business's visit is charged at without annual access; null charges nothing. */
  businessVisitProductId: string | null
  /** The product whose subscription gives a business's Agreement its visits included. */
  annualAccessProductId: string | null
  /** The counted visits in the window that flag a Property as a likely trade; both null where the rule flags none. */
  tradeThreshold: number | null
  tradeWindowDays: number | null
}

/** An admitted visit as a charge reads it. */
export type VisitFacts = {
  id: string
  /** ISO 8601 in UTC, so instants order as text. */
  occurredAt: string
  /** The visit's day on its project's clock. */
  serviceDate: string
  fractionIds: readonly string[]
  holder: VisitHolder
}

/** What a rule says a visit costs: the rule, why, whether it counted, its place among the Property's counted visits this year (a household's), and the product charged, null where nothing is. */
export type VisitCharge = { ruleId: string | null; basis: VisitChargeBasis; counted: boolean; n: number | null; productId: string | null }

const inForce = (rule: VisitRuleFacts, day: string): boolean => rule.validFrom <= day && (rule.validTo === null || day < rule.validTo)

/** The rule in force on a day; the database holds one at a time per project, and the id breaks any other tie. */
export function ruleOn(rules: readonly VisitRuleFacts[], day: string): VisitRuleFacts | null {
  return rules.filter((rule) => inForce(rule, day)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null
}

/** Whether a household's visit counts under a rule: it brought something other than free fractions, or nothing recorded at all. */
export function isCounted(visit: Pick<VisitFacts, "fractionIds">, rule: Pick<VisitRuleFacts, "freeFractionIds">): boolean {
  return visit.fractionIds.length === 0 || visit.fractionIds.some((fraction) => !rule.freeFractionIds.includes(fraction))
}

const before = (earlier: VisitFacts, visit: VisitFacts): boolean => earlier.occurredAt < visit.occurredAt || (earlier.occurredAt === visit.occurredAt && earlier.id < visit.id)

const placeOf = (holder: VisitHolder): string => (holder.kind === "household" ? holder.propertyId : holder.customerId)

/**
 * What a visit costs under the rule in force on its day: `history` is the
 * admitted visits not voided that the caller read — the Property's this
 * calendar year, for a household; `annualAccess` whether a business's
 * Agreement holds the rule's annual-access product in force on the day.
 */
export function visitCharge(visit: VisitFacts, rule: VisitRuleFacts | null, history: readonly VisitFacts[], annualAccess = false): VisitCharge {
  if (rule === null) return { ruleId: null, basis: "no-rule", counted: false, n: null, productId: null }
  if (visit.holder.kind === "business") {
    if (annualAccess && rule.annualAccessProductId !== null) return { ruleId: rule.id, basis: "annual-access", counted: true, n: null, productId: null }
    return { ruleId: rule.id, basis: "per-visit", counted: true, n: null, productId: rule.businessVisitProductId }
  }
  if (!isCounted(visit, rule)) return { ruleId: rule.id, basis: "free-fractions", counted: false, n: null, productId: null }
  const year = visit.serviceDate.slice(0, 4)
  const place = placeOf(visit.holder)
  const n =
    1 +
    history.filter(
      (earlier) => earlier.id !== visit.id && earlier.holder.kind === "household" && placeOf(earlier.holder) === place && earlier.serviceDate.slice(0, 4) === year && before(earlier, visit) && isCounted(earlier, rule),
    ).length
  if (n <= rule.freeVisits || rule.ladder.length === 0) return { ruleId: rule.id, basis: "free-quota", counted: true, n, productId: null }
  return { ruleId: rule.id, basis: "ladder", counted: true, n, productId: rule.ladder[Math.min(n - rule.freeVisits, rule.ladder.length) - 1] }
}

/** One Property a rule flags as a likely trade, with its counted visits in the window. */
export type LikelyTrade = { propertyId: string; visits: number }

/**
 * The Properties with at least the rule's threshold of counted visits in the
 * window ending on `on` (the `tradeWindowDays` days up to and including it),
 * most visits first and then by id; none where the rule flags none. `visits`
 * is the caller's read of the admitted household visits not voided.
 */
export function likelyTrades(visits: readonly VisitFacts[], rule: VisitRuleFacts | null, on: string): LikelyTrade[] {
  if (rule === null || rule.tradeThreshold === null || rule.tradeWindowDays === null) return []
  const from = addDays(on, 1 - rule.tradeWindowDays)
  const counts = new Map<string, number>()
  for (const visit of visits) {
    if (visit.holder.kind !== "household" || visit.serviceDate < from || visit.serviceDate > on || !isCounted(visit, rule)) continue
    counts.set(visit.holder.propertyId, (counts.get(visit.holder.propertyId) ?? 0) + 1)
  }
  const threshold = rule.tradeThreshold
  return [...counts]
    .filter(([, count]) => count >= threshold)
    .map(([propertyId, count]) => ({ propertyId, visits: count }))
    .sort((a, b) => b.visits - a.visits || (a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0))
}

/** A plate's or a card's value as stored and matched: upper case, with no spaces and no hyphens, so `AB-12 345` and `ab12345` are one plate. */
export const normaliseCredentialValue = (value: string): string => value.replace(/[\s-]+/g, "").toUpperCase()
