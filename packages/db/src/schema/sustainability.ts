// The customer sustainability report's configuration (M13 of #293): what a
// tonne of a waste fraction emits once treated and what it avoids, the
// factors the report's CO₂e is read by (@waste/domain/insight/sustainability).
// A fraction's treatment, which its recycling rate reads, is a column of the
// fraction itself (catalogue.ts).
//
// `waste_fraction_emission_factor` is the company's: kilograms CO₂e per
// tonne treated, and per tonne avoided where the treatment displaces
// anything — recycling's virgin material, energy recovery's fuel — over a
// half-open period (ADR-0005), since published factors are revised and a
// stop is judged by the factor in force on its day: two periods of one
// fraction never overlap (`excludeOverlapping` over the fraction, in the
// migration). Zero is a factor; the bounds are `KG_PER_TONNE_MAX`. `source`
// says where the numbers come from, the publication and its year: no factor
// is seeded without one.
import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"
import { sql } from "drizzle-orm"
import { check, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { wasteFraction } from "./catalogue"
import { id, tenant, timestamps, validity, validPeriod } from "./columns"
import { company } from "./organisation"
import { companyReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

export const wasteFractionEmissionFactor = wms.table(
  "waste_fraction_emission_factor",
  {
    ...id,
    ...tenant,
    ...timestamps,
    wasteFractionId: uuid().notNull(),
    /** Kilograms CO₂e a tonne of the fraction emits once treated. */
    footprintKgPerTonne: integer().notNull(),
    /** Kilograms CO₂e a tonne of it avoids, where its treatment displaces anything; null where it displaces nothing. */
    avoidedKgPerTonne: integer(),
    /** Where the numbers come from: the publication and its year. */
    source: text().notNull(),
    ...validity,
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    check(tableObjectName(t.id.table, "footprint_bounds", "wasteFractionEmissionFactor"), sql`${t.footprintKgPerTonne} between 0 and ${sql.raw(String(KG_PER_TONNE_MAX))}`),
    check(tableObjectName(t.id.table, "avoided_bounds", "wasteFractionEmissionFactor"), sql`${t.avoidedKgPerTonne} between 0 and ${sql.raw(String(KG_PER_TONNE_MAX))}`),
    check(tableObjectName(t.id.table, "source_given", "wasteFractionEmissionFactor"), sql`length(btrim(${t.source})) > 0`),
    validPeriod(t),
    tenantIndex(t, t.wasteFractionId),
  ],
)
