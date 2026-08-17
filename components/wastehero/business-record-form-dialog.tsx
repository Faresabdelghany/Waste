"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr"
import { ChevronDown } from "lucide-react"

import type {
  BusinessFieldCondition,
  BusinessFormField,
  BusinessFormOption,
  BusinessFormSchema,
  BusinessFormValue,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

type ReviewItem = {
  label: string
  value: string
}

const emptyInitialValues: BusinessFormValues = {}

type BusinessRecordFormDialogProps = {
  schema: BusinessFormSchema
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: BusinessFormValues) => void
  relationOptions: (
    field: BusinessFormField,
    values: BusinessFormValues,
  ) => readonly BusinessFormOption[]
  initialValueOverrides?: BusinessFormValues
  validateValues?: (values: BusinessFormValues) => Record<string, string>
  reviewSummary?: (values: BusinessFormValues) => readonly ReviewItem[]
}

function initialValues(
  schema: BusinessFormSchema,
  overrides: BusinessFormValues,
): BusinessFormValues {
  const defaults = Object.fromEntries(
    schema.sections.flatMap((section) =>
      section.fields.map((field) => [
        field.id,
        field.defaultValue ?? (field.type === "checkbox" ? false : ""),
      ]),
    ),
  )
  const fieldIds = new Set(
    schema.sections.flatMap((section) =>
      section.fields.map((field) => field.id),
    ),
  )
  const permittedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([fieldId]) => fieldIds.has(fieldId)),
  )
  return { ...defaults, ...permittedOverrides }
}

function hasValue(value: BusinessFormValue | undefined) {
  return value === true || (typeof value === "string" && value.trim().length > 0)
}

function splitMultiValue(value: BusinessFormValue | undefined): string[] {
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function conditionMatches(
  condition: BusinessFieldCondition | undefined,
  values: BusinessFormValues,
) {
  if (!condition) return true
  const value = values[condition.fieldId]

  if (condition.hasValue !== undefined) {
    if (hasValue(value) !== condition.hasValue) return false
  }
  if (condition.equals !== undefined && value !== condition.equals) return false
  if (condition.oneOf && !condition.oneOf.includes(value)) return false
  if (condition.notIn?.includes(value)) return false

  return true
}

function isFieldVisible(field: BusinessFormField, values: BusinessFormValues) {
  return conditionMatches(field.visibleWhen, values)
}

function isFieldRequired(field: BusinessFormField, values: BusinessFormValues) {
  return (
    Boolean(field.required) ||
    Boolean(field.requiredWhen && conditionMatches(field.requiredWhen, values))
  )
}

function displayValue(
  field: BusinessFormField,
  value: BusinessFormValue | undefined,
  options: readonly BusinessFormOption[],
) {
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (!value) return "Not provided"
  if (field.type === "multiselect") {
    return splitMultiValue(value)
      .map(
        (item) =>
          options.find((option) => option.value === item)?.label ?? item,
      )
      .join(", ")
  }
  return options.find((option) => option.value === value)?.label ?? value
}

function MultiSelectField({
  field,
  options,
  value,
  error,
  onChange,
}: {
  field: BusinessFormField
  options: readonly BusinessFormOption[]
  value: BusinessFormValue | undefined
  error?: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = splitMultiValue(value)

  const toggle = (optionValue: string) => {
    const next = selected.includes(optionValue)
      ? selected.filter((item) => item !== optionValue)
      : [...selected, optionValue]
    onChange(next.join(", "))
  }

  const summary = selected
    .map(
      (item) => options.find((option) => option.value === item)?.label ?? item,
    )
    .join(", ")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          id={`business-form-${field.id}`}
          aria-invalid={Boolean(error)}
          disabled={field.readOnly}
          className="h-9 w-full justify-between px-3 font-normal hover:bg-transparent"
        >
          <span
            className={cn(
              "truncate",
              selected.length === 0 && "text-muted-foreground",
            )}
          >
            {selected.length > 0
              ? summary
              : options.length > 0
                ? field.placeholder ?? `Select ${field.label.toLowerCase()}`
                : "No permitted options"}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder={`Search ${field.label.toLowerCase()}`} />
          <CommandList>
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => toggle(option.value)}
                >
                  <Checkbox
                    checked={selected.includes(option.value)}
                    className="pointer-events-none"
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function completionLabel(schema: BusinessFormSchema) {
  if (schema.execution?.kind === "start-workflow") return "Start workflow"
  if (schema.execution?.kind === "generate-record") return "Confirm generation"
  if (schema.execution?.kind === "send-message") return "Confirm and send"
  if (schema.execution?.kind === "preview") return "Open preview"
  if (schema.execution?.kind === "append-event") return "Confirm action"
  return schema.submitLabel
}

export function BusinessRecordFormDialog({
  schema,
  open,
  onOpenChange,
  onSubmit,
  relationOptions,
  initialValueOverrides = emptyInitialValues,
  validateValues,
  reviewSummary,
}: BusinessRecordFormDialogProps) {
  const [values, setValues] = useState<BusinessFormValues>(() =>
    initialValues(schema, initialValueOverrides),
  )
  const [attempted, setAttempted] = useState(false)
  const [step, setStep] = useState<"form" | "review">("form")
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const showInstructions = schema.mode !== "create"

  useEffect(() => {
    if (!open) return
    setValues(initialValues(schema, initialValueOverrides))
    setAttempted(false)
    setStep("form")
    setReviewConfirmed(false)
  }, [initialValueOverrides, open, schema])

  const fields = useMemo(
    () => schema.sections.flatMap((section) => section.fields),
    [schema],
  )
  const visibleFields = fields.filter((field) => isFieldVisible(field, values))
  const visibleFieldIds = new Set(visibleFields.map((field) => field.id))
  const submittedValues = Object.fromEntries(
    Object.entries(values).filter(([fieldId]) => visibleFieldIds.has(fieldId)),
  )

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {}

    for (const field of visibleFields) {
      const value = values[field.id]
      const options = field.relation
        ? relationOptions(field, values)
        : field.options ?? []

      if (isFieldRequired(field, values) && !hasValue(value)) {
        errors[field.id] =
          field.relation && options.length === 0
            ? "No permitted records are available in the selected scope."
            : `${field.label} is required.`
        continue
      }

      if (!hasValue(value)) continue

      if (field.type === "email" && typeof value === "string") {
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!emailPattern.test(value)) {
          errors[field.id] = "Enter a valid email address."
        }
      }

      if (field.type === "number" && typeof value === "string") {
        const numberValue = Number(value)
        if (!Number.isFinite(numberValue)) {
          errors[field.id] = "Enter a valid number."
        } else if (field.min !== undefined && numberValue < field.min) {
          errors[field.id] = `Value must be at least ${field.min}.`
        } else if (field.max !== undefined && numberValue > field.max) {
          errors[field.id] = `Value must be no more than ${field.max}.`
        }
      }

      if (
        field.type === "select" &&
        typeof value === "string" &&
        options.length > 0 &&
        !options.some((option) => option.value === value)
      ) {
        errors[field.id] = "The selected record is no longer permitted."
      }

      if (
        field.type === "multiselect" &&
        options.length > 0 &&
        splitMultiValue(value).some(
          (item) => !options.some((option) => option.value === item),
        )
      ) {
        errors[field.id] = "A selected record is no longer permitted."
      }
    }

    for (const rule of schema.validationRules ?? []) {
      if (rule.type === "date-order") {
        const start = values[rule.startField]
        const end = values[rule.endField]
        if (
          typeof start === "string" &&
          typeof end === "string" &&
          start &&
          end &&
          (rule.allowSame
            ? new Date(end).getTime() < new Date(start).getTime()
            : new Date(end).getTime() <= new Date(start).getTime())
        ) {
          errors[rule.endField] = rule.message
        }
      }

      if (rule.type === "different-values") {
        const first = values[rule.firstField]
        const second = values[rule.secondField]
        if (hasValue(first) && first === second) {
          errors[rule.secondField] = rule.message
        }
      }
    }

    return {
      ...errors,
      ...(validateValues?.(submittedValues) ?? {}),
    }
  }, [
    relationOptions,
    schema.validationRules,
    submittedValues,
    validateValues,
    values,
    visibleFields,
  ])

  if (schema.mode === "disabled" || !schema.execution) return null

  const updateValue = (fieldId: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [fieldId]: value }))
  }

  const advance = () => {
    setAttempted(true)
    if (Object.keys(fieldErrors).length > 0) return
    if (schema.execution?.reviewBeforeSubmit) {
      setStep("review")
      setAttempted(false)
      return
    }
    onSubmit(submittedValues)
  }

  const confirm = () => {
    if (!reviewConfirmed) return
    onSubmit(submittedValues)
  }

  const reviewItems = step === "review"
    ? schema.sections.flatMap((section) =>
        section.fields
          .filter((field) => visibleFieldIds.has(field.id))
          .filter((field) => hasValue(values[field.id]))
          .map((field) => ({
            label: field.label,
            value: displayValue(
              field,
              values[field.id],
              field.relation
                ? relationOptions(field, values)
                : field.options ?? [],
            ),
          })),
      )
    : []
  const calculatedReviewItems =
    step === "review" ? reviewSummary?.(submittedValues) ?? [] : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        {...(!showInstructions ? { "aria-describedby": undefined } : {})}
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>
            {step === "review" ? `Review ${schema.recordKind.toLowerCase()}` : schema.title}
          </DialogTitle>
          {showInstructions && (step === "review" || schema.description) && (
            <DialogDescription>
              {step === "review"
                ? "Confirm the resolved scope, linked records, and calculated outcome before applying this action."
                : schema.description}
            </DialogDescription>
          )}
        </DialogHeader>

        {step === "form" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6">
            {schema.sections.map((section, sectionIndex) => {
              const visibleSectionFields = section.fields.filter((field) =>
                isFieldVisible(field, values),
              )
              if (visibleSectionFields.length === 0) return null

              return (
                <section
                  key={section.id}
                  className={cn(
                    "py-5",
                    sectionIndex > 0 && "border-t border-border/70",
                  )}
                >
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold">{section.title}</h3>
                    {showInstructions && section.description && (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {section.description}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
                    {visibleSectionFields.map((field) => {
                      const options = field.relation
                        ? relationOptions(field, values)
                        : field.options ?? []
                      const value = values[field.id]
                      const isWide =
                        field.type === "textarea" || field.type === "checkbox"
                      const required = isFieldRequired(field, values)
                      const error = attempted ? fieldErrors[field.id] : undefined

                      if (field.type === "checkbox") {
                        return (
                          <div
                            key={field.id}
                            className={cn(
                              "flex items-start gap-3",
                              isWide && "sm:col-span-2",
                            )}
                          >
                            <Checkbox
                              id={`business-form-${field.id}`}
                              checked={value === true}
                              disabled={field.readOnly}
                              aria-invalid={Boolean(error)}
                              onCheckedChange={(checked) =>
                                updateValue(field.id, checked === true)
                              }
                            />
                            <div className="grid gap-1">
                              <Label
                                htmlFor={`business-form-${field.id}`}
                                className="leading-5"
                              >
                                {field.label}
                                {required && (
                                  <span className="ml-1 text-destructive">*</span>
                                )}
                              </Label>
                              {showInstructions && field.description && (
                                <p className="text-xs leading-5 text-muted-foreground">
                                  {field.description}
                                </p>
                              )}
                              {error && (
                                <p className="text-xs text-destructive">{error}</p>
                              )}
                            </div>
                          </div>
                        )
                      }

                      return (
                        <div
                          key={field.id}
                          className={cn(
                            "grid content-start gap-2",
                            isWide && "sm:col-span-2",
                          )}
                        >
                          <Label htmlFor={`business-form-${field.id}`}>
                            {field.label}
                            {required && (
                              <span className="ml-1 text-destructive">*</span>
                            )}
                          </Label>

                          {field.type === "select" ? (
                            <Select
                              value={typeof value === "string" ? value : ""}
                              disabled={field.readOnly}
                              onValueChange={(nextValue) =>
                                updateValue(field.id, nextValue)
                              }
                            >
                              <SelectTrigger
                                id={`business-form-${field.id}`}
                                aria-invalid={Boolean(error)}
                              >
                                <SelectValue
                                  placeholder={
                                    options.length > 0
                                      ? field.placeholder ??
                                        `Select ${field.label.toLowerCase()}`
                                      : "No permitted options"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {options.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : field.type === "multiselect" ? (
                            <MultiSelectField
                              field={field}
                              options={options}
                              value={value}
                              error={error}
                              onChange={(nextValue) =>
                                updateValue(field.id, nextValue)
                              }
                            />
                          ) : field.type === "textarea" ? (
                            <Textarea
                              id={`business-form-${field.id}`}
                              value={typeof value === "string" ? value : ""}
                              readOnly={field.readOnly}
                              onChange={(event) =>
                                updateValue(field.id, event.target.value)
                              }
                              placeholder={field.placeholder}
                              aria-invalid={Boolean(error)}
                              className="min-h-24 resize-none"
                            />
                          ) : (
                            <div className="relative">
                              <Input
                                id={`business-form-${field.id}`}
                                type={
                                  field.type === "datetime"
                                    ? "datetime-local"
                                    : field.type
                                }
                                value={typeof value === "string" ? value : ""}
                                readOnly={field.readOnly}
                                onChange={(event) =>
                                  updateValue(field.id, event.target.value)
                                }
                                placeholder={field.placeholder}
                                min={field.min}
                                max={field.max}
                                aria-invalid={Boolean(error)}
                                className={field.unit ? "pr-14" : undefined}
                              />
                              {field.unit && (
                                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                                  {field.unit}
                                </span>
                              )}
                            </div>
                          )}

                          {showInstructions && field.description && (
                            <p className="text-xs leading-5 text-muted-foreground">
                              {field.description}
                            </p>
                          )}
                          {error && (
                            <p className="text-xs text-destructive">{error}</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}

          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {calculatedReviewItems.length > 0 && (
              <section className="mb-6">
                <h3 className="text-sm font-semibold">Calculated outcome</h3>
                <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
                  {calculatedReviewItems.map((item) => (
                    <div
                      key={item.label}
                      className="flex items-start justify-between gap-6 py-3 text-sm"
                    >
                      <span className="text-muted-foreground">{item.label}</span>
                      <span className="text-right font-medium">{item.value}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="text-sm font-semibold">Submitted business context</h3>
              <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
                {reviewItems.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-start justify-between gap-6 py-3 text-sm"
                  >
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="max-w-[60%] text-right font-medium">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <div className="mt-5 flex items-start gap-3 border-t border-border/70 pt-5">
              <Checkbox
                id="business-form-review-confirmation"
                checked={reviewConfirmed}
                onCheckedChange={(checked) =>
                  setReviewConfirmed(checked === true)
                }
              />
              <Label
                htmlFor="business-form-review-confirmation"
                className="leading-5"
              >
                I reviewed the scope, linked records, and outcome. Apply this
                controlled action and retain the audit evidence.
              </Label>
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {step === "review" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("form")
                  setReviewConfirmed(false)
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={confirm} disabled={!reviewConfirmed}>
                <CheckCircle className="h-4 w-4" />
                {completionLabel(schema)}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={advance}>
                {schema.submitLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
