"use client"

import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr"

import { Input } from "@/components/ui/input"

/** The record toolbar's search field — one markup for every table that searches records. */
export function RecordSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="relative min-w-[220px] max-w-sm flex-1">
      <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 pl-9 text-sm"
      />
    </div>
  )
}
