/**
 * The generic derivation every form-backed business record shares: facts
 * keyed by field label that show an option's label or a linked record's name
 * (never the raw id), typed relation refs for relation fields, the context
 * line joined from the schema's context fields, and the record name from the
 * schema's name field.
 *
 * BusinessWorkspace's generic create/edit path and the Settings panes that
 * write business records (lib/data/planning-areas.ts) call this instead of
 * re-deriving it, so a record reads the same wherever it was created. Callers
 * supply resolvers for what only they know — how to name a linked record, the
 * live option labels, where a relation target actually lives.
 */

import { splitList } from "@waste/domain/record-values"

import type {
  BusinessFormField,
  BusinessFormSchema,
  BusinessFormValue,
  BusinessFormValues,
  BusinessRelationTarget,
} from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"

export type FormRecordResolvers = {
  /** Display name of a linked record — facts and relation labels show it instead of the id. */
  relationRecordName?: (
    field: BusinessFormField,
    recordId: string,
  ) => string | undefined
  /**
   * Label of a select value that is not resolved as a linked record. Defaults
   * to the field's static options; a workspace passes its live, scoped
   * relation options here.
   */
  optionLabel?: (field: BusinessFormField, value: string) => string | undefined
  /**
   * Where a relation target actually lives when a workspace hosts the module
   * under a fallback. Defaults to the declared target.
   */
  resolveRelationTarget?: (
    relation: BusinessRelationTarget,
  ) => ModuleLocation | undefined
}

export type FormRecordDerivation = {
  facts: Record<string, string>
  relationRefs: NonNullable<BusinessRecord["relationRefs"]>
  /** Display values of the schema's context fields, in order, blanks dropped. */
  contextValues: string[]
  /** Display value of the schema's name field; "" when the form has none. */
  nameValue: string
}

/**
 * A multiselect stores its picks as one comma-separated string, read through
 * the domain list reader so a comma inside a number ("Igloo · 2,500 L") is
 * not a separator here either (issue #43).
 */
export function splitMultiValue(value: string): string[] {
  return splitList(value)
}

/** What a submitted value reads as in facts and context. */
export function displayFormValue(
  field: BusinessFormField,
  value: BusinessFormValue,
  resolvers: FormRecordResolvers = {},
): string {
  if (typeof value === "boolean") return value ? "Yes" : "No"
  const label = (item: string) =>
    resolvers.relationRecordName?.(field, item) ??
    resolvers.optionLabel?.(field, item) ??
    field.options?.find((option) => option.value === item)?.label ??
    item
  return field.type === "multiselect"
    ? splitMultiValue(value).map(label).join(" · ")
    : label(value)
}

const shownValue = (value: BusinessFormValue | undefined) =>
  typeof value === "string" && value.trim().length > 0

/**
 * The facts a deliberate clearing removes on edit (issue #22). deriveFormRecord
 * writes no fact for an empty value and the edit path merges the derived facts
 * over the record's, so a field a person emptied would otherwise keep its old
 * fact — a condition, an Effective to or a scheduled change could never be
 * cancelled through Edit. A fact is cleared only when the form opened the
 * field with a value (`initial`, the seed the dialog showed) and received it
 * back empty; a field that is not on this form, one hidden by a condition
 * (the dialog submits visible fields only, so it is absent from `values`) and
 * one the seed could not prefill are not clearings, so "not on this form"
 * never becomes a delete. A checkbox is never cleared: false is a value.
 */
export function clearedFactKeys(
  schema: BusinessFormSchema,
  values: BusinessFormValues,
  initial: BusinessFormValues,
): string[] {
  return schema.sections
    .flatMap((section) => section.fields)
    .filter(
      (field) =>
        field.id in values &&
        shownValue(initial[field.id]) &&
        !shownValue(values[field.id]),
    )
    .map((field) => field.label)
}

export function deriveFormRecord(
  schema: BusinessFormSchema,
  values: BusinessFormValues,
  resolvers: FormRecordResolvers = {},
): FormRecordDerivation {
  const fields = schema.sections.flatMap((section) => section.fields)
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const facts: Record<string, string> = {}
  const relationRefs: FormRecordDerivation["relationRefs"] = []

  for (const field of fields) {
    const value = values[field.id]
    if (value === undefined || value === "") continue
    facts[field.label] = displayFormValue(field, value, resolvers)

    if (field.relation && typeof value === "string") {
      const target = resolvers.resolveRelationTarget?.(field.relation) ?? field.relation
      const recordIds = field.type === "multiselect" ? splitMultiValue(value) : [value]
      for (const recordId of recordIds) {
        relationRefs.push({
          fieldId: field.id,
          workspaceId: target.workspaceId,
          moduleId: target.moduleId,
          recordId,
          label:
            resolvers.relationRecordName?.(field, recordId) ??
            resolvers.optionLabel?.(field, recordId) ??
            recordId,
        })
      }
    }
  }

  const contextValues = (schema.contextFieldIds ?? [])
    .map((fieldId) => {
      const field = fieldById.get(fieldId)
      const value = values[fieldId]
      if (!field || value === undefined || value === "") return ""
      return displayFormValue(field, value, resolvers)
    })
    .filter(Boolean)

  const nameField = schema.nameField ? fieldById.get(schema.nameField) : undefined
  const nameValue =
    nameField && values[nameField.id] !== undefined
      ? displayFormValue(nameField, values[nameField.id], resolvers)
      : ""

  return { facts, relationRefs, contextValues, nameValue }
}
