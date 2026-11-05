import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * What a status says, as a colour: the one place a status's colour is chosen.
 * A surface decides which tone a status of its own gets; the tone decides
 * the colour, over the theme's tokens, so it follows dark mode and the themes.
 */
export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "highlight"
  | "primary"

/** The tint and text of each tone, for a surface that is not a badge. */
export const statusToneClasses: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success-foreground",
  warning: "bg-warning/10 text-warning-foreground",
  destructive: "bg-destructive/10 text-destructive-foreground",
  info: "bg-info/10 text-info-foreground",
  highlight: "bg-highlight/10 text-highlight-foreground",
  primary: "bg-primary/10 text-primary",
}

/** The border of each tone, for an outlined badge or surface. */
export const statusToneBorderClasses: Record<StatusTone, string> = {
  neutral: "border-border",
  success: "border-success/25",
  warning: "border-warning/25",
  destructive: "border-destructive/25",
  info: "border-info/25",
  highlight: "border-highlight/25",
  primary: "border-primary/25",
}

/** The solid colour of each tone, for a dot, a bar or an icon. */
export const statusToneDotClasses: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive-foreground",
  info: "bg-info",
  highlight: "bg-highlight",
  primary: "bg-primary",
}

function StatusBadge({
  tone = "neutral",
  dot = false,
  outlined = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant"> & {
  tone?: StatusTone
  /** A leading dot in the tone's solid colour. */
  dot?: boolean
  /** A border in the tone; without it the badge is the tint alone. */
  outlined?: boolean
}) {
  return (
    <Badge
      data-slot="status-badge"
      data-tone={tone}
      variant="outline"
      className={cn(
        statusToneClasses[tone],
        outlined ? statusToneBorderClasses[tone] : "border-transparent",
        dot && "gap-1",
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", statusToneDotClasses[tone])} />
      ) : null}
      {children}
    </Badge>
  )
}

export { StatusBadge }
