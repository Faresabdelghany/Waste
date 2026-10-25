// The customer sustainability report on the wire (M13 of #293): a waste
// fraction's emission factor, and the report that reads a Customer's
// collected waste by site and fraction (@waste/domain/insight/sustainability).
// A fraction's treatment is the fraction's own (`WasteTreatment`,
// catalogue.ts). The routes are apps/api/src/routes/sustainability.ts.
//
// A factor is effective-dated per company (ADR-0005), whole kilograms CO₂e
// per tonne from zero to the domain's bound: what a tonne of the fraction
// emits once treated, and what it avoids where its treatment displaces
// anything. Its fraction, its figures and its start are its period's own, so
// a patch moves the end and the source alone — end it and add the next. The
// source is required: no factor stands without the publication it is quoted
// from.
//
// The report reads one Customer's completed stops over a window of operating
// days: each weighed best first (`WeightBasis`), summed per site — the stop's
// property or shared collection point — and fraction, with the stops counted
// by how they were weighed, the CO₂e in whole grams where every weighed stop
// of the line had a factor in force, the recycling rate over every weighed
// kilogram, and the warnings naming a fraction with no treatment or no
// factor. A stop without a container belongs to no Customer's agreement and
// is counted at the site as not attributed.
import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"
import { SUSTAINABILITY_WARNINGS, WEIGHT_BASES } from "@waste/domain/insight/vocabulary"
import * as z from "zod"

import { WasteTreatment } from "./catalogue"
import { IsoDate } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { dayWindowIsOrdered, dayWindowOrdered } from "./queries"
import { REPORT_FILE_SEPARATORS, ReportDay, REPORT_WINDOW_TOO_LONG, reportWindowFits } from "./reports"
import { changesSomething, NonNegativeTotal, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** How the report weighed a stop. */
export const WeightBasis = z.enum(WEIGHT_BASES)
export type WeightBasis = z.infer<typeof WeightBasis>

/** What the report warns of. */
export const SustainabilityWarningKind = z.enum(SUSTAINABILITY_WARNINGS)
export type SustainabilityWarningKind = z.infer<typeof SustainabilityWarningKind>

/** Kilograms CO₂e per tonne: zero to the domain's bound. */
export const KgPerTonne = z.int().min(0).max(KG_PER_TONNE_MAX)

export const WasteFractionEmissionFactor = z
  .object({
    ...stamped,
    wasteFractionId: Id,
    /** Kilograms CO₂e a tonne of the fraction emits once treated. */
    footprintKgPerTonne: KgPerTonne,
    /** Kilograms CO₂e a tonne of it avoids; null where its treatment displaces nothing. */
    avoidedKgPerTonne: KgPerTonne.nullable(),
    /** Where the numbers come from: the publication and its year. */
    source: Paragraph,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type WasteFractionEmissionFactor = z.infer<typeof WasteFractionEmissionFactor>

export const WasteFractionEmissionFactorCreate = z
  .strictObject({
    wasteFractionId: Id,
    footprintKgPerTonne: KgPerTonne,
    avoidedKgPerTonne: KgPerTonne.nullable().optional(),
    source: Paragraph,
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type WasteFractionEmissionFactorCreate = z.infer<typeof WasteFractionEmissionFactorCreate>

/** The end and the source; the fraction, the figures and the start are the period's own — end it and add the next. */
export const WasteFractionEmissionFactorPatch = z
  .strictObject({
    source: Paragraph.optional(),
    /** Null reopens the period; a day ends it, the first day out of force. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type WasteFractionEmissionFactorPatch = z.infer<typeof WasteFractionEmissionFactorPatch>

/** A page of the company's factors: one fraction's, in force on a day where `validOn` says. */
export const WasteFractionEmissionFactorListQuery = PageRequest.extend({ wasteFractionId: Id.optional(), validOn: IsoDate.optional() })
export type WasteFractionEmissionFactorListQuery = z.infer<typeof WasteFractionEmissionFactorListQuery>

/** `GET /reports/sustainability`: one Customer over a window of operating days; no series, since a report to a customer is the window's. */
export const SustainabilityReportQuery = z
  .strictObject({
    customerId: Id,
    /** The first operating day, inclusive. */
    from: ReportDay,
    /** The last, inclusive. */
    to: ReportDay,
  })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine(reportWindowFits, { message: REPORT_WINDOW_TOO_LONG, path: ["to"] })
export type SustainabilityReportQuery = z.infer<typeof SustainabilityReportQuery>

/** `GET /reports/sustainability.csv`: the report's query, and the separator a spreadsheet under the office's locale reads. */
export const SustainabilityFileQuery = z
  .strictObject({
    customerId: Id,
    from: ReportDay,
    to: ReportDay,
    separator: z.enum(REPORT_FILE_SEPARATORS).default("comma").describe("Commas when absent; semicolons for a spreadsheet under a Danish locale."),
  })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine(reportWindowFits, { message: REPORT_WINDOW_TOO_LONG, path: ["to"] })
export type SustainabilityFileQuery = z.infer<typeof SustainabilityFileQuery>

/** Whole kilograms, grams and stops, summed: a customer's year may pass an `integer`. */
const Total = NonNegativeTotal

/** One site's fraction: its kilograms by how they were weighed, its stops by the same, and its CO₂e where every weighed stop had a factor. */
export const SustainabilityLine = z.object({
  wasteFractionId: Id,
  name: Label,
  treatment: WasteTreatment.nullable(),
  kg: z.object({ measured: Total, apportioned: Total, estimated: Total }),
  stops: z.object({ measured: Total, apportioned: Total, estimated: Total, unmeasured: Total }),
  /** Grams CO₂e the line's weighed kilograms emitted once treated; null where a weighed stop had no factor in force on its day. */
  footprintGrams: Total.nullable(),
  /** Grams CO₂e they avoided; null as the footprint is. */
  avoidedGrams: Total.nullable(),
})
export type SustainabilityLine = z.infer<typeof SustainabilityLine>

/** A site of the Customer's: the property or the shared collection point its stops were at, exactly one. */
export const SustainabilitySite = z.object({
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  name: Label,
  address: Paragraph,
  lines: z.array(SustainabilityLine),
  /** The window's completed stops at the site that had no container, so no agreement of anyone's: counted, not weighed into the Customer's figures. */
  notAttributedStops: Total,
})
export type SustainabilitySite = z.infer<typeof SustainabilitySite>

export const SustainabilityWarning = z.object({ kind: SustainabilityWarningKind, wasteFractionId: Id, name: Label })
export type SustainabilityWarning = z.infer<typeof SustainabilityWarning>

export const SustainabilityReport = z.object({
  window: z.object({ customerId: Id, from: IsoDate, to: IsoDate }),
  sites: z.array(SustainabilitySite),
  totals: z.object({
    weighedKg: Total,
    recycledKg: Total,
    /** Reused and recycled over every weighed kilogram, 0..1; null where nothing was weighed. */
    recyclingRate: z.number().min(0).max(1).nullable(),
    /** Null where any line's is: a sum missing a line would read as the whole. */
    footprintGrams: Total.nullable(),
    avoidedGrams: Total.nullable(),
    unmeasuredStops: Total,
  }),
  warnings: z.array(SustainabilityWarning),
})
export type SustainabilityReport = z.infer<typeof SustainabilityReport>
