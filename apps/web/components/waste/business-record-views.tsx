"use client"

import React, { useEffect, useMemo, useState } from "react"
import {
  CheckCircle,
  CircleDashed,
  CircleNotch,
  Clock,
  DotsThree,
  Folder,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Spinner,
  StackSimple,
  Trash,
  XCircle,
} from "@phosphor-icons/react/dist/ssr"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProgressCircle } from "@/components/progress-circle"
import { cn } from "@/lib/utils"

export function statusClasses(status: string): string {
  const normalized = status.toLowerCase()

  // "deactive" must be checked before the "active" substring match below.
  if (
    normalized.includes("inactive") ||
    normalized.includes("deactive") ||
    normalized.includes("deactivated") ||
    normalized.includes("disabled") ||
    normalized.includes("unavailable")
  ) {
    return "border-transparent bg-muted text-muted-foreground"
  }

  if (
    normalized.includes("active") ||
    normalized.includes("ready") ||
    normalized.includes("completed") ||
    normalized.includes("approved") ||
    normalized.includes("healthy") ||
    normalized.includes("certified") ||
    normalized.includes("published") ||
    normalized.includes("open")
  ) {
    return "bg-teal-50 text-teal-700 border-transparent dark:bg-teal-500/15 dark:text-teal-100"
  }

  if (
    normalized.includes("critical") ||
    normalized.includes("failed") ||
    normalized.includes("blocked") ||
    normalized.includes("conflict") ||
    normalized.includes("out of stock") ||
    normalized.includes("expired") ||
    normalized.includes("issue")
  ) {
    return "bg-rose-50 text-rose-700 border-transparent dark:bg-rose-500/15 dark:text-rose-100"
  }

  if (
    normalized.includes("warning") ||
    normalized.includes("pending") ||
    normalized.includes("review") ||
    normalized.includes("delayed") ||
    normalized.includes("stale") ||
    normalized.includes("draft") ||
    normalized.includes("scheduled") ||
    normalized.includes("low") ||
    normalized.includes("expiring") ||
    normalized.includes("partial") ||
    normalized.includes("attention")
  ) {
    return "bg-amber-50 text-amber-700 border-transparent dark:bg-amber-500/15 dark:text-amber-100"
  }

  return "border-transparent bg-muted text-muted-foreground"
}

export function recordProgress(record: BusinessRecord): number | null {
  const percentage = record.value.match(/(\d+)%/)
  if (percentage) return Math.min(100, Number(percentage[1]))
  const fraction = record.value.match(/(\d+)\s*\/\s*(\d+)/)
  if (fraction && Number(fraction[2]) > 0) {
    return Math.min(100, Math.round((Number(fraction[1]) / Number(fraction[2])) * 100))
  }
  if (record.status.toLowerCase().includes("completed")) return 100
  return null
}

function RecordStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusClasses(status),
      )}
    >
      {status}
    </Badge>
  )
}

export function NoMatchingRecords() {
  return (
    <div className="flex h-52 flex-col items-center justify-center gap-2 text-center">
      <MagnifyingGlass className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">No matching records</p>
      <p className="text-xs text-muted-foreground">
        Try a different search or status filter.
      </p>
    </div>
  )
}

export type RecordExtraAction = {
  label: string
  icon?: React.ReactNode
  onSelect: (record: BusinessRecord) => void
}

export function RecordActionsMenu({
  record,
  onEdit,
  onDelete,
  entityLabel,
  className,
  extraActions,
}: {
  record: BusinessRecord
  onEdit?: (record: BusinessRecord) => void
  onDelete?: (record: BusinessRecord) => void
  entityLabel: string
  className?: string
  /** Module-specific record actions rendered above Edit/Delete. */
  extraActions?: RecordExtraAction[]
}) {
  const hasExtraActions = Boolean(extraActions?.length)
  if (!onEdit && !onDelete && !hasExtraActions) return null
  const normalizedEntity = entityLabel.toLowerCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={`Actions for ${record.name}`}
          className={cn("h-7 w-7 rounded-lg text-muted-foreground", className)}
          onClick={(event) => event.stopPropagation()}
        >
          <DotsThree className="h-4 w-4" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onClick={(event) => event.stopPropagation()}
      >
        {extraActions?.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onSelect={() => action.onSelect(record)}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
        {hasExtraActions && (onEdit || onDelete) && <DropdownMenuSeparator />}
        {onEdit && (
          <DropdownMenuItem onSelect={() => onEdit(record)}>
            <PencilSimple className="h-4 w-4" />
            Edit {normalizedEntity}
          </DropdownMenuItem>
        )}
        {onEdit && onDelete && <DropdownMenuSeparator />}
        {onDelete && (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDelete(record)}
          >
            <Trash className="h-4 w-4" />
            Delete {normalizedEntity}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type RecordCardProps = {
  record: BusinessRecord
  entityLabel: string
  onOpen: (record: BusinessRecord) => void
  onEdit?: (record: BusinessRecord) => void
  onDelete?: (record: BusinessRecord) => void
}

function RecordCard({ record, entityLabel, onOpen, onEdit, onDelete }: RecordCardProps) {
  const progress = recordProgress(record)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${record.name}`}
      onClick={() => onOpen(record)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen(record)
        }
      }}
      className="cursor-pointer rounded-2xl border border-border bg-background transition-shadow hover:shadow-lg/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="p-4">
        <div className="flex items-center justify-between">
          <Folder className="h-5 w-5 text-muted-foreground" />
          <div className="flex items-center gap-1">
            <RecordStatusBadge status={record.status} />
            <RecordActionsMenu
              record={record}
              entityLabel={entityLabel}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </div>
        </div>

        <div className="mt-3">
          <p className="text-[15px] font-semibold leading-6 text-foreground">{record.name}</p>
          <p className="mt-1 truncate text-sm text-muted-foreground">{record.context}</p>
        </div>

        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span className="truncate">{record.updated}</span>
        </div>

        <div className="mt-4 border-t border-border/60" />

        <div className="mt-3 flex items-center gap-2">
          {progress !== null && (
            <ProgressCircle progress={progress} color="var(--chart-3)" size={20} />
          )}
          <span className="truncate text-sm text-foreground">{record.value}</span>
        </div>
      </div>
    </div>
  )
}

type BusinessRecordCardsViewProps = {
  records: BusinessRecord[]
  entityLabel: string
  onOpenRecord: (record: BusinessRecord) => void
  onCreateRecord?: () => void
  onEditRecord?: (record: BusinessRecord) => void
  onDeleteRecord?: (record: BusinessRecord) => void
}

export function BusinessRecordCardsView({
  records,
  entityLabel,
  onOpenRecord,
  onCreateRecord,
  onEditRecord,
  onDeleteRecord,
}: BusinessRecordCardsViewProps) {
  if (records.length === 0) return <NoMatchingRecords />

  return (
    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {records.map((record) => (
        <RecordCard
          key={record.id}
          record={record}
          entityLabel={entityLabel}
          onOpen={onOpenRecord}
          onEdit={onEditRecord}
          onDelete={onDeleteRecord}
        />
      ))}
      {onCreateRecord && (
        <button
          type="button"
          className="flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background p-6 text-center text-sm text-muted-foreground transition-colors hover:border-solid hover:border-border/80 hover:text-foreground"
          onClick={onCreateRecord}
        >
          <Plus className="mb-2 h-5 w-5" />
          Create new {entityLabel.toLowerCase()}
        </button>
      )}
    </div>
  )
}

function lifecycleIcon(status: string): React.JSX.Element {
  const normalized = status.toLowerCase()
  const className = "h-4 w-4 text-muted-foreground"
  if (normalized.includes("draft")) return <StackSimple className={className} />
  if (normalized.includes("plan") || normalized.includes("scheduled"))
    return <Spinner className={className} />
  if (normalized.includes("ready")) return <CircleDashed className={className} />
  if (normalized.includes("active") || normalized.includes("progress"))
    return <CircleNotch className={className} />
  if (
    normalized.includes("completed") ||
    normalized.includes("resolved") ||
    normalized.includes("approved") ||
    normalized.includes("closed")
  )
    return <CheckCircle className={className} />
  if (normalized.includes("cancel")) return <XCircle className={className} />
  return <StackSimple className={className} />
}

type BusinessRecordBoardViewProps = {
  records: BusinessRecord[]
  lifecycle: readonly string[]
  entityLabel: string
  onOpenRecord: (record: BusinessRecord) => void
  onCreateRecord?: () => void
  onEditRecord?: (record: BusinessRecord) => void
  onDeleteRecord?: (record: BusinessRecord) => void
}

export function BusinessRecordBoardView({
  records,
  lifecycle,
  entityLabel,
  onOpenRecord,
  onCreateRecord,
  onEditRecord,
  onDeleteRecord,
}: BusinessRecordBoardViewProps) {
  // Column moves are visual only (prototype): state resets when records change.
  const [items, setItems] = useState<BusinessRecord[]>(records)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  useEffect(() => {
    setItems(records)
  }, [records])

  const columns = useMemo(() => {
    const known = new Set(lifecycle.map((status) => status.toLowerCase()))
    const extra = items
      .map((record) => record.status)
      .filter((status) => !known.has(status.toLowerCase()))
    return [...lifecycle, ...Array.from(new Set(extra))]
  }, [items, lifecycle])

  const groups = useMemo(() => {
    const map = new Map<string, BusinessRecord[]>()
    for (const status of columns) map.set(status.toLowerCase(), [])
    for (const record of items) {
      map.get(record.status.toLowerCase())?.push(record)
    }
    return map
  }, [columns, items])

  const onDropTo = (status: string) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const id = event.dataTransfer.getData("text/id")
    if (!id) return
    setDraggingId(null)
    setItems((prev) =>
      prev.map((record) => (record.id === id ? { ...record, status } : record)),
    )
  }

  if (records.length === 0) return <NoMatchingRecords />

  return (
    <div className="flex gap-4 overflow-x-auto p-4">
      {columns.map((status) => (
        <div
          key={status}
          className="w-72 shrink-0 rounded-xl bg-muted"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDropTo(status)}
        >
          <div className="flex items-center justify-between px-3 py-3">
            <div className="flex items-center gap-2">
              {lifecycleIcon(status)}
              <span className="text-sm font-medium">{status}</span>
              <span className="text-xs text-muted-foreground">
                {groups.get(status.toLowerCase())?.length ?? 0}
              </span>
            </div>
            {onCreateRecord && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg"
                type="button"
                onClick={onCreateRecord}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="min-h-[120px] space-y-3 px-3 pb-3">
            {(groups.get(status.toLowerCase()) ?? []).map((record) => {
              const progress = recordProgress(record)
              return (
                <div
                  key={record.id}
                  draggable
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${record.name}`}
                  className={cn(
                    "cursor-pointer rounded-2xl border border-border bg-background p-3 transition-all hover:shadow-lg/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    draggingId === record.id && "scale-[0.98] cursor-grabbing opacity-70",
                  )}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/id", record.id)
                    setDraggingId(record.id)
                  }}
                  onDragEnd={() => setDraggingId(null)}
                  onClick={() => onOpenRecord(record)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onOpenRecord(record)
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{record.name}</p>
                    <RecordActionsMenu
                      record={record}
                      entityLabel={entityLabel}
                      onEdit={onEditRecord}
                      onDelete={onDeleteRecord}
                      className="-mr-1 -mt-1"
                    />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {record.context}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {progress !== null && (
                      <ProgressCircle progress={progress} color="var(--chart-3)" size={18} />
                    )}
                    <span className="truncate text-xs text-foreground">{record.value}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {record.updated}
                  </div>
                </div>
              )
            })}
            {onCreateRecord && (
              <Button variant="ghost" size="sm" type="button" onClick={onCreateRecord}>
                <Plus className="mr-1 h-4 w-4" />
                Add {entityLabel.toLowerCase()}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

type TimeWindow = {
  startMinutes: number
  endMinutes: number
  label: string
}

const TIME_WINDOW_PATTERN = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/

function parseTimeWindow(record: BusinessRecord): TimeWindow | null {
  const candidates = [record.value, ...Object.values(record.facts)]
  for (const candidate of candidates) {
    const match = candidate.match(TIME_WINDOW_PATTERN)
    if (!match) continue
    const startMinutes = Number(match[1]) * 60 + Number(match[2])
    const endMinutes = Number(match[3]) * 60 + Number(match[4])
    if (endMinutes <= startMinutes) continue
    return { startMinutes, endMinutes, label: match[0] }
  }
  return null
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`
}

type BusinessRecordDayTimelineProps = {
  records: BusinessRecord[]
  onOpenRecord: (record: BusinessRecord) => void
}

export function BusinessRecordDayTimeline({
  records,
  onOpenRecord,
}: BusinessRecordDayTimelineProps) {
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: Array<{ record: BusinessRecord; window: TimeWindow }> = []
    const unscheduled: BusinessRecord[] = []
    for (const record of records) {
      const window = parseTimeWindow(record)
      if (window) scheduled.push({ record, window })
      else unscheduled.push(record)
    }
    scheduled.sort((a, b) => a.window.startMinutes - b.window.startMinutes)
    return { scheduled, unscheduled }
  }, [records])

  if (records.length === 0) return <NoMatchingRecords />

  const axisStartHour = scheduled.length
    ? Math.floor(Math.min(...scheduled.map((row) => row.window.startMinutes)) / 60)
    : 6
  const axisEndHour = scheduled.length
    ? Math.ceil(Math.max(...scheduled.map((row) => row.window.endMinutes)) / 60)
    : 18
  const axisStart = axisStartHour * 60
  const axisTotal = Math.max(60, axisEndHour * 60 - axisStart)
  const hours = Array.from(
    { length: axisEndHour - axisStartHour },
    (_, index) => axisStartHour + index,
  )

  return (
    <div className="p-4">
      {scheduled.length > 0 ? (
        <div className="flex">
          <div className="w-44 shrink-0 border-r border-border/60 pr-2">
            <div className="h-8" />
            {scheduled.map(({ record }) => (
              <button
                key={record.id}
                type="button"
                className="flex h-10 w-full items-center rounded-md px-1 text-left hover:bg-muted/60"
                onClick={() => onOpenRecord(record)}
              >
                <span className="truncate text-sm text-foreground">{record.name}</span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0 flex">
              {hours.map((hour) => (
                <div key={hour} className="flex-1 border-l border-border/40 first:border-l-0" />
              ))}
            </div>
            <div className="relative flex h-8 items-center">
              {hours.map((hour) => (
                <div
                  key={hour}
                  className="flex-1 pl-1 text-[10px] text-muted-foreground"
                >
                  {formatHour(hour)}
                </div>
              ))}
            </div>
            {scheduled.map(({ record, window }) => {
              const left = ((window.startMinutes - axisStart) / axisTotal) * 100
              const width = Math.max(
                2,
                ((window.endMinutes - window.startMinutes) / axisTotal) * 100,
              )
              return (
                <div key={record.id} className="relative h-10">
                  <button
                    type="button"
                    aria-label={`Open ${record.name}`}
                    className={cn(
                      "absolute top-1/2 h-6 -translate-y-1/2 cursor-pointer overflow-hidden rounded-full border px-2 text-left text-[11px] font-medium whitespace-nowrap",
                      statusClasses(record.status),
                    )}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    onClick={() => onOpenRecord(record)}
                  >
                    {window.label}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
          No records with a time window match the current filters.
        </div>
      )}

      {unscheduled.length > 0 && (
        <div className={cn(scheduled.length > 0 && "mt-4 border-t border-border/60 pt-4")}>
          <p className="text-xs font-medium text-muted-foreground">No time window</p>
          <div className="mt-2 space-y-1">
            {unscheduled.map((record) => (
              <button
                key={record.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                onClick={() => onOpenRecord(record)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-foreground">{record.name}</span>
                  <RecordStatusBadge status={record.status} />
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{record.value}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
