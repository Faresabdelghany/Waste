"use client"

// Shared field primitives for the guided setup: a labelled field wrapper and
// a plain-option Select, plus the pill styling the day and container-type
// toggle groups share. Only shadcn/ui components underneath.

import type { ReactNode } from "react"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type SelectOption = { value: string; label: string }

export function Field({
  id,
  label,
  children,
  className,
}: {
  id: string
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      {children}
    </div>
  )
}

export function SimpleSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  id: string
  value: string | undefined
  onChange: (value: string) => void
  options: readonly SelectOption[]
  placeholder: string
  disabled?: boolean
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="h-10 w-full rounded-xl">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A selected pill fills with the primary token; unselected pills stay outlined. */
export const PILL_TOGGLE_ITEM_CLASS =
  "rounded-full border-border px-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground"

/** Pill-style Tabs list (the repo's Tabs primitive is underline-style by default). */
export const PILL_TABS_LIST_CLASS = "h-10 gap-0 rounded-xl border-0 bg-muted p-1 text-sm"
export const PILL_TABS_TRIGGER_CLASS =
  "mb-0 h-8 rounded-lg border-0 px-3 text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
