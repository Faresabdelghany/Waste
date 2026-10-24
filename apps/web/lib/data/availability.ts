// The forms a driver's absence and a vehicle's unavailability are recorded
// with on the Pilot (O6 of #290), from the row's details in Fleet: the first
// day away, the last (blank while the return is not known), why, and a note.
// The reasons are the domain's tokens (@waste/domain/resources/vocabulary),
// offered under their labels; lib/api/records/availability.ts maps the values
// to the wire.
import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"

import { statusLabel } from "@/lib/api/records/adapter"
import { LAST_DAY_ON_OR_AFTER } from "@/lib/api/records/availability"

import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValidationRule } from "./business-form-types"

const reasonOptions = (tokens: readonly string[]): BusinessFormOption[] => tokens.map((token) => ({ value: token, label: statusLabel(token) }))

/** The dialog's own check, in the words the action's refusal uses. */
const LAST_DAY_ORDER: BusinessFormValidationRule = { type: "date-order", startField: "validFrom", endField: "lastDay", message: LAST_DAY_ON_OR_AFTER, allowSame: true }

const periodFields = (reasons: readonly string[]): readonly BusinessFormField[] => [
  { id: "validFrom", label: "First day away", type: "date", required: true },
  { id: "lastDay", label: "Last day away", type: "date", description: "Blank while the return is not known." },
  { id: "reason", label: "Reason", type: "select", required: true, options: reasonOptions(reasons) },
  { id: "note", label: "Note", type: "textarea" },
]

/** Record absence, from a driver's details. */
export const ABSENCE_FORM: BusinessFormSchema = {
  key: "fleet.drivers",
  mode: "action",
  recordKind: "Driver absence",
  title: "Record absence",
  description: "The days the driver is away. A route, an allocation or a collection group naming them on one of those days is refused, and generation writes their routes without them; what is planned already stands.",
  submitLabel: "Record absence",
  validationRules: [LAST_DAY_ORDER],
  sections: [{ id: "absence", title: "Absence", fields: periodFields(DRIVER_ABSENCE_REASONS) }],
  execution: { kind: "append-event", completionMessage: "The absence was recorded." },
}

/** Record out of use, from a vehicle's or a trailer's details. */
export const UNAVAILABILITY_FORM: BusinessFormSchema = {
  key: "fleet.vehicles",
  mode: "action",
  recordKind: "Vehicle unavailability",
  title: "Record out of use",
  description: "The days the vehicle is out of use. A route, an allocation or a collection group naming it on one of those days is refused, and generation writes its routes without it; what is planned already stands.",
  submitLabel: "Record out of use",
  validationRules: [LAST_DAY_ORDER],
  sections: [{ id: "unavailability", title: "Out of use", fields: periodFields(VEHICLE_UNAVAILABILITY_REASONS) }],
  execution: { kind: "append-event", completionMessage: "The period was recorded." },
}
