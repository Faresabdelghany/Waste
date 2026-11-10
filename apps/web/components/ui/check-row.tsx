"use client"

import type { ReactNode } from "react"

import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export function CheckRow({
  checked,
  title,
  titleSuffix,
  meta,
  className,
  subtitle,
  onClick,
}: {
  checked: boolean
  title: string
  titleSuffix?: ReactNode
  meta?: ReactNode
  className?: string
  subtitle?: ReactNode
  onClick?: () => void
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault()
          onClick()
        }
      }}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted/60",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      <Checkbox
        checked={checked}
        aria-label={title}
        className="rounded-full border-border bg-background data-[state=checked]:border-success data-[state=checked]:bg-success hover:cursor-pointer"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex-1 truncate text-left max-w-[60vw] sm:max-w-none",
              checked && "line-through text-muted-foreground",
            )}
          >
            {title}
          </span>
          {titleSuffix}
        </div>
        {subtitle && (
          <div
            className={cn(
              "mt-0.5 text-xs text-muted-foreground truncate",
              checked && "line-through opacity-70",
            )}
          >
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs shrink-0 ml-2">
        {meta}
      </div>
    </div>
  )
}
