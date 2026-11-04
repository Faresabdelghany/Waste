// A tank in words (M11 of #293): its kind, its outlet and an inspection's
// outcome as a person reads them, a tank in one line, and the litres a driver
// types. Pure, with no client, so the Driver App says a stop's tank in the
// same words the office's register does (lib/data/tanks.ts).
import type { TankInspectionOutcome, TankKind, TankOutlet } from "@waste/domain/registry/vocabulary"

export const TANK_KIND_LABELS: Readonly<Record<TankKind, string>> = {
  "septic-tank": "Septic tank",
  "holding-tank": "Holding tank",
  "small-treatment-plant": "Small treatment plant",
  "grease-separator": "Grease separator",
}

export const TANK_OUTLET_LABELS: Readonly<Record<TankOutlet, string>> = {
  soakaway: "outlet to a soakaway",
  "sand-filter": "outlet to a sand filter",
  watercourse: "outlet to a watercourse",
  sewer: "outlet to the sewer",
  none: "no outlet",
}

export const TANK_INSPECTION_OUTCOME_LABELS: Readonly<Record<TankInspectionOutcome, string>> = {
  approved: "Approved",
  remarks: "Remarks",
  defects: "Defects to put right",
  failed: "Failed",
}

/** The most months a register takes between emptyings, as the API's check. */
export const TANK_INTERVAL_MONTHS_MAX = 120
/** The most litres the driver may type: a slip of the finger past this, not a load. */
export const LITRES_MAX = 999_999

export const thousands = new Intl.NumberFormat("en-GB")

/** A tank in one line: what it is, what it holds and where it lets its water out. */
export const tankSummary = (tank: { kind: TankKind; volumeLitres: number; outlet: TankOutlet }): string => `${TANK_KIND_LABELS[tank.kind]} · ${thousands.format(tank.volumeLitres)} L · ${TANK_OUTLET_LABELS[tank.outlet]}`

const wholeNumber = (value: string): number | undefined => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined)

/** The litres the driver typed: a whole positive number up to `LITRES_MAX`, or nothing. */
export function litresOf(value: string): number | undefined {
  const litres = wholeNumber(value)
  return litres === undefined || litres < 1 || litres > LITRES_MAX ? undefined : litres
}

