import type { WorkspaceId } from "@/lib/data/business-modules"

export type BusinessFormMode = "create" | "action" | "disabled"

export type BusinessFormFieldType =
  | "text"
  | "email"
  | "textarea"
  | "number"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "checkbox"

export type BusinessFormOption = {
  value: string
  label: string
}

export type BusinessRelationTarget = {
  workspaceId: WorkspaceId
  moduleId: string
  /**
   * When supplied, only the named record IDs are available to a restricted
   * form. Normal office forms leave this undefined and use the scoped module.
   */
  allowedRecordIds?: readonly string[]
  allowedStatuses?: readonly string[]
}

export type BusinessFieldCondition = {
  fieldId: string
  equals?: BusinessFormValue
  oneOf?: readonly BusinessFormValue[]
  notIn?: readonly BusinessFormValue[]
  hasValue?: boolean
}

export type BusinessFormField = {
  id: string
  label: string
  type: BusinessFormFieldType
  required?: boolean
  readOnly?: boolean
  description?: string
  placeholder?: string
  defaultValue?: string | boolean
  options?: readonly BusinessFormOption[]
  relation?: BusinessRelationTarget
  visibleWhen?: BusinessFieldCondition
  requiredWhen?: BusinessFieldCondition
  min?: number
  max?: number
  unit?: string
}

export type BusinessFormSection = {
  id: string
  title: string
  description?: string
  fields: readonly BusinessFormField[]
}

export type BusinessFormValidationRule =
  | {
      type: "date-order"
      startField: string
      endField: string
      message: string
      allowSame?: boolean
    }
  | {
      type: "different-values"
      firstField: string
      secondField: string
      message: string
    }

export type BusinessFormExecutionKind =
  | "create-record"
  | "append-event"
  | "generate-record"
  | "send-message"
  | "preview"
  | "start-workflow"

export type BusinessFormExecution = {
  kind: BusinessFormExecutionKind
  target?: BusinessRelationTarget
  sourceField?: string
  initialStatus?: string
  resultValue?: string
  reviewBeforeSubmit?: boolean
  completionMessage: string
}

export type BusinessFormSchema = {
  key: `${WorkspaceId}.${string}`
  mode: BusinessFormMode
  recordKind: string
  title: string
  description: string
  submitLabel: string
  /**
   * Disabled modules explain which upstream workflow owns creation instead of
   * presenting a misleading generic form.
   */
  disabledReason?: string
  nameField?: string
  contextFieldIds?: readonly string[]
  ownerField?: string
  execution?: BusinessFormExecution
  validationRules?: readonly BusinessFormValidationRule[]
  sections: readonly BusinessFormSection[]
}

export type BusinessFormValue = string | boolean

export type BusinessFormValues = Record<string, BusinessFormValue>
