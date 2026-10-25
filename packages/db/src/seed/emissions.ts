// The demo company's emission factors and its vehicle types' consumption
// (M10 of #293), what the fleet's routes are measured by.
//
// A factor is seeded as a published number only where a primary source can
// be cited. Diesel is: Energistyrelsen's "Standardfaktorer for brændværdier
// og CO2-emissionsfaktorer til brug for rapporteringsåret 2025" (16 January
// 2026, j.nr. 2025-6296) gives gasolie/dieselolie a lower heating value of
// 35.87 GJ/m³ at 74.10 t CO2/TJ, 2.658 kg CO2 a litre. HVO and biogas, which
// the seeded WH-24 and NR-08 run on, are counted as nothing burnt under the
// same list's rule for biofuel documented as sustainable (its note C); the
// demo has no such documentation, so their zeros say "Demo value" and the
// office replaces them with its own. Electricity's factor is Energinet's,
// not on that list, and is not seeded: an electric vehicle's routes stay
// unmeasured until the office gives one.
//
// A consumption is the operator's own number, in thousandths of the fuel's
// unit per kilometre: demo figures for the fuels the seeded vehicles run on,
// a rear loader on HVO, a glass crane and a paper compactor on diesel, an
// organic truck on biogas. A factor is written on insert alone, the office's
// number once seeded; a type's consumption is a set the API replaces whole,
// so it goes through `replaceSets`, keyed by its content, as a vehicle
// type's container types are.
import type { Tx } from "../client"
import { fuelEmissionFactor, vehicleTypeConsumption } from "../schema/emissions"
import { DEMO_COMPANY_ID, keyed, required } from "./ids"
import { RESOURCES_IDS } from "./resources"
import { replaceSets } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

/** The citation the diesel factor carries. */
export const DIESEL_SOURCE =
  "Energistyrelsen, Standardfaktorer for brændværdier og CO2-emissionsfaktorer til brug for rapporteringsåret 2025 (16-01-2026, j.nr. 2025-6296): gasolie/dieselolie 35.87 GJ/m³ at 74.10 t CO2/TJ, 2.658 kg CO2 a litre"
/** What a demo factor says of itself. */
export const DEMO_SOURCE = "Demo value: counted as nothing burnt, as Energistyrelsen's standard factors allow for biofuel documented as sustainable (note C). Replace it with your documented factor."

/** The factors: a key, the fuel, grams per unit, the source, and the first day in force. */
const FACTORS = [
  { key: "diesel-2025", fuel: "diesel", gramsPerUnit: 2658, source: DIESEL_SOURCE, validFrom: "2025-01-01" },
  { key: "hvo-demo", fuel: "hvo", gramsPerUnit: 0, source: DEMO_SOURCE, validFrom: "2025-01-01" },
  { key: "biogas-demo", fuel: "biogas", gramsPerUnit: 0, source: DEMO_SOURCE, validFrom: "2025-01-01" },
] as const

/** The consumption by vehicle type key and fuel, in thousandths of the fuel's unit per kilometre: demo figures. */
const CONSUMPTION = [
  { type: "rear-loader", fuel: "hvo", milliUnitsPerKm: 450 },
  { type: "glass-crane", fuel: "diesel", milliUnitsPerKm: 380 },
  { type: "organic-sealed", fuel: "biogas", milliUnitsPerKm: 400 },
  { type: "paper-compactor", fuel: "diesel", milliUnitsPerKm: 420 },
] as const

/** The ids the rows are written under: a factor by its key, a consumption by `<type>:<fuel>`. */
export type EmissionsIds = {
  fuelEmissionFactors: Readonly<Record<string, string>>
  vehicleTypeConsumptions: Readonly<Record<string, string>>
}

type EmissionsRows = {
  fuelEmissionFactors: (typeof fuelEmissionFactor.$inferInsert)[]
  vehicleTypeConsumptions: (typeof vehicleTypeConsumption.$inferInsert)[]
}

/** How many rows the emissions hold per table. */
export type EmissionsCounts = { [K in keyof EmissionsRows]: number }

function build(): { ids: EmissionsIds; rows: EmissionsRows } {
  const factorIds = keyed(FACTORS, (factor) => factor.key, "fuelEmissionFactor")
  const consumptionKey = (entry: (typeof CONSUMPTION)[number]) => `${entry.type}:${entry.fuel}`
  const consumptionIds = keyed(CONSUMPTION, consumptionKey, "vehicleTypeConsumption")
  return {
    ids: { fuelEmissionFactors: factorIds, vehicleTypeConsumptions: consumptionIds },
    rows: {
      fuelEmissionFactors: FACTORS.map(({ key, ...factor }) => ({ id: required(factorIds, key, "emission factor"), companyId: COMPANY_ID, ...factor, validTo: null })),
      vehicleTypeConsumptions: CONSUMPTION.map((entry) => ({
        id: required(consumptionIds, consumptionKey(entry), "consumption"),
        companyId: COMPANY_ID,
        vehicleTypeId: required(RESOURCES_IDS.vehicleTypes, entry.type, "vehicle type"),
        fuel: entry.fuel,
        milliUnitsPerKm: entry.milliUnitsPerKm,
      })),
    },
  }
}

const built = build()

/** Every emissions id the seed writes. */
export const EMISSIONS_IDS: EmissionsIds = built.ids

const EMISSIONS_ROWS: Readonly<EmissionsRows> = built.rows

export const EMISSIONS_COUNTS: EmissionsCounts = {
  fuelEmissionFactors: built.rows.fuelEmissionFactors.length,
  vehicleTypeConsumptions: built.rows.vehicleTypeConsumptions.length,
}

/** Writes the factors and the consumption into an open transaction, after Resources whose vehicle types they name, and answers how many rows it changed. */
export async function applyEmissions(tx: Tx): Promise<number> {
  const rows = EMISSIONS_ROWS
  let changed = 0
  // The office's numbers once seeded: nothing is restored on a later run, and a period of the office's own for the fuel, which the exclusion holds apart, keeps the seed's out.
  changed += (await tx.insert(fuelEmissionFactor).values(rows.fuelEmissionFactors).onConflictDoNothing().returning({ id: fuelEmissionFactor.id })).length
  changed += await replaceSets(tx, {
    table: vehicleTypeConsumption,
    of: vehicleTypeConsumption.vehicleTypeId,
    parents: [...new Set(rows.vehicleTypeConsumptions.map((row) => row.vehicleTypeId))],
    rows: rows.vehicleTypeConsumptions,
    compared: [vehicleTypeConsumption.fuel, vehicleTypeConsumption.milliUnitsPerKm],
  })
  return changed
}
