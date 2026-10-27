// Recycling-centre visits (Issue #393, M4 of #293): the register of Access
// Credentials, the Site Visit ledger with the fractions each brought, and a
// project's Visit Rules with their ladders and free fractions
// (@waste/domain/visits/charges says who a visit is for and what it costs).
//
// `access_credential` is effective-dated (ADR-0005) per project: a plate or a
// card, its value normalised (upper case, no spaces, no hyphens, `value_shape`), held by
// a business's Customer with the Agreement its visits are charged to or by a
// household's Property (`holder_shape`), blocked rather than deleted. One
// credential of a kind and value is in force at a time
// (`access_credential_no_overlap`, hand-written in the migration).
//
// `site_visit` is the ledger, with `updated_at` because a mistake is voided
// in place, never deleted: the visit is the bookkeeping evidence for its
// charge. Its site is a Drop-off Point; the gate's read (M8 of #293, ADR-0011)
// is idempotent by its `external_id`, unique per company and source. Whom it
// reached is a household's Property with the Agreement it pays under, or a
// business's Customer and Agreement; a refused visit may reach nobody. An
// admitted visit keeps what its Visit Rule charged it at when it was
// recorded — the basis, the household's n, the product — the number the
// attendant quoted, which the Finance consumer charges, so a later void or a
// backdated check-in never re-tiers it.
//
// `visit_rule` is effective-dated, one in force per project at a time
// (`visit_rule_no_overlap`, hand-written); `visit_rule_step` its ladder by
// position from 1, the last repeating; `visit_rule_free_fraction` the
// fractions whose visits are neither counted nor charged.
import { ACCESS_CREDENTIAL_KINDS, SITE_VISIT_IDENTIFICATIONS, SITE_VISIT_OUTCOMES, SITE_VISIT_REFUSAL_REASONS, SITE_VISIT_SOURCES, VISIT_CHARGE_BASES } from "@waste/domain/visits/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { agreement } from "./agreements"
import { product, wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { customer, property } from "./customers"
import { dropOffPoint } from "./drop-off-points"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const accessCredential = wms.table(
  "access_credential",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    kind: text().notNull(),
    /** Normalised: upper case, no spaces, no hyphens. */
    value: text().notNull(),
    /** What the office calls it: `Van 2`, `Garden card`. */
    label: text(),
    /** A business's: its Customer, and the Agreement its visits are charged to. */
    customerId: uuid(),
    agreementId: uuid(),
    /** A household's: its Property. */
    propertyId: uuid(),
    /** Set while blocked, with the reason: a blocked credential turns its visits away. */
    blockedAt: instant(),
    blockedReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.propertyId], property),
    projectKey(t),
    validPeriod(t),
    oneOf(t.kind, ACCESS_CREDENTIAL_KINDS),
    check(tableObjectName(t.id.table, "value_shape", "accessCredential"), sql`${t.value} ~ '^[A-Z0-9]+$'`),
    // A business's Customer with its Agreement, or a household's Property: exactly one holder.
    check(
      tableObjectName(t.id.table, "holder_shape", "accessCredential"),
      sql`case when ${t.propertyId} is not null then ${t.customerId} is null and ${t.agreementId} is null else ${t.customerId} is not null and ${t.agreementId} is not null end`,
    ),
    check(tableObjectName(t.id.table, "blocked_shape", "accessCredential"), sql`(${t.blockedAt} is null) = (${t.blockedReason} is null)`),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.propertyId),
  ],
)

export const siteVisit = wms.table(
  "site_visit",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The recycling centre: a Drop-off Point of kind `recycling-centre`, which the writer holds. */
    siteId: uuid().notNull(),
    occurredAt: instant().notNull(),
    /** The visit's day on its project's clock: the day it is charged on. */
    serviceDate: date().notNull(),
    source: text().notNull(),
    /** The gate's own id of its read (M8 of #293), the idempotency key; null for the attendant's check-in. */
    externalId: text(),
    identification: text().notNull(),
    /** The plate or the card as read, normalised; null where the Property was found by its address. */
    identifierValue: text(),
    credentialId: uuid(),
    propertyId: uuid(),
    customerId: uuid(),
    agreementId: uuid(),
    outcome: text().notNull(),
    refusalReason: text(),
    /** The attendant; null for the gate's read. */
    recordedBy: uuid(),
    note: text(),
    /** What the visit was charged at when it was recorded: why, the household's n-th counted visit of the year, and the product, null where it is included; none on a refused visit. */
    chargeBasis: text(),
    chargeN: integer(),
    chargeProductId: uuid(),
    /** A mistake voided, never deleted: the instant, the person (none for the gate's), the reason. */
    voidedAt: instant(),
    voidedBy: uuid(),
    voidReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.siteId], dropOffPoint),
    projectReference(t, [t.credentialId], accessCredential),
    projectReference(t, [t.propertyId], property),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.agreementId], agreement),
    tenantReference(t, [t.recordedBy], userAccount),
    tenantReference(t, [t.voidedBy], userAccount),
    projectReference(t, [t.chargeProductId], product),
    projectKey(t),
    oneOf(t.source, SITE_VISIT_SOURCES),
    oneOf(t.chargeBasis, VISIT_CHARGE_BASES),
    positive(t.chargeN),
    // An admitted visit keeps its charge's basis and a refused one none; a product only at a step of the ladder or a business's visit.
    check(
      tableObjectName(t.id.table, "charge_shape", "siteVisit"),
      sql`(${t.outcome} = 'admitted') = (${t.chargeBasis} is not null) and (${t.chargeProductId} is null or ${t.chargeBasis} in ('ladder', 'per-visit'))`,
    ),
    oneOf(t.identification, SITE_VISIT_IDENTIFICATIONS),
    oneOf(t.outcome, SITE_VISIT_OUTCOMES),
    oneOf(t.refusalReason, SITE_VISIT_REFUSAL_REASONS),
    // A refused visit carries its reason, and an admitted one none.
    check(tableObjectName(t.id.table, "outcome_shape", "siteVisit"), sql`(${t.outcome} = 'refused') = (${t.refusalReason} is not null)`),
    // A plate or a card is read as a value; a Property found by its address is none.
    check(tableObjectName(t.id.table, "identifier_shape", "siteVisit"), sql`(${t.identification} = 'property') = (${t.identifierValue} is null)`),
    // The attendant's check-in names its person and no gate id; the gate's read no person.
    check(tableObjectName(t.id.table, "source_shape", "siteVisit"), sql`case ${t.source} when 'staff' then ${t.recordedBy} is not null and ${t.externalId} is null else ${t.recordedBy} is null end`),
    // A household's Property or a business's Customer, never both, and a business's always with its Agreement; an admitted visit reaches someone.
    check(
      tableObjectName(t.id.table, "holder_shape", "siteVisit"),
      sql`not (${t.propertyId} is not null and ${t.customerId} is not null) and (${t.customerId} is null or ${t.agreementId} is not null) and (${t.outcome} <> 'admitted' or ${t.agreementId} is not null)`,
    ),
    check(tableObjectName(t.id.table, "void_shape", "siteVisit"), sql`(${t.voidedAt} is null) = (${t.voidReason} is null) and (${t.voidedBy} is null or ${t.voidedAt} is not null)`),
    // The gate's idempotency (ADR-0011): one visit per read.
    uniqueIndex(tableObjectName(t.companyId.table, "external_id_idx", "siteVisit"))
      .on(t.companyId, t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
    // The ledger's reads: a project's days, a site's, a Property's year, a Customer's.
    tenantIndex(t, t.projectId, t.serviceDate),
    tenantIndex(t, t.siteId),
    tenantIndex(t, t.propertyId, t.serviceDate),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.credentialId),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.recordedBy),
    tenantIndex(t, t.voidedBy),
    tenantIndex(t, t.chargeProductId),
  ],
)

export const siteVisitFraction = wms.table(
  "site_visit_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    visitId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    projectReference(t, [t.visitId], siteVisit),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    unique(tableObjectName(t.companyId.table, "membership_key", "siteVisitFraction")).on(t.companyId, t.visitId, t.wasteFractionId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

export const visitRule = wms.table(
  "visit_rule",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** A household's free visits per calendar year. */
    freeVisits: integer().notNull().default(0),
    /** What a business's visit is charged at without annual access; null charges nothing. */
    businessVisitProductId: uuid(),
    /** The month-sold product whose subscription under a business's Agreement includes its visits. */
    annualAccessProductId: uuid(),
    /** The counted visits in the window that flag a Property as a likely trade. */
    tradeThreshold: integer(),
    tradeWindowDays: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.businessVisitProductId], product),
    projectReference(t, [t.annualAccessProductId], product),
    projectKey(t),
    validPeriod(t),
    check(tableObjectName(t.id.table, "free_visits_range", "visitRule"), sql`${t.freeVisits} between 0 and 366`),
    check(
      tableObjectName(t.id.table, "trade_shape", "visitRule"),
      sql`(${t.tradeThreshold} is null) = (${t.tradeWindowDays} is null) and (${t.tradeThreshold} is null or ${t.tradeThreshold} between 1 and 1000) and (${t.tradeWindowDays} is null or ${t.tradeWindowDays} between 1 and 366)`,
    ),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.businessVisitProductId),
    tenantIndex(t, t.annualAccessProductId),
  ],
)

export const visitRuleStep = wms.table(
  "visit_rule_step",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ruleId: uuid().notNull(),
    /** The visit past the free ones this step prices, from 1; the last repeats. */
    position: integer().notNull(),
    productId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ruleId], visitRule),
    projectReference(t, [t.productId], product),
    positive(t.position),
    unique(tableObjectName(t.companyId.table, "rule_position_key", "visitRuleStep")).on(t.companyId, t.ruleId, t.position),
    tenantIndex(t, t.productId),
  ],
)

export const visitRuleFreeFraction = wms.table(
  "visit_rule_free_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ruleId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    projectReference(t, [t.ruleId], visitRule),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    unique(tableObjectName(t.companyId.table, "membership_key", "visitRuleFreeFraction")).on(t.companyId, t.ruleId, t.wasteFractionId),
    tenantIndex(t, t.wasteFractionId),
  ],
)
