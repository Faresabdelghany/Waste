// The wire of recycling-centre visits (Issue #393, M4 of #293): the register
// of Access Credentials, the Site Visit ledger, the attendant's check-in and
// its answer, and the likely trades. The routes are
// apps/api/src/routes/access-credentials.ts and site-visits.ts; what a
// credential admits and what a visit costs are @waste/domain/visits/charges.
//
// A credential is a plate or a card, registered for a project's recycling
// centres under its holder: a business's Customer with the Agreement its
// visits are charged to, or a household's Property. Its kind, value and
// holder are what it is, and its start its period's (ADR-0005), so a patch
// moves its label and its end alone; it is blocked and unblocked by command,
// and never deleted. A value is stored as `normaliseCredentialValue` spells
// it: upper case, no spaces.
//
// A visit is an append the attendant's check-in or the gate's read makes,
// admitted or refused with the reason, and voided with a reason, never
// deleted: the ledger is the bookkeeping evidence for its charges.
import { normaliseCredentialValue } from "@waste/domain/visits/charges"
import { ACCESS_CREDENTIAL_KINDS, SITE_VISIT_IDENTIFICATIONS, SITE_VISIT_OUTCOMES, SITE_VISIT_REFUSAL_REASONS, SITE_VISIT_SOURCES, VISIT_CHARGE_BASES } from "@waste/domain/visits/vocabulary"
import { BLOCK_REASONS } from "@waste/domain/finance/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery, dayWindowIsOrdered, dayWindowOrdered } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, Minor, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

export const AccessCredentialKind = z.enum(ACCESS_CREDENTIAL_KINDS)
export type AccessCredentialKind = z.infer<typeof AccessCredentialKind>
export const SiteVisitSource = z.enum(SITE_VISIT_SOURCES)
export type SiteVisitSource = z.infer<typeof SiteVisitSource>
export const SiteVisitIdentification = z.enum(SITE_VISIT_IDENTIFICATIONS)
export type SiteVisitIdentification = z.infer<typeof SiteVisitIdentification>
export const SiteVisitOutcome = z.enum(SITE_VISIT_OUTCOMES)
export type SiteVisitOutcome = z.infer<typeof SiteVisitOutcome>
export const SiteVisitRefusalReason = z.enum(SITE_VISIT_REFUSAL_REASONS)
export type SiteVisitRefusalReason = z.infer<typeof SiteVisitRefusalReason>
export const VisitChargeBasis = z.enum(VISIT_CHARGE_BASES)
export type VisitChargeBasis = z.infer<typeof VisitChargeBasis>

/** The longest plate or card number a credential holds, normalised. */
export const CREDENTIAL_VALUE_MAX = 32

/** What a value that normalises to nothing usable is told. */
export const CREDENTIAL_VALUE_SHAPE = "A plate or card number of letters and digits; spaces and hyphens are dropped and letters read upper case"

/** A plate or a card as a person types it: it normalises to letters and digits, at most `CREDENTIAL_VALUE_MAX`, so `AB-12 345` and `ab12345` are one plate. */
export const CredentialValue = z
  .string()
  .max(CREDENTIAL_VALUE_MAX * 2)
  .refine((value) => /^[A-Z0-9]+$/.test(normaliseCredentialValue(value)) && normaliseCredentialValue(value).length <= CREDENTIAL_VALUE_MAX, { message: CREDENTIAL_VALUE_SHAPE })

/** A credential's holder is a business's Customer with its Agreement, or a household's Property: exactly one. */
const oneHolder = (value: { customerId?: string | null; agreementId?: string | null; propertyId?: string | null }): boolean =>
  value.propertyId != null ? value.customerId == null && value.agreementId == null : value.customerId != null && value.agreementId != null
/** What a credential with no holder, half a business's, or both is told, at the Property. */
export const ONE_HOLDER = "A credential is a business's — its customer and the agreement its visits are charged to — or a household's Property, exactly one"
const oneHolderAt = { message: ONE_HOLDER, path: ["propertyId"] }

export const AccessCredential = z
  .object({
    ...stamped,
    projectId: Id,
    kind: AccessCredentialKind,
    /** Normalised: upper case, no spaces and no hyphens. */
    value: z.string(),
    /** What the office calls it: `Van 2`, `Garden card`. */
    label: Label.nullable(),
    /** A business's: its Customer, and the Agreement its visits are charged to. */
    customerId: Id.nullable(),
    agreementId: Id.nullable(),
    /** A household's: its Property. */
    propertyId: Id.nullable(),
    /** Set while the credential is blocked: a blocked one turns its visits away. */
    blockedAt: IsoDateTime.nullable(),
    blockedReason: Paragraph.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type AccessCredential = z.infer<typeof AccessCredential>

export const AccessCredentialCreate = z
  .strictObject({
    projectId: Id,
    kind: AccessCredentialKind,
    value: CredentialValue,
    label: Label.nullable().optional(),
    customerId: Id.nullable().optional(),
    agreementId: Id.nullable().optional(),
    propertyId: Id.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
  .refine(oneHolder, oneHolderAt)
export type AccessCredentialCreate = z.infer<typeof AccessCredentialCreate>

/** The label and the end: the kind, the value and the holder are what the credential is, and its start its period's — end it and register another. */
export const AccessCredentialPatch = z
  .strictObject({
    label: Label.nullable().optional(),
    /** Null reopens the credential; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type AccessCredentialPatch = z.infer<typeof AccessCredentialPatch>

/** `POST /access-credentials/:id/block`: why it is blocked, as the office will read it. */
export const AccessCredentialBlock = z.strictObject({ reason: Paragraph })
export type AccessCredentialBlock = z.infer<typeof AccessCredentialBlock>

/** A page of credentials: one project's, one kind's, one value's (normalised as it is stored), one holder's, in force on a day, or blocked or not. */
export const AccessCredentialListQuery = ProjectScopedListQuery.extend({
  kind: AccessCredentialKind.optional(),
  value: CredentialValue.optional(),
  customerId: Id.optional(),
  propertyId: Id.optional(),
  validOn: IsoDate.optional(),
  blocked: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
})
export type AccessCredentialListQuery = z.infer<typeof AccessCredentialListQuery>

/** What a visit was charged at when it was checked in — the number the attendant quoted, stored with the visit so a later void or a backdated check-in never re-tiers it: why, its place among its Property's counted visits this year (a household's), and the product, null where it is included. */
export const VisitChargeQuoted = z.object({
  basis: VisitChargeBasis,
  n: PositiveInt.nullable(),
  productId: Id.nullable(),
})
export type VisitChargeQuoted = z.infer<typeof VisitChargeQuoted>

export const SiteVisit = z.object({
  ...stamped,
  projectId: Id,
  /** The recycling centre: a Drop-off Point of kind `recycling-centre`. */
  siteId: Id,
  occurredAt: IsoDateTime,
  /** The visit's day on its project's clock: the day it is charged on. */
  serviceDate: IsoDate,
  source: SiteVisitSource,
  /** The gate's own id of its read (M8 of #293), unique per company and source; null for the attendant's check-in. */
  externalId: z.string().nullable(),
  identification: SiteVisitIdentification,
  /** The plate or the card as read, normalised; null where the attendant found the Property by its address. */
  identifierValue: z.string().nullable(),
  /** The credential in force for the plate or the card on the day; null where none was. */
  credentialId: Id.nullable(),
  /** Whom it reached: a household's Property and the Agreement it pays under, or a business's Customer and Agreement. */
  propertyId: Id.nullable(),
  customerId: Id.nullable(),
  agreementId: Id.nullable(),
  outcome: SiteVisitOutcome,
  refusalReason: SiteVisitRefusalReason.nullable(),
  /** The attendant who checked the visit in; null for the gate's read. */
  recordedBy: Id.nullable(),
  note: Paragraph.nullable(),
  /** The fractions brought, each one the site takes; none recorded for a gate's read. */
  wasteFractionIds: z.array(Id),
  /** What the visit was charged at when it was recorded; null for a refused one. */
  charge: VisitChargeQuoted.nullable(),
  /** Set once the visit is voided: a mistake is voided, never deleted. */
  voidedAt: IsoDateTime.nullable(),
  voidedBy: Id.nullable(),
  voidReason: Paragraph.nullable(),
})
export type SiteVisit = z.infer<typeof SiteVisit>

/** What a check-in's fractions naming one twice is told. */
export const EACH_VISIT_FRACTION_ONCE = eachOnceSentence("waste fraction", "a visit brings a fraction or it does not")

/** The fractions a visit brought: each once. */
const VisitFractionIds = z
  .array(Id)
  .max(50)
  .refine((ids) => eachOnce(ids), { message: EACH_VISIT_FRACTION_ONCE })

/** What a visit was identified by: a plate or a card as read, or the Property the attendant found by its address. */
export const VisitIdentifier = z.discriminatedUnion("kind", [z.strictObject({ kind: AccessCredentialKind, value: CredentialValue }), z.strictObject({ kind: z.literal("property"), propertyId: Id })])
export type VisitIdentifier = z.infer<typeof VisitIdentifier>

/** `POST /site-visits`: the attendant's check-in at a site — what identified the visitor, the fractions brought (each one the site takes), a note, and the instant, the request's own when absent. */
export const SiteVisitCheckIn = z.strictObject({
  siteId: Id,
  identifier: VisitIdentifier,
  wasteFractionIds: VisitFractionIds.default([]),
  note: Paragraph.nullable().optional(),
  occurredAt: IsoDateTime.optional(),
})
export type SiteVisitCheckIn = z.infer<typeof SiteVisitCheckIn>

/** The price a charged visit's product resolves to under its Agreement on the day, as its billable event will freeze it. */
export const VisitPrice = z.object({
  unitPriceMinor: Minor,
  netMinor: Minor,
  vatPercent: NonNegativeInt,
  vatMinor: Minor,
  currency: z.string(),
})
export type VisitPrice = z.infer<typeof VisitPrice>

/** What an admitted visit costs, as the check-in answers it: what it was charged at — stored with the visit, so the number quoted is the number charged — and the product's price under the visit's Agreement on its day, or why it has none. */
export const VisitChargeReading = VisitChargeQuoted.extend({
  price: VisitPrice.nullable(),
  /** Why a charged visit's product has no price yet, as its billable event will be blocked. */
  blockReason: z.enum(BLOCK_REASONS).nullable(),
})
export type VisitChargeReading = z.infer<typeof VisitChargeReading>

/** The check-in's answer: the visit as recorded, and for an admitted one what it costs — "visit 3 this year: 70 kr". */
export const SiteVisitCheckInAnswer = z.object({
  visit: SiteVisit,
  charge: VisitChargeReading.nullable(),
})
export type SiteVisitCheckInAnswer = z.infer<typeof SiteVisitCheckInAnswer>

/** `POST /site-visits/:id/void`: why, as the ledger will keep it. */
export const SiteVisitVoid = z.strictObject({ reason: Paragraph })
export type SiteVisitVoid = z.infer<typeof SiteVisitVoid>

/** A page of the ledger, newest first: one project's, one site's, a window of days, one Property's, one Customer's, one source's or one outcome's. */
export const SiteVisitListQuery = ProjectScopedListQuery.extend({
  siteId: Id.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  propertyId: Id.optional(),
  customerId: Id.optional(),
  source: SiteVisitSource.optional(),
  outcome: SiteVisitOutcome.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type SiteVisitListQuery = z.infer<typeof SiteVisitListQuery>

/** `GET /site-visits/frequent`: one project's likely trades on a day, the project's today when absent. */
export const FrequentVisitorsQuery = z.strictObject({
  projectId: Id,
  on: IsoDate.optional(),
})
export type FrequentVisitorsQuery = z.infer<typeof FrequentVisitorsQuery>

/** One Property its rule flags as a likely trade, with its counted visits in the window. */
export const LikelyTrade = z.object({ propertyId: Id, visits: PositiveInt })
export type LikelyTrade = z.infer<typeof LikelyTrade>

/** The likely trades on a day: the rule in force and its threshold and window, and the Properties at or past it, most visits first. A reading, never stored. */
export const FrequentVisitors = z.object({
  projectId: Id,
  on: IsoDate,
  ruleId: Id.nullable(),
  threshold: PositiveInt.nullable(),
  windowDays: PositiveInt.nullable(),
  items: z.array(LikelyTrade),
})
export type FrequentVisitors = z.infer<typeof FrequentVisitors>

/** `GET /site-visits/sites`: one project's recycling centres an attendant checks visitors in at. */
export const VisitSitesQuery = z.strictObject({ projectId: Id })
export type VisitSitesQuery = z.infer<typeof VisitSitesQuery>

/** A fraction a recycling centre takes, by the name its chip shows. */
export const VisitSiteFraction = z.object({ id: Id, name: Label })
export type VisitSiteFraction = z.infer<typeof VisitSiteFraction>

/** A recycling centre as the check-in picks it: what it is called and the fractions it takes, by name, nothing of the office's. */
export const VisitSite = z.object({
  id: Id,
  projectId: Id,
  code: Label,
  name: Label,
  wasteFractions: z.array(VisitSiteFraction),
})
export type VisitSite = z.infer<typeof VisitSite>

export const VisitSites = z.object({ items: z.array(VisitSite) })
export type VisitSites = z.infer<typeof VisitSites>

/** The most Properties an address search answers. */
export const VISIT_ADDRESS_MAX = 20

/** `GET /site-visits/addresses`: one project's Properties whose name or address holds `q`, for a check-in by address. */
export const VisitAddressQuery = z.strictObject({
  projectId: Id,
  q: z.string().trim().min(2).max(100),
})
export type VisitAddressQuery = z.infer<typeof VisitAddressQuery>

/** A Property as the check-in finds it by its address: what identifies it and nothing else — no parties, no notes, no subscriptions. */
export const VisitAddress = z.object({
  propertyId: Id,
  projectId: Id,
  name: Label,
  address: z.string(),
})
export type VisitAddress = z.infer<typeof VisitAddress>

export const VisitAddresses = z.object({ items: z.array(VisitAddress).max(VISIT_ADDRESS_MAX) })
export type VisitAddresses = z.infer<typeof VisitAddresses>
