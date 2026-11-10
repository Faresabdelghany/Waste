"use client"

// The frame and the list kit every Settings pane draws with: the pane's shell
// (its heading bar, tabs, toolbar, title and ⓘ), the list's count, the empty
// row, and the field and section of a pane's own dialogs. A list's toolbar is
// every list's: RecordToolbar (components/platform/record-toolbar.tsx).

import type { ReactNode } from "react"
import { Info, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { TableCell, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageActions, TableCard } from "@/components/page-layout"
import { NARROWED_HINT, recordCountLabel } from "@/lib/table-copy"
import { useSettingsPaneFrame } from "@/components/settings/settings-pane-frame"

export function Field({
  label,
  note,
  required,
  wide,
  children,
}: {
  label: string
  /** What the value is, or why it cannot change — never how to fill it in. */
  note?: string
  required?: boolean
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn("grid content-start gap-2", wide && "sm:col-span-2")}>
      <Label>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {note && <p className="text-xs leading-5 text-muted-foreground">{note}</p>}
    </div>
  )
}

export function DialogSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-border/70 py-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

/** A Settings pane's list: `TableCard` counting its rows, the list's own actions (New …, Add …) in its header. */
export function RecordsSection({
  shown,
  total,
  actions,
  children,
}: {
  shown: number
  total: number
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <TableCard summary={recordCountLabel(shown, total)} actions={actions}>
      {children}
    </TableCard>
  )
}

/**
 * An empty table's one row. `narrowed` says the table has rows its search or filters hide, the one case
 * `NARROWED_HINT` is shown; a caller's own `hint` stands instead of it, and an empty one shows none.
 */
export function EmptyRow({ colSpan, message, hint, narrowed = false }: { colSpan: number; message: string; hint?: string; narrowed?: boolean }) {
  const shownHint = hint ?? (narrowed ? NARROWED_HINT : undefined)
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-52 text-center">
        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{message}</p>
        {shownHint ? <p className="mt-1 text-xs text-muted-foreground">{shownHint}</p> : null}
      </TableCell>
    </TableRow>
  )
}

export function AssetPanelShell({
  heading: ownHeading,
  header,
  tabs,
  action,
  toolbar,
  title: ownTitle,
  description: ownDescription,
  children,
}: {
  /** The bar above the toolbar, the shown pane's from the Settings table unless given; null leaves it out. */
  heading?: string | null
  /** A record's page: its `RecordPageHeader`, in place of the heading bar (`heading` and `action` then go unused), and no title. */
  header?: ReactNode
  tabs?: ReactNode
  /** The buttons of a pane that has no list (Notifications' Save); a list's actions go in its `RecordsSection`, as a workspace's do. */
  action?: ReactNode
  toolbar?: ReactNode
  /** The table's title and its ⓘ, the shown pane's unless a tab gives its own. */
  title?: string
  description?: string
  children: ReactNode
}) {
  const frame = useSettingsPaneFrame()
  const heading = ownHeading === undefined ? (frame?.heading ?? null) : ownHeading
  const title = ownTitle ?? (header === undefined ? frame?.title : undefined)
  const description = ownDescription ?? (ownTitle === undefined ? frame?.description : undefined)
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        {header ?? ((heading !== null || action) && (
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <p className="text-base font-medium text-foreground">{heading}</p>
            {action && <PageActions>{action}</PageActions>}
          </div>
        ))}
        {(tabs || toolbar) && (
          <div className="flex flex-col gap-3 px-4 py-3">
            {tabs}
            {toolbar}
          </div>
        )}
      </header>
      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          {title !== undefined && (
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="unstyled"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`About ${title}`}
                  >
                    <Info className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {description}
                </TooltipContent>
              </Tooltip>
            </div>
          </section>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
