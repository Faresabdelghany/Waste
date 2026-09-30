// What the command surfaces' pickers offer for place-bound rows (Issue #184):
// the pure half of `useRelationPickers` (components/waste/commands/
// use-command-support.ts) for the fields slice 9b adds. A picker hides no row
// by status — a status gates a new reference and never an existing one, and
// the API's 409 says why one is refused (#79) — so a row not Active shows its
// status beside its name. A subscription is named with the place it is
// delivered at, since a container put into service under it serves there.
import { splitList } from "@waste/domain/record-values"

import { isSubscriptionRecord } from "./agreements"
import type { BusinessFormField, BusinessFormOption, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import { NO_ONE } from "./properties"

/** A row as a picker offers it: its name, and its status beside it where it is not Active. */
const optionOf = (record: BusinessRecord, label = record.name): BusinessFormOption => ({ value: record.id, label: record.status === "Active" ? label : `${label} · ${record.status}` })

/** Every row, named, its status beside it where it is not Active. */
export const rowOptions = (records: readonly BusinessRecord[]): BusinessFormOption[] => records.map((record) => optionOf(record))

/** The rows of a single optional pick, None first: a select cannot be emptied, so taking a pick back is picking None (`NO_ONE`). */
export const optionalRowOptions = (records: readonly BusinessRecord[]): BusinessFormOption[] => [{ value: NO_ONE, label: "None" }, ...rowOptions(records)]

/**
 * The value a picker keeps offered although no row holds it: the one the
 * dialog opened with — a create opens with nothing (`{}`), an edit with the
 * row's values — so a pick made since and no longer offered, a member ticked
 * before the project changed, is flagged by the dialog and never kept. A
 * dialog that says nothing of its opening keeps what it holds, as before.
 */
export const keptValue = (fieldId: string, values: BusinessFormValues, opened: BusinessFormValues | undefined): BusinessFormValues[string] | undefined =>
  opened === undefined ? values[fieldId] : opened[fieldId]

/** The agreements module's subscriptions of the project (every one where the form names none), each named with its place. */
export function subscriptionOptions(records: readonly BusinessRecord[], projectId: string | undefined): BusinessFormOption[] {
  return records
    .filter(isSubscriptionRecord)
    .filter((record) => projectId === undefined || record.projectIds === undefined || record.projectIds.length === 0 || record.projectIds.includes(projectId))
    .map((record) => {
      const place = record.facts.Property ?? record.facts["Shared collection point"]
      return optionOf(record, place === undefined ? record.name : `${record.name} · ${place}`)
    })
}

/**
 * The options with the value a form opens with kept among them — as its id
 * chip where no offered row holds it, each pick of a multiselect on its own —
 * so an existing reference is never refused as no longer permitted.
 */
export function keptOptions(field: Pick<BusinessFormField, "type">, offered: readonly BusinessFormOption[], current: unknown): readonly BusinessFormOption[] {
  if (typeof current !== "string" || current.trim() === "") return offered
  const values = field.type === "multiselect" ? splitList(current) : [current]
  const missing = values.filter((value) => !offered.some((option) => option.value === value))
  return missing.length === 0 ? offered : [...offered, ...missing.map((value) => ({ value, label: value }))]
}
