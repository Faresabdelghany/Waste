// The four kinds of operational master data and the one rule that says
// which kind a record is (Issue #176, slice 2 of #81). A leaf on purpose:
// business-links reads it to route a record's link, the adapters own by it,
// the generic workspace filters pickers by it, and none of them may pull the
// pane's forms or the fixture registry in with it.
import type { BusinessRecord } from "./business-modules"

/** The four kinds, as the typed `kind` value spells them. */
export const MASTER_DATA_KINDS = ["waste-fraction", "container-type", "service-frequency", "vehicle-type"] as const
export type MasterDataKind = (typeof MASTER_DATA_KINDS)[number]

/** The typed value a row carries its kind under. */
export const MASTER_DATA_KIND_KEY = "kind"

export type MasterDataKindDetails = {
  /** The web id prefix of a row of the kind: `fraction`, as the seed's ids read. */
  prefix: string
  /** The record kind the registry files a row under. */
  recordKind: string
  /** `Waste fraction`, as a person reads it. */
  label: string
  /** `Waste fractions`, the tab. */
  plural: string
}

export const MASTER_DATA_KIND_DETAILS: Readonly<Record<MasterDataKind, MasterDataKindDetails>> = {
  "waste-fraction": { prefix: "fraction", recordKind: "Waste fraction", label: "Waste fraction", plural: "Waste fractions" },
  "container-type": { prefix: "container-type", recordKind: "Container type", label: "Container type", plural: "Container types" },
  "service-frequency": { prefix: "frequency", recordKind: "Service frequency", label: "Service frequency", plural: "Service frequencies" },
  "vehicle-type": { prefix: "vehicle-type", recordKind: "Vehicle type", label: "Vehicle type", plural: "Vehicle types" },
}

export const isMasterDataKind = (value: unknown): value is MasterDataKind => typeof value === "string" && (MASTER_DATA_KINDS as readonly string[]).includes(value)

/**
 * Which kind a record of the module is: its id's prefix first, then the
 * typed kind it carries; null for a record of neither — the fixtures'
 * master-data sets. The adapters' ownership, the pickers' filter and the
 * record links are all this.
 */
export function masterDataKindOf(record: Pick<BusinessRecord, "id"> & Partial<Pick<BusinessRecord, "submittedValues">>): MasterDataKind | null {
  for (const kind of MASTER_DATA_KINDS) {
    if (record.id.startsWith(`${MASTER_DATA_KIND_DETAILS[kind].prefix}-`)) return kind
  }
  const typed = record.submittedValues?.[MASTER_DATA_KIND_KEY]
  return isMasterDataKind(typed) ? typed : null
}

/**
 * The kind a picker's field asks the module for, by the field's name — the
 * fixture forms spell it (`materialFraction`, `plannedFraction`,
 * `acceptedFractionId`, `vehicleType`, `containerTypeIds`); null for a field
 * that names no kind, which has no list on the API yet.
 */
export function masterDataKindForField(fieldId: string): MasterDataKind | null {
  if (/fraction/i.test(fieldId)) return "waste-fraction"
  if (/vehicle.?type/i.test(fieldId)) return "vehicle-type"
  if (/container.?type/i.test(fieldId)) return "container-type"
  if (/frequenc/i.test(fieldId)) return "service-frequency"
  return null
}
