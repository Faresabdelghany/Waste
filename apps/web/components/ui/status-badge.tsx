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
  | "primary"

/** The tint, border and text of each tone, for a surface that is not a badge. */
export const statusToneClasses: Record<StatusTone, string> = {
  neutral: "border-transparent bg-muted text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success-foreground",
  warning: "border-warning/25 bg-warning/10 text-warning-foreground",
  destructive: "border-destructive/25 bg-destructive/10 text-destructive-foreground",
  info: "border-info/25 bg-info/10 text-info-foreground",
  primary: "border-primary/25 bg-primary/10 text-primary",
}

/** The solid colour of each tone, for a dot, a bar or an icon. */
export const statusToneDotClasses: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive-foreground",
  info: "bg-info",
  primary: "bg-primary",
}

function StatusBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant"> & {
  tone?: StatusTone
  /** A leading dot in the tone's solid colour. */
  dot?: boolean
}) {
  return (
    <Badge
      data-slot="status-badge"
      data-tone={tone}
      variant="outline"
      className={cn(statusToneClasses[tone], dot && "gap-1", className)}
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
