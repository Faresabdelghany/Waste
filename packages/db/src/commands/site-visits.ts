// Recycling-centre visits' statements (Issue #393, M4 of #293), the ones both
// doors into the ledger run: the attendant's check-in (`POST /site-visits`,
// apps/api/src/routes/site-visits.ts) as `source: "staff"` with the person,
// and the gate's inbound read (M8 of #293) as `source: "gate"` with its
// `externalId` and no person. The worker's Finance consumer reads a visit's
// charge through the same `visitChargeOf`, so the attendant's answer and the
// event judge alike.
//
// `recordVisit` answers a gate's read already recorded under its
// `externalId` first, as it stands (ADR-0011), refused where it names
// another project or site; then holds the site to a recycling centre of the
// project, each fraction to one it takes and the address's Property to the
// project's (each a `Refused` 400 naming its field), and only then the site
// to an active one (a 409). It renders the instant as the project's day;
// reads the credential in force for the plate or the card on that day, and
// the Agreement the visit is charged to — a household's fee-paying one
// (@waste/domain/visits/charges's `feePayingAgreement`: a subscription in
// force at the Property, or at a Shared Collection Point it is a member of,
// under a signed Agreement in force), a business's credential's own while it
// is signed and in force on the day; identifies the visit in the domain's
// order; judges what an admitted visit costs (`visitChargeOf`) and stores it
// with the visit, the number the attendant quotes and the Finance consumer
// charges, so nothing later re-tiers it; writes it, admitted or refused,
// with its fractions; and emits `site-visit-recorded` with the wire
// resource. A household's visit takes its Property's row lock first, so two
// check-ins at once count one after the other; two deliveries of one gate
// read at once meet the external id's unique index, and the second answers
// the first's visit.
//
// `visitChargeOf` is the domain's `visitCharge` over what it needs: the rule
// in force on the visit's day with its ladder and free fractions, the
// Property's admitted visits of the calendar year not voided, and whether a
// business's Agreement holds the annual-access product in force that day.
// `priceVisitCharge` prices the step through `priceDraft`, exactly as a
// billable event will be. `likelyTradesOf` counts a rule's window in one
// aggregate statement, so no list of visits crosses the wire.
import type { SiteVisit, VisitChargeQuoted, VisitIdentifier } from "@waste/contracts/site-visits"
import type { PricingOutcome } from "@waste/domain/finance/pricing"
import type { AgreementStatus } from "@waste/domain/registry/vocabulary"
import { businessAgreementOf, feePayingAgreement, householdPropertyOf, identifyVisit, normaliseCredentialValue, ruleOn, visitCharge, type CredentialFacts, type Identified, type LikelyTrade, type VisitCharge, type VisitFacts, type VisitHolder, type VisitRuleFacts } from "@waste/domain/visits/charges"
import type { SiteVisitIdentification, SiteVisitOutcome, SiteVisitRefusalReason, SiteVisitSource, VisitChargeBasis } from "@waste/domain/visits/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lte, not, notInArray, or, sql } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { validOn } from "../query/valid-on"
import { agreement, subscription } from "../schema/agreements"
import { property, sharedCollectionPointMember } from "../schema/customers"
import { dropOffPoint, dropOffPointFraction } from "../schema/drop-off-points"
import { accessCredential, siteVisit, siteVisitFraction, visitRule, visitRuleFreeFraction, visitRuleStep } from "../schema/site-visits"
import { priceDraft } from "./billable-writes"
import { dayInTimezone } from "./days"
import { emit } from "./outbox"
import { projectTimezone, type Scope } from "./project-clock"
import { instantOf, stampsOf } from "./resolution-rows"
import { lockRow, refused, RefusedField, uniqueConstraintOf } from "./shared"

/** What a site that is no recycling centre of the project is told, at `siteId`. */
export const NOT_A_CENTRE = "Not a recycling centre of this project"
/** What a fraction the site does not take is told, at its place in `wasteFractionIds`. */
export const NOT_TAKEN_HERE = "The site does not take this fraction"
/** What a Property that is not the project's is told. */
export const NOT_A_PROPERTY = "Not a property of this project"
/** What a gate's read is told whose external id an earlier read at another project or site already took. */
export const EXTERNAL_ID_TAKEN = "This external id was already recorded for a visit at another site; a gate names each read once"
/** `site_visit_external_id_idx`: a gate's read is one visit (ADR-0011). */
const ONE_VISIT_PER_READ = "site_visit_external_id_idx"
/** What a check-in at a site that is not open for visits is told. */
export const siteNotActive = (status: string): string => `The recycling centre is ${status}; visits are checked in at an active one`

export const visitColumns = {
  id: siteVisit.id,
  projectId: siteVisit.projectId,
  siteId: siteVisit.siteId,
  occurredAt: siteVisit.occurredAt,
  serviceDate: siteVisit.serviceDate,
  source: siteVisit.source,
  externalId: siteVisit.externalId,
  identification: siteVisit.identification,
  identifierValue: siteVisit.identifierValue,
  credentialId: siteVisit.credentialId,
  propertyId: siteVisit.propertyId,
  customerId: siteVisit.customerId,
  agreementId: siteVisit.agreementId,
  outcome: siteVisit.outcome,
  refusalReason: siteVisit.refusalReason,
  recordedBy: siteVisit.recordedBy,
  note: siteVisit.note,
  chargeBasis: siteVisit.chargeBasis,
  chargeN: siteVisit.chargeN,
  chargeProductId: siteVisit.chargeProductId,
  voidedAt: siteVisit.voidedAt,
  voidedBy: siteVisit.voidedBy,
  voidReason: siteVisit.voidReason,
  createdAt: siteVisit.createdAt,
  updatedAt: siteVisit.updatedAt,
}

export type VisitRow = Pick<typeof siteVisit.$inferSelect, keyof typeof visitColumns>

/** A visit on the wire, with the fractions it brought. */
export function siteVisitOf(row: VisitRow, wasteFractionIds: readonly string[]): SiteVisit {
  return {
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    occurredAt: row.occurredAt.toISOString(),
    serviceDate: row.serviceDate,
    source: row.source as SiteVisitSource,
    externalId: row.externalId,
    identification: row.identification as SiteVisitIdentification,
    identifierValue: row.identifierValue,
    credentialId: row.credentialId,
    propertyId: row.propertyId,
    customerId: row.customerId,
    agreementId: row.agreementId,
    outcome: row.outcome as SiteVisitOutcome,
    refusalReason: row.refusalReason as SiteVisitRefusalReason | null,
    recordedBy: row.recordedBy,
    note: row.note,
    wasteFractionIds: [...wasteFractionIds],
    charge: quotedOf(row),
    voidedAt: instantOf(row.voidedAt),
    voidedBy: row.voidedBy,
    voidReason: row.voidReason,
    ...stampsOf(row),
  }
}

/** What a visit's row says it was charged at when it was recorded; null for a refused one. */
export const quotedOf = (row: Pick<VisitRow, "chargeBasis" | "chargeN" | "chargeProductId">): VisitChargeQuoted | null =>
  row.chargeBasis === null ? null : { basis: row.chargeBasis as VisitChargeBasis, n: row.chargeN, productId: row.chargeProductId }

/** The fractions of each visit asked, by visit, in the order they were written. */
export async function fractionsOf(tx: Tx, companyId: string, visitIds: readonly string[]): Promise<Map<string, string[]>> {
  const fractions = new Map<string, string[]>()
  if (visitIds.length === 0) return fractions
  const rows = await tx
    .select({ visitId: siteVisitFraction.visitId, wasteFractionId: siteVisitFraction.wasteFractionId })
    .from(siteVisitFraction)
    .where(and(eq(siteVisitFraction.companyId, companyId), inArray(siteVisitFraction.visitId, [...visitIds])))
    .orderBy(asc(siteVisitFraction.id))
  for (const row of rows) fractions.set(row.visitId, [...(fractions.get(row.visitId) ?? []), row.wasteFractionId])
  return fractions
}

/** One visit of the company with its fractions, or undefined. */
export async function visitById(tx: Tx, companyId: string, id: string): Promise<{ row: VisitRow; visit: SiteVisit } | undefined> {
  const [row] = await tx
    .select(visitColumns)
    .from(siteVisit)
    .where(and(eq(siteVisit.companyId, companyId), eq(siteVisit.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  return { row, visit: siteVisitOf(row, (await fractionsOf(tx, companyId, [row.id])).get(row.id) ?? []) }
}

/** The holder a visit's row names, as the domain reads it; null where it reached nobody. */
export function holderOf(row: Pick<VisitRow, "propertyId" | "customerId" | "agreementId">): VisitHolder | null {
  if (row.propertyId !== null) return { kind: "household", propertyId: row.propertyId, agreementId: row.agreementId }
  if (row.customerId !== null && row.agreementId !== null) return { kind: "business", customerId: row.customerId, agreementId: row.agreementId }
  return null
}

/** The credential of a kind and value in force on the day, as identification reads it; null where none is. */
async function credentialOn(tx: Tx, scope: Scope, kind: "plate" | "card", value: string, day: string): Promise<CredentialFacts | null> {
  const [row] = await tx
    .select({ id: accessCredential.id, blockedAt: accessCredential.blockedAt, customerId: accessCredential.customerId, agreementId: accessCredential.agreementId, propertyId: accessCredential.propertyId })
    .from(accessCredential)
    .where(and(eq(accessCredential.companyId, scope.companyId), eq(accessCredential.projectId, scope.projectId), eq(accessCredential.kind, kind), eq(accessCredential.value, value), validOn(accessCredential, day)))
    .limit(1)
  if (row === undefined) return null
  if (row.propertyId !== null) return { id: row.id, blocked: row.blockedAt !== null, holder: { kind: "household", propertyId: row.propertyId } }
  // access_credential_holder_shape: a credential without a Property names its customer and its agreement.
  if (row.customerId === null || row.agreementId === null) throw new Error(`credentialOn: access credential ${row.id} names no holder`)
  const holder: CredentialFacts["holder"] = { kind: "business", customerId: row.customerId, agreementId: row.agreementId }
  return { id: row.id, blocked: row.blockedAt !== null, holder }
}

/** The Agreement a household Property pays under on the day: a subscription in force at it, or at a Shared Collection Point it is a member of, under a signed Agreement in force; the lowest id of several. */
export async function feePayingAgreementOf(tx: Tx, scope: Scope, propertyId: string, day: string): Promise<string | null> {
  const points = tx
    .select({ id: sharedCollectionPointMember.sharedCollectionPointId })
    .from(sharedCollectionPointMember)
    .where(and(eq(sharedCollectionPointMember.companyId, scope.companyId), eq(sharedCollectionPointMember.propertyId, propertyId)))
  const rows = await tx
    .select({ agreementId: agreement.id, status: agreement.status })
    .from(subscription)
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .where(
      and(
        eq(subscription.companyId, scope.companyId),
        eq(subscription.projectId, scope.projectId),
        or(eq(subscription.propertyId, propertyId), inArray(subscription.sharedCollectionPointId, points)),
        validOn(subscription, day),
        validOn(agreement, day),
      ),
    )
  return feePayingAgreement(rows.map((row) => ({ agreementId: row.agreementId, status: row.status as AgreementStatus })))
}

/** Whether a business's Agreement pays for its visits on the day: signed, and in force. */
async function agreementPaysOn(tx: Tx, scope: Scope, agreementId: string, day: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: agreement.id })
    .from(agreement)
    .where(and(eq(agreement.companyId, scope.companyId), eq(agreement.projectId, scope.projectId), eq(agreement.id, agreementId), eq(agreement.status, "active"), validOn(agreement, day)))
    .limit(1)
  return row !== undefined
}

/** A project's Visit Rules in force on a day, with their ladders and free fractions: at most one, the database holds. */
export async function visitRuleOn(tx: Tx, scope: Scope, day: string): Promise<VisitRuleFacts | null> {
  const rows = await tx
    .select()
    .from(visitRule)
    .where(and(eq(visitRule.companyId, scope.companyId), eq(visitRule.projectId, scope.projectId), validOn(visitRule, day)))
  const rules = await visitRuleFactsOf(tx, scope.companyId, rows)
  return ruleOn(rules, day)
}

/** Rules as the domain reads them, their ladders by position and their free fractions read beside them. */
export async function visitRuleFactsOf(tx: Tx, companyId: string, rows: readonly (typeof visitRule.$inferSelect)[]): Promise<VisitRuleFacts[]> {
  const { ladders, freeFractions } = await ruleSetsOf(
    tx,
    companyId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    id: row.id,
    validFrom: row.validFrom,
    validTo: row.validTo,
    freeVisits: row.freeVisits,
    ladder: ladders.get(row.id) ?? [],
    freeFractionIds: freeFractions.get(row.id) ?? [],
    businessVisitProductId: row.businessVisitProductId,
    annualAccessProductId: row.annualAccessProductId,
    tradeThreshold: row.tradeThreshold,
    tradeWindowDays: row.tradeWindowDays,
  }))
}

/** Each rule's ladder by position and its free fractions, by rule. */
export async function ruleSetsOf(tx: Tx, companyId: string, ruleIds: readonly string[]): Promise<{ ladders: Map<string, string[]>; freeFractions: Map<string, string[]> }> {
  const ladders = new Map<string, string[]>()
  const freeFractions = new Map<string, string[]>()
  if (ruleIds.length === 0) return { ladders, freeFractions }
  const steps = await tx
    .select({ ruleId: visitRuleStep.ruleId, productId: visitRuleStep.productId })
    .from(visitRuleStep)
    .where(and(eq(visitRuleStep.companyId, companyId), inArray(visitRuleStep.ruleId, [...ruleIds])))
    .orderBy(asc(visitRuleStep.ruleId), asc(visitRuleStep.position))
  for (const step of steps) ladders.set(step.ruleId, [...(ladders.get(step.ruleId) ?? []), step.productId])
  const free = await tx
    .select({ ruleId: visitRuleFreeFraction.ruleId, wasteFractionId: visitRuleFreeFraction.wasteFractionId })
    .from(visitRuleFreeFraction)
    .where(and(eq(visitRuleFreeFraction.companyId, companyId), inArray(visitRuleFreeFraction.ruleId, [...ruleIds])))
    .orderBy(asc(visitRuleFreeFraction.id))
  for (const row of free) freeFractions.set(row.ruleId, [...(freeFractions.get(row.ruleId) ?? []), row.wasteFractionId])
  return { ladders, freeFractions }
}

/** The admitted visits not voided of a project matching `where`, as the domain reads them. */
async function admittedVisits(tx: Tx, scope: Scope, where: ReturnType<typeof and>): Promise<VisitFacts[]> {
  const rows = await tx
    .select({ id: siteVisit.id, occurredAt: siteVisit.occurredAt, serviceDate: siteVisit.serviceDate, propertyId: siteVisit.propertyId, customerId: siteVisit.customerId, agreementId: siteVisit.agreementId })
    .from(siteVisit)
    .where(and(eq(siteVisit.companyId, scope.companyId), eq(siteVisit.projectId, scope.projectId), eq(siteVisit.outcome, "admitted"), isNull(siteVisit.voidedAt), where))
  const fractions = await fractionsOf(
    tx,
    scope.companyId,
    rows.map((row) => row.id),
  )
  return rows.flatMap((row) => {
    const holder = holderOf(row)
    return holder === null ? [] : [{ id: row.id, occurredAt: row.occurredAt.toISOString(), serviceDate: row.serviceDate, fractionIds: fractions.get(row.id) ?? [], holder }]
  })
}

/** Whether an Agreement holds a subscription to the product in force on the day: a business's annual access. */
async function holdsProduct(tx: Tx, scope: Scope, agreementId: string, productId: string, day: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: subscription.id })
    .from(subscription)
    .where(and(eq(subscription.companyId, scope.companyId), eq(subscription.projectId, scope.projectId), eq(subscription.agreementId, agreementId), eq(subscription.productId, productId), validOn(subscription, day)))
    .limit(1)
  return row !== undefined
}

/** What an admitted visit costs under its project's rule on its day: the domain's `visitCharge` over the Property's year, or a business's annual access. */
export async function visitChargeOf(tx: Tx, scope: Scope, visit: VisitFacts): Promise<VisitCharge> {
  const rule = await visitRuleOn(tx, scope, visit.serviceDate)
  if (rule === null) return visitCharge(visit, null, [])
  if (visit.holder.kind === "business") {
    const annual = rule.annualAccessProductId !== null && (await holdsProduct(tx, scope, visit.holder.agreementId, rule.annualAccessProductId, visit.serviceDate))
    return visitCharge(visit, rule, [], annual)
  }
  const year = visit.serviceDate.slice(0, 4)
  const history = await admittedVisits(tx, scope, and(eq(siteVisit.propertyId, visit.holder.propertyId), gte(siteVisit.serviceDate, `${year}-01-01`), lte(siteVisit.serviceDate, `${year}-12-31`)))
  return visitCharge(visit, rule, history)
}

/** A charged product priced under the visit's Agreement on its day, as its billable event will be; null where nothing is charged or no Agreement is named. */
export async function priceVisitCharge(tx: Tx, scope: Scope, agreementId: string | null, productId: string | null, serviceDate: string): Promise<PricingOutcome | null> {
  if (productId === null || agreementId === null) return null
  return await priceDraft(tx, scope, { agreementId, productId, quantity: 1, serviceDate })
}

/**
 * A project's likely trades on a day under the rule in force: the rule, and
 * the Properties with at least its threshold of counted visits in its window
 * — admitted, not voided, a household's, bringing nothing recorded or
 * something other than the rule's free fractions — most visits first and
 * then by id: the domain's `likelyTrades` as one aggregate, so the window is
 * counted where it lies and no list of visits crosses the wire.
 */
export async function likelyTradesOf(tx: Tx, scope: Scope, on: string): Promise<{ rule: VisitRuleFacts | null; items: LikelyTrade[] }> {
  const rule = await visitRuleOn(tx, scope, on)
  if (rule === null || rule.tradeThreshold === null || rule.tradeWindowDays === null) return { rule, items: [] }
  const free = rule.freeFractionIds
  const brought = (where: ReturnType<typeof and>) =>
    exists(
      tx
        .select({ one: sql`1` })
        .from(siteVisitFraction)
        .where(and(eq(siteVisitFraction.companyId, scope.companyId), eq(siteVisitFraction.visitId, siteVisit.id), where)),
    )
  // Counted: no fraction recorded, or one that is not free (isCounted).
  const counted = free.length === 0 ? undefined : or(not(brought(undefined)), brought(notInArray(siteVisitFraction.wasteFractionId, [...free])))
  const visits = count()
  const rows = await tx
    .select({ propertyId: siteVisit.propertyId, visits })
    .from(siteVisit)
    .where(
      and(
        eq(siteVisit.companyId, scope.companyId),
        eq(siteVisit.projectId, scope.projectId),
        eq(siteVisit.outcome, "admitted"),
        isNull(siteVisit.voidedAt),
        isNotNull(siteVisit.propertyId),
        gte(siteVisit.serviceDate, addDays(on, 1 - rule.tradeWindowDays)),
        lte(siteVisit.serviceDate, on),
        counted,
      ),
    )
    .groupBy(siteVisit.propertyId)
    .having(sql`count(*) >= ${rule.tradeThreshold}`)
    .orderBy(desc(visits), asc(siteVisit.propertyId))
  return { rule, items: rows.flatMap((row) => (row.propertyId === null ? [] : [{ propertyId: row.propertyId, visits: row.visits }])) }
}

export type RecordVisitInput = {
  companyId: string
  projectId: string
  siteId: string
  occurredAt: Date
  source: SiteVisitSource
  /** The gate's own id of its read, the idempotency key; null for the attendant's. */
  externalId: string | null
  identifier: VisitIdentifier
  wasteFractionIds: readonly string[]
  note: string | null
  /** The attendant, or null for the gate. */
  recordedBy: string | null
  newId: IdMinter
}

/** What the door answers: the visit as recorded, with what it was charged at, and whether it was already there (a gate's read again). */
export type RecordedVisit = { row: VisitRow; visit: SiteVisit; replayed: boolean }

/** Holds the site to a recycling centre of the project and each fraction to one it takes (the 400s), and answers its status, which the caller judges after every 400. */
async function siteStatusOf(tx: Tx, scope: Scope, siteId: string, fractionIds: readonly string[]): Promise<string> {
  const [site] = await tx
    .select({ kind: dropOffPoint.kind, status: dropOffPoint.status })
    .from(dropOffPoint)
    .where(and(eq(dropOffPoint.companyId, scope.companyId), eq(dropOffPoint.projectId, scope.projectId), eq(dropOffPoint.id, siteId)))
    .limit(1)
  if (site === undefined || site.kind !== "recycling-centre") throw new RefusedField("siteId", NOT_A_CENTRE)
  if (fractionIds.length === 0) return site.status
  const taken = await tx
    .select({ wasteFractionId: dropOffPointFraction.wasteFractionId })
    .from(dropOffPointFraction)
    .where(and(eq(dropOffPointFraction.companyId, scope.companyId), eq(dropOffPointFraction.dropOffPointId, siteId), inArray(dropOffPointFraction.wasteFractionId, [...fractionIds])))
  const takes = new Set(taken.map((row) => row.wasteFractionId))
  const index = fractionIds.findIndex((id) => !takes.has(id))
  if (index >= 0) throw new RefusedField(`wasteFractionIds.${index}`, NOT_TAKEN_HERE)
  return site.status
}

/** The visit an earlier read of the gate recorded under its id, if any. */
async function visitByExternalId(tx: Tx, companyId: string, source: SiteVisitSource, externalId: string): Promise<VisitRow | undefined> {
  const [row] = await tx
    .select(visitColumns)
    .from(siteVisit)
    .where(and(eq(siteVisit.companyId, companyId), eq(siteVisit.source, source), eq(siteVisit.externalId, externalId)))
    .limit(1)
  return row
}

/** A gate's read already recorded, answered as it stands where it was the same site's, refused where another project or site took the id. */
async function replayOf(tx: Tx, scope: Scope, input: RecordVisitInput, earlier: VisitRow): Promise<RecordedVisit> {
  if (earlier.projectId !== scope.projectId || earlier.siteId !== input.siteId) throw refused(409, EXTERNAL_ID_TAKEN)
  const fractions = (await fractionsOf(tx, scope.companyId, [earlier.id])).get(earlier.id) ?? []
  return { row: earlier, visit: siteVisitOf(earlier, fractions), replayed: true }
}

/**
 * Records one visit at a recycling centre, in the caller's transaction:
 * identified, admitted or refused, what it costs judged and stored with it,
 * its fractions written and its `site-visit-recorded` emitted. The gate's
 * read meets its earlier recording by `externalId` before anything else is
 * judged, and is answered as it stands.
 */
export async function recordVisit(tx: Tx, input: RecordVisitInput): Promise<RecordedVisit> {
  const scope: Scope = { companyId: input.companyId, projectId: input.projectId }
  if (input.externalId !== null) {
    const earlier = await visitByExternalId(tx, input.companyId, input.source, input.externalId)
    if (earlier !== undefined) return await replayOf(tx, scope, input, earlier)
  }
  // The body's 400s first — the site, its fractions, the address's Property — then the site's state (apps/api's order of judgement).
  const siteStatus = await siteStatusOf(tx, scope, input.siteId, input.wasteFractionIds)
  const { identifier } = input
  if (identifier.kind === "property") {
    const [found] = await tx
      .select({ id: property.id })
      .from(property)
      .where(and(eq(property.companyId, scope.companyId), eq(property.projectId, scope.projectId), eq(property.id, identifier.propertyId)))
      .limit(1)
    if (found === undefined) throw new RefusedField("identifier.propertyId", NOT_A_PROPERTY)
  }
  if (siteStatus !== "active") throw refused(409, siteNotActive(siteStatus))
  const day = dayInTimezone(input.occurredAt, await projectTimezone(tx, scope.companyId, scope.projectId))
  let identifierValue: string | null = null
  let identified: Identified
  if (identifier.kind === "property") identified = { by: "property", propertyId: identifier.propertyId }
  else {
    identifierValue = normaliseCredentialValue(identifier.value)
    identified = { by: identifier.kind, credential: await credentialOn(tx, scope, identifier.kind, identifierValue, day) }
  }
  const household = householdPropertyOf(identified)
  // Two check-ins of one household at once count one after the other.
  if (household !== null) await lockRow(tx, property, { companyId: scope.companyId, id: household })
  const business = businessAgreementOf(identified)
  const paying = household !== null ? await feePayingAgreementOf(tx, scope, household, day) : business !== null && (await agreementPaysOn(tx, scope, business, day)) ? business : null
  const identification = identifyVisit(identified, paying)
  const holder = identification.holder
  const id = input.newId()
  // What an admitted visit costs, judged now and stored: the number the attendant quotes is the one the consumer charges.
  const charge: VisitCharge | null =
    identification.outcome === "admitted" && holder !== null ? await visitChargeOf(tx, scope, { id, occurredAt: input.occurredAt.toISOString(), serviceDate: day, fractionIds: input.wasteFractionIds, holder }) : null
  const values = {
    id,
    companyId: scope.companyId,
    projectId: scope.projectId,
    siteId: input.siteId,
    occurredAt: input.occurredAt,
    serviceDate: day,
    source: input.source,
    externalId: input.externalId,
    identification: identifier.kind,
    identifierValue,
    credentialId: identification.credentialId,
    propertyId: holder?.kind === "household" ? holder.propertyId : null,
    customerId: holder?.kind === "business" ? holder.customerId : null,
    agreementId: holder?.agreementId ?? null,
    outcome: identification.outcome,
    refusalReason: identification.refusalReason,
    recordedBy: input.recordedBy,
    note: input.note,
    chargeBasis: charge?.basis ?? null,
    chargeN: charge?.n ?? null,
    chargeProductId: charge?.productId ?? null,
  }
  let row: VisitRow
  try {
    // A savepoint, so a second delivery of one gate read meeting the first's index rolls back alone and reads the first's visit.
    ;[row] = await tx.transaction((savepoint) => savepoint.insert(siteVisit).values(values).returning(visitColumns))
  } catch (error) {
    if (input.externalId === null || uniqueConstraintOf(error) !== ONE_VISIT_PER_READ) throw error
    const winner = await visitByExternalId(tx, input.companyId, input.source, input.externalId)
    if (winner === undefined) throw error
    return await replayOf(tx, scope, input, winner)
  }
  if (input.wasteFractionIds.length > 0) {
    await tx.insert(siteVisitFraction).values(input.wasteFractionIds.map((wasteFractionId) => ({ id: input.newId(), companyId: scope.companyId, projectId: scope.projectId, visitId: row.id, wasteFractionId })))
  }
  const visit = siteVisitOf(row, input.wasteFractionIds)
  await emit(tx, scope, { aggregate: "site-visit", aggregateId: row.id, kind: "site-visit-recorded", payload: visit, projectId: scope.projectId, occurredAt: input.occurredAt })
  return { row, visit, replayed: false }
}
