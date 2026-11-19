import type { BusinessRecord } from "./business-modules"
import type { BusinessFormSchema, BusinessFormValues } from "./business-form-types"

/**
 * The fields of a form whose value names one record of its module: the name
 * field, a barcode, and any code, reference, registration number or external id.
 */
export function uniqueFieldsOf(schema: BusinessFormSchema) {
  return schema.sections
    .flatMap((section) => section.fields)
    .filter(
      (field) =>
        field.id === schema.nameField ||
        field.id === "barcode" ||
        /(code|reference|registrationNumber|externalId)$/i.test(field.id),
    )
}

/**
 * "<Label> already exists in this module." for each unique field another row
 * of the module already holds. `except` are the rows that are not another:
 * the one being edited, and the one this form's own write put in the store,
 * which is there while its request is out (#651).
 */
export function duplicateFieldErrors(
  schema: BusinessFormSchema,
  values: BusinessFormValues,
  records: readonly BusinessRecord[],
  options: { except: readonly (string | null | undefined)[]; skip?: (fieldId: string) => boolean },
): Record<string, string> {
  const except = new Set(options.except.filter((id): id is string => Boolean(id)))
  const errors: Record<string, string> = {}
  for (const field of uniqueFieldsOf(schema)) {
    if (options.skip?.(field.id)) continue
    const value = values[field.id]
    if (typeof value !== "string" || !value.trim()) continue
    const normalized = value.trim().toLowerCase()
    const same = (candidate: unknown) => typeof candidate === "string" && candidate.trim().toLowerCase() === normalized
    const duplicate = records.some(
      (record) =>
        !except.has(record.id) &&
        (same(record.submittedValues?.[field.id]) ||
          same(record.facts[field.label]) ||
          (field.id === schema.nameField && same(record.name))),
    )
    if (duplicate) errors[field.id] = `${field.label} already exists in this module.`
  }
  return errors
}
