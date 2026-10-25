// The fleet's emissions on the wire (M10 of #293): a fuel's emission factor,
// a vehicle type's consumption by fuel, and the report that measures the
// routes by them (@waste/domain/resources/emissions). The routes are
// apps/api/src/routes/emissions.ts.
//
// Both numbers are whole, as money is minor units: a factor in grams of CO₂e
// per unit of its fuel (`unit`, the domain's `FUEL_UNIT`: a litre, a kilogram
// of gas, a kilowatt-hour), zero for a fuel counted as nothing burnt; a
// consumption in thousandths of the fuel's unit per kilometre — millilitres,
// grams or watt-hours — at least one. Each is capped where no fuel or truck
// reaches. A factor is effective-dated per company (ADR-0005): its fuel, its
// number and its start are its period's own, so a patch moves the end and
// the source alone — end it and add the next year's. A type's consumption is
// a set, one per fuel, replaced whole through `PUT /vehicle-types/{id}/
// consumption` and read on the vehicle type.
//
// The report measures each route operating in its window, a cancelled one
// left out since it never drove, from its active Plan's distance, its planned
// vehicle's fuel and type, and the factor in force on its operating date. A
// route missing any of them is unmeasured — counted by its first gap, never
// as zero. The totals by vehicle and by project are the routes' own figures
// summed; the totals by fraction share each route's grams over its stops'
// fractions by count, an approximation the report names as split by stops.
// The saving is the optimiser's: a route whose active Plan is the
// optimiser's, against its measured baseline. What the route actually drove
// is O8's, which leaves `actualGrams` null until it lands.
import { GRAMS_PER_UNIT_MAX, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { EMISSION_GAPS, ENERGY_UNITS, FUEL_TYPES } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { dayWindowIsOrdered, dayWindowOrdered } from "./queries"
import { ReportDay, REPORT_WINDOW_TOO_LONG, reportWindowFits } from "./reports"
import { FuelType } from "./resources"
import { changesSomething, eachOnce, eachOnceSentence, NonNegativeTotal, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** The unit a fuel is burnt and its factor given in. */
export const EnergyUnit = z.enum(ENERGY_UNITS)
export type EnergyUnit = z.infer<typeof EnergyUnit>

/** Why a route is unmeasured, the first fact it lacks. */
export const EmissionGap = z.enum(EMISSION_GAPS)
export type EmissionGap = z.infer<typeof EmissionGap>

/** Grams of CO₂e per unit of the fuel: zero for a fuel counted as nothing burnt, at most the domain's bound. */
export const GramsPerUnit = z.int().min(0).max(GRAMS_PER_UNIT_MAX)
/** Thousandths of the fuel's unit per kilometre: at least one, at most the domain's bound. */
export const MilliUnitsPerKm = z.int().min(1).max(MILLI_UNITS_PER_KM_MAX)

export const FuelEmissionFactor = z
  .object({
    ...stamped,
    fuel: FuelType,
    /** The unit `gramsPerUnit` is per: the fuel's, never stored. */
    unit: EnergyUnit,
    gramsPerUnit: GramsPerUnit,
    /** Where the number comes from: the published list and its year, or a demo value. */
    source: Paragraph,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type FuelEmissionFactor = z.infer<typeof FuelEmissionFactor>

export const FuelEmissionFactorCreate = z
  .strictObject({
    fuel: FuelType,
    gramsPerUnit: GramsPerUnit,
    source: Paragraph,
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type FuelEmissionFactorCreate = z.infer<typeof FuelEmissionFactorCreate>

/** The end and the source; the fuel, the number and the start are the period's own — end it and add the next. */
export const FuelEmissionFactorPatch = z
  .strictObject({
    source: Paragraph.optional(),
    /** Null reopens the period; a day ends it, the first day out of force. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type FuelEmissionFactorPatch = z.infer<typeof FuelEmissionFactorPatch>

/** A page of the company's factors: one fuel's, in force on a day where `validOn` says. */
export const FuelEmissionFactorListQuery = PageRequest.extend({ fuel: FuelType.optional(), validOn: IsoDate.optional() })
export type FuelEmissionFactorListQuery = z.infer<typeof FuelEmissionFactorListQuery>

/** One fuel's consumption on a vehicle type, as the type carries it. */
export const VehicleTypeConsumption = z.object({ fuel: FuelType, unit: EnergyUnit, milliUnitsPerKm: MilliUnitsPerKm })
export type VehicleTypeConsumption = z.infer<typeof VehicleTypeConsumption>

/** What a consumption set naming a fuel twice is told. */
export const EACH_FUEL_ONCE = eachOnceSentence("fuel", "a vehicle type burns one amount of each")

/** `PUT /vehicle-types/:id/consumption`: the whole set, one per fuel; empty is a type whose routes are unmeasured. */
export const VehicleTypeConsumptionSet = z
  .strictObject({
    consumption: z.array(z.strictObject({ fuel: FuelType, milliUnitsPerKm: MilliUnitsPerKm })).max(FUEL_TYPES.length),
  })
  .refine((body) => eachOnce(body.consumption, (entry) => entry.fuel), { message: EACH_FUEL_ONCE, path: ["consumption"] })
export type VehicleTypeConsumptionSet = z.infer<typeof VehicleTypeConsumptionSet>

/** `GET /reports/emissions`: one project's or every one of the caller's, over a window of operating days; no series, since an emission total is the window's. */
export const EmissionsReportQuery = z
  .strictObject({
    /** One of the caller's projects; absent, every project they work in. */
    projectId: Id.optional(),
    /** The first operating day, inclusive. */
    from: ReportDay,
    /** The last, inclusive. */
    to: ReportDay,
  })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine(reportWindowFits, { message: REPORT_WINDOW_TOO_LONG, path: ["to"] })
export type EmissionsReportQuery = z.infer<typeof EmissionsReportQuery>

/** Whole grams, metres and routes, summed: a fleet's year may pass an `integer`. */
const Total = NonNegativeTotal

/** What the measured routes of a group drove and emitted. */
const measuredFields = { routes: Total, metres: Total, grams: Total }

export const EmissionsByVehicle = z.object({ vehicleId: Id, callsign: Label.nullable(), fuel: FuelType, ...measuredFields })
export type EmissionsByVehicle = z.infer<typeof EmissionsByVehicle>

export const EmissionsByProject = z.object({ projectId: Id, name: Label, ...measuredFields })
export type EmissionsByProject = z.infer<typeof EmissionsByProject>

/** A fraction's share of the measured grams, split by stops; a null fraction is the grams of routes with no counted stop. */
export const EmissionsByFraction = z.object({ wasteFractionId: Id.nullable(), name: Label.nullable(), grams: Total })
export type EmissionsByFraction = z.infer<typeof EmissionsByFraction>

export const EmissionsUnmeasured = z.object({ gap: EmissionGap, routes: Total })
export type EmissionsUnmeasured = z.infer<typeof EmissionsUnmeasured>

export const EmissionsReport = z.object({
  window: z.object({ projectId: Id.nullable(), from: IsoDate, to: IsoDate }),
  /** The routes measured, from their active Plans: what the window planned to drive and emit. */
  planned: z.object({ ...measuredFields }),
  /** What the routes drove, from their sessions (O8); null until then. */
  actualGrams: Total.nullable(),
  /** The routes not measured, by their first gap, each gap once, in the vocabulary's order; none where every route was measured. */
  unmeasured: z.array(EmissionsUnmeasured),
  byVehicle: z.array(EmissionsByVehicle),
  byProject: z.array(EmissionsByProject),
  /** Split by stops: each route's grams over its stops' fractions by count, an approximation. */
  byFraction: z.array(EmissionsByFraction),
  /** The optimiser's saving on the routes whose active Plan is its own and whose baseline was measured: the baseline less the active Plan, negative where it drove further. */
  saving: z.object({ routes: Total, metres: z.int(), grams: z.int() }),
})
export type EmissionsReport = z.infer<typeof EmissionsReport>
