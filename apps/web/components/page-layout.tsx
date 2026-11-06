import type { ReactNode } from "react"
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr"

import { NotificationsMenu } from "@/components/top-bar/notifications-menu"
import { TopAccountMenu } from "@/components/top-bar/top-account-menu"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * The bar at the top of every page: the sidebar toggle and the page's title
 * (its breadcrumbs, badges and subtitle) on the left, the app-wide items —
 * the notifications bell and the account menu — on the right. A page never
 * puts its own buttons here: they go in its content, in `PageActions`.
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
      <div className="flex shrink-0 items-center gap-1.5">
        <NotificationsMenu />
        <TopAccountMenu />
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

/**
 * The card every list sits in, a workspace module's and a Settings pane's
 * alike: its header carries the count of its rows on the left and the list's
 * own actions (New …, Add …, Export) on the right, in `PageActions`. A list's
 * actions go here, never in the page's or the pane's header above.
 */
export function TableCard({
  summary,
  actions,
  children,
  testId,
}: {
  summary: ReactNode
  actions?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section data-slot="table-card" className="overflow-hidden rounded-xl border border-border/60" data-testid={testId}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">{summary}</p>
        {actions ? <PageActions>{actions}</PageActions> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * The header of one record's page inside a pane (a company, a ticket type, a
 * holiday list): the way back to its list, the record's name and its line
 * beneath on the left, the record's own actions in `PageActions` on the right.
 */
export function RecordPageHeader({
  backLabel,
  onBack,
  actions,
  children,
}: {
  backLabel: string
  onBack: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div data-slot="record-page-header" className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={backLabel} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">{children}</div>
      </div>
      {actions ? <PageActions>{actions}</PageActions> : null}
    </div>
  )
}
