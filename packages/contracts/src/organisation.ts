// The organisation half of Organisation & Access on the wire (Issue #70): the
// tenant itself, its Projects, and the Service Providers it works with. One
// schema per resource and one per write body, because they are different
// things: a resource carries what the server owns (the id it minted, the
// instants the database stamped), a write body carries only what a caller may
// say, and the write bodies are strict, so a member the server owns — an id,
// a timestamp, a company's status — is refused by name instead of silently
// dropped.
//
// A patch is every field optional and at least one given: a patch with
// nothing in it is a request that means nothing, and answering 200 to it
// would hide a client bug. The company's `status` is not among them
// (onboarding to active is an operator's act, not a tenant's), and neither is
// anything the database derives.
//
// The coded fields are checked by shape and not against a list (codes.ts).
// `kind` is free text on purpose: the prototype's Municipality, Business
// unit, Contract and Region are labels, not a vocabulary.
//
// The statuses are text with a CHECK in the database and this enum at the
// boundary, both over the domain's lists (@waste/domain/access/vocabulary).
//
// A Project carries its working week (Issue #97): `weekend`, the days it
// rests on, as a set of `ServiceDay`s from `planning.ts` (each named once,
// possibly none), never derived from a weekday number since Cairo rests
// Friday–Saturday; and `holidayList`, the name its holidays are looked up
// under, null for a project that rests on its weekend only, whatever calendars
// it has. A create body may leave both out and gets the database's defaults,
// Saturday–Sunday and no list, which the schema says so the document does too;
// the default is the domain's `DEFAULT_WEEKEND`, the same constant the column
// default is built from. A weekend never holds all seven days
// (@waste/domain/access/projects): the holiday policy shifts a collection to
// the next working day, and a project with none would send it two months out.
import { BRAND_COLOR_PATTERN, BRAND_COLOR_SHAPE, brandColorReadable, brandColorRefusal, HTTPS_ADDRESS_MAX, HTTPS_ADDRESS_PATTERN, HTTPS_ADDRESS_SHAPE } from "@waste/domain/access/branding"
import { A_WORKING_DAY, WEEKEND_MAX } from "@waste/domain/access/projects"
import { PUBLIC_SLUG_LENGTH, PUBLIC_SLUG_SHAPE } from "@waste/domain/access/public-slug"
import { COMPANY_STATUSES, PROJECT_STATUSES } from "@waste/domain/access/vocabulary"
import { DEFAULT_WEIGHT_TOLERANCE_PERCENT, WEIGHT_TOLERANCE_PERCENT } from "@waste/domain/execution/unloads"
import { DEFAULT_WEEKEND } from "@waste/domain/planning/vocabulary"
import { changesSomething } from "@waste/domain/requests"
import { SLUG_PATTERN } from "@waste/domain/text"
import * as z from "zod"

import { Country, Currency, Language, Timezone } from "./codes"
import { Bic, DEFAULT_PAYMENT_TERMS_DAYS, FikCreditorNumber, Iban, PaymentReferenceScheme, PaymentTermsDays, VatNumber } from "./finance"
import { ServiceDays } from "./planning"
import { PositiveInt, resourceBodies, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

/** A company's status: onboarding until its first project runs. */
export const CompanyStatus = z.enum(COMPANY_STATUSES)
export type CompanyStatus = z.infer<typeof CompanyStatus>

/** A project's status: onboarding until it runs. */
export const ProjectStatus = z.enum(PROJECT_STATUSES)
export type ProjectStatus = z.infer<typeof ProjectStatus>

/** The name a project publishes itself under on the public door (ADR-0010): `@waste/domain/access/public-slug`'s shape, unique across every company. */
export const PublicSlug = z
  .string()
  .min(PUBLIC_SLUG_LENGTH.min)
  .max(PUBLIC_SLUG_LENGTH.max)
  .regex(new RegExp(SLUG_PATTERN), PUBLIC_SLUG_SHAPE)

export const Company = z.object({
  ...stamped,
  name: Label,
  legalName: Label,
  /** As the company registry spells it (a CVR number in Denmark); unique per country. */
  registrationNumber: Label,
  country: Country,
  status: CompanyStatus,
  /** The invoice identity (#291 C4), what an invoice document prints; each null until the administrator sets it. */
  vatNumber: VatNumber.nullable(),
  bankIban: Iban.nullable(),
  bankBic: Bic.nullable(),
  /** The creditor number a FI card names: what a project's FIK scheme needs. */
  fikCreditorNumber: FikCreditorNumber.nullable(),
  /** Where the company is written to (#291 C5), its lines by newlines: the seller's address an invoice prints; null until set. */
  postalAddress: Paragraph.nullable(),
})
export type Company = z.infer<typeof Company>

/** What an administrator may change about their own company. The status is not theirs to set. */
export const CompanyPatch = z
  .strictObject({
    name: Label.optional(),
    legalName: Label.optional(),
    registrationNumber: Label.optional(),
    country: Country.optional(),
    /** Null clears it. */
    vatNumber: VatNumber.nullable().optional(),
    bankIban: Iban.nullable().optional(),
    bankBic: Bic.nullable().optional(),
    /** Null clears it, which a project charging by a FI card refuses. */
    fikCreditorNumber: FikCreditorNumber.nullable().optional(),
    /** Null clears it. */
    postalAddress: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type CompanyPatch = z.infer<typeof CompanyPatch>

/** A project's weighbridge tolerance, in whole percent, within the domain's bounds (O9 of #290). */
const ProjectTolerance = PositiveInt.max(WEIGHT_TOLERANCE_PERCENT.max)

/** The days a project rests on: distinct weekdays, at most six. */
const Weekend = ServiceDays.max(WEEKEND_MAX, { error: A_WORKING_DAY })

/** A colour as `#RRGGBB`, lowercased as kept. */
const BrandColor = z
  .string()
  .regex(new RegExp(BRAND_COLOR_PATTERN), BRAND_COLOR_SHAPE)
  .transform((color) => color.toLowerCase())

/** An address the project serves itself: https, a host, no whitespace. */
const HttpsAddress = z.string().max(HTTPS_ADDRESS_MAX).regex(new RegExp(HTTPS_ADDRESS_PATTERN), HTTPS_ADDRESS_SHAPE)

/**
 * A project's branding on its public pages (M22 of #293): one colour drawn
 * behind white text, a logo and an accessibility statement it serves itself
 * over https. Null each is none: the pages look as they do unbranded, and
 * name no statement.
 */
export const ProjectBranding = z.object({
  brandColor: BrandColor.nullable(),
  logoUrl: HttpsAddress.nullable(),
  accessibilityStatementUrl: HttpsAddress.nullable(),
})
export type ProjectBranding = z.infer<typeof ProjectBranding>

/** `PUT /projects/:id/branding`: the branding replaced whole, a colour white text cannot be read on at WCAG 2.1 AA refused. */
export const ProjectBrandingReplace = z.strictObject({
  brandColor: BrandColor.refine(brandColorReadable, { error: (issue) => brandColorRefusal(String(issue.input)) }).nullable(),
  logoUrl: HttpsAddress.nullable(),
  accessibilityStatementUrl: HttpsAddress.nullable(),
})
export type ProjectBrandingReplace = z.infer<typeof ProjectBrandingReplace>

export const Project = z.object({
  ...stamped,
  name: Label,
  /** Free text: Municipality, Business unit, Contract, Region. */
  kind: Label,
  language: Language,
  currency: Currency,
  timezone: Timezone,
  status: ProjectStatus,
  /** The days the project rests on, at most six; a holiday policy shifts a collection past them. */
  weekend: Weekend,
  /** The name its holidays are looked up under (`Danish public holidays`); null is no list, and then the project rests on its weekend only. */
  holidayList: Label.nullable(),
  /** The name it publishes itself under on the public door, `/public/<slug>` (ADR-0010); null is unpublished. */
  publicSlug: PublicSlug.nullable(),
  /** How many days after issue its invoices are due (#291 C4), unless a customer has terms of its own. */
  paymentTermsDays: PaymentTermsDays,
  /** How its invoices are referenced for payment: none, or a FI card, which needs the company's creditor number. */
  paymentReferenceScheme: PaymentReferenceScheme,
  /** How far a weighbridge's net may differ from what the stops weighed on board, in whole percent, before an unload reads as above tolerance (O9 of #290); absent from a payload before it, read as the default. */
  weightTolerancePercent: ProjectTolerance.default(DEFAULT_WEIGHT_TOLERANCE_PERCENT),
  /** Whether the project's hires and jobs are held for the office's review as they are charged (M14 of #293): a run passes over a held event until it is released. */
  holdForReview: z.boolean(),
  /** Its branding on its public pages (M22 of #293), written whole through `PUT /projects/:id/branding` under `configure.portals`; absent from a payload before it, read as none. */
  branding: ProjectBranding.default({ brandColor: null, logoUrl: null, accessibilityStatementUrl: null }),
})
export type Project = z.infer<typeof Project>

/**
 * A patch's null holiday list drops the list, a name sets it. A slug only a
 * patch takes: it publishes the project under it, and null unpublishes it —
 * its public pages answer 404 from the next request (an answer cached before
 * runs out within the minute).
 */
const projectBodies = resourceBodies(
  {
    name: Label,
    kind: Label,
    language: Language,
    currency: Currency,
    timezone: Timezone,
    status: ProjectStatus.default("onboarding").describe("Defaults to onboarding when absent: a project is onboarding until it runs."),
    weekend: Weekend.default([...DEFAULT_WEEKEND]).describe("Defaults to Saturday and Sunday when absent: the days the project rests on, each named once, at most six."),
    holidayList: Label.nullable().optional().describe("Null or absent is no holiday list: the project then rests on its weekend only, whatever calendars it has."),
    paymentTermsDays: PaymentTermsDays.default(DEFAULT_PAYMENT_TERMS_DAYS).describe(`Defaults to ${DEFAULT_PAYMENT_TERMS_DAYS} when absent: the days after issue the project's invoices are due, 0 to 365.`),
    paymentReferenceScheme: PaymentReferenceScheme.default("none").describe("Defaults to none when absent: a FI card's scheme needs the company's creditor number."),
    weightTolerancePercent: ProjectTolerance.default(DEFAULT_WEIGHT_TOLERANCE_PERCENT).describe("Defaults to 5 when absent: how far a weighbridge's net may differ from the load weighed on board, in whole percent (O9 of #290)."),
    holdForReview: z.boolean().default(false).describe("Defaults to false when absent: a project's hires and jobs go to the run as they are charged."),
  },
  { patch: { publicSlug: PublicSlug.nullable().optional() } },
)

export const ProjectCreate = projectBodies.create
export type ProjectCreate = z.infer<typeof ProjectCreate>

export const ProjectPatch = projectBodies.patch
export type ProjectPatch = z.infer<typeof ProjectPatch>

export const ServiceProvider = z.object({
  ...stamped,
  legalName: Label,
  /** Unique per country within the company. */
  registrationNumber: Label,
  country: Country,
  contactName: Label,
  contactEmail: z.email(),
})
export type ServiceProvider = z.infer<typeof ServiceProvider>

const serviceProviderBodies = resourceBodies({
  legalName: Label,
  registrationNumber: Label,
  country: Country,
  contactName: Label,
  contactEmail: z.email(),
})

export const ServiceProviderCreate = serviceProviderBodies.create
export type ServiceProviderCreate = z.infer<typeof ServiceProviderCreate>

export const ServiceProviderPatch = serviceProviderBodies.patch
export type ServiceProviderPatch = z.infer<typeof ServiceProviderPatch>
