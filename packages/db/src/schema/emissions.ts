// Fleet emissions (M10 of #293): what a fuel emits and what a vehicle type
// burns of it, the two numbers a route's planned distance is measured by
// (@waste/domain/resources/emissions). Both are the company's configuration,
// like the vehicle types they sit beside, and both are whole numbers in the
// domain's units, as money is minor units.
//
// `fuel_emission_factor` is grams of CO₂e per unit of a fuel — a litre, a
// kilogram of gas, a kilowatt-hour (`FUEL_UNIT`) — over a half-open period
// (ADR-0005), since the published factors are revised each year and a route
// is judged by the factor in force on its day: two periods of one fuel never
// overlap (`excludeOverlapping` over the fuel, in the migration). Zero is a
// factor — the published rules count a biofuel documented as sustainable as
// nothing burnt — so the bound is non-negative, where the consumption's is
// positive. `source` says where the number comes from, the published list
// and its year, or that it is a demo value.
//
// `vehicle_type_consumption` is a vehicle type's consumption by fuel, in
// thousandths of the fuel's unit per kilometre — millilitres, grams or
// watt-hours — since one type may be a diesel truck or an electric one and
// the fuel is the vehicle's. One row per type and fuel, replaced whole as a
// set from the type's side (`PUT /vehicle-types/:id/consumption`), as its
// container types are.
import { FUEL_TYPES } from "@waste/domain/resources/vocabulary"
import { GRAMS_PER_UNIT_MAX, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { sql } from "drizzle-orm"
import { check, integer, text, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, tenant, timestamps, validity, validPeriod } from "./columns"
import { vehicleType } from "./fleet-types"
import { company } from "./organisation"
import { companyReference, tenantReference } from "./references"
import { wms } from "./wms"

export const fuelEmissionFactor = wms.table(
  "fuel_emission_factor",
  {
    ...id,
    ...tenant,
    ...timestamps,
    fuel: text().notNull(),
    /** Grams of CO₂e per unit of the fuel; zero for a fuel counted as nothing burnt. */
    gramsPerUnit: integer().notNull(),
    /** Where the number comes from: the published list and its year, or a demo value. */
    source: text().notNull(),
    ...validity,
  },
  (t) => [
    companyReference(t, company),
    oneOf(t.fuel, FUEL_TYPES),
    check(tableObjectName(t.gramsPerUnit.table, "grams_per_unit_bounds", "fuelEmissionFactor"), sql`${t.gramsPerUnit} between 0 and ${sql.raw(String(GRAMS_PER_UNIT_MAX))}`),
    check(tableObjectName(t.source.table, "source_given", "fuelEmissionFactor"), sql`length(btrim(${t.source})) > 0`),
    validPeriod(t),
  ],
)

export const vehicleTypeConsumption = wms.table(
  "vehicle_type_consumption",
  {
    ...id,
    ...tenant,
    ...timestamps,
    vehicleTypeId: uuid().notNull(),
    fuel: text().notNull(),
    /** Thousandths of the fuel's unit per kilometre: millilitres, grams or watt-hours. */
    milliUnitsPerKm: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.vehicleTypeId], vehicleType),
    oneOf(t.fuel, FUEL_TYPES),
    check(tableObjectName(t.milliUnitsPerKm.table, "milli_units_per_km_bounds", "vehicleTypeConsumption"), sql`${t.milliUnitsPerKm} between 1 and ${sql.raw(String(MILLI_UNITS_PER_KM_MAX))}`),
    // One consumption per type and fuel, led by the type whose set it is.
    unique(tableObjectName(t.companyId.table, "type_fuel_key", "vehicleTypeConsumption")).on(t.companyId, t.vehicleTypeId, t.fuel),
  ],
)
