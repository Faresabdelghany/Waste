import type { ReactNode } from "react"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * The bar at the top of every page: the sidebar toggle and the page's title
 * (its breadcrumbs, badges and subtitle) on the left. The right side is kept
 * for the app-wide items — notifications and the account menu — so a page
 * never puts its own buttons here: they go in its content, in `PageActions`.
 */
export function PageTopBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="page-top-bar"
      className={cn("flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2", className)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SidebarTrigger className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-accent" />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

// Every button inside is drawn one step smaller than `size="sm"`, whichever
// component renders it (a module's primary surface brings its own Button).
// A Button is matched by its `data-variant` and `data-size`, not its
// `data-slot`, which a Radix trigger rendered `asChild` replaces with its own.
const COMPACT_BUTTONS = cn(
  "[&_[data-variant][data-size]]:h-7 [&_[data-variant][data-size]]:gap-1 [&_[data-variant][data-size]]:rounded-md [&_[data-variant][data-size]]:px-2.5 [&_[data-variant][data-size]]:text-xs",
  "[&_[data-variant][data-size]_svg]:size-3.5",
  "[&_[data-variant][data-size^=icon]]:w-7 [&_[data-variant][data-size^=icon]]:px-0",
)

/**
 * A page's own actions (New …, Export, Generate …), set in the page's content
 * beside what they act on — a table's header, a toolbar, a details page's tabs
 * — never in `PageTopBar`.
 */
export function PageActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="page-actions" className={cn("flex shrink-0 flex-wrap items-center justify-end gap-1.5", COMPACT_BUTTONS, className)}>
      {children}
    </div>
  )
}
