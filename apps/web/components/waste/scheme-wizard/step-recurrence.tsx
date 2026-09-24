"use client"

// Step 2 — When does this scheme collect? Effective window, cadence, start
// time, service days, the holiday policy beside the project's read-only
// calendar (holiday list · working week), and the live next-dates table.

import { useState } from "react"
import Link from "next/link"
import { CalendarDays } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { holidaySettingsHref } from "@/lib/data/business-links"
import { projectCalendarLabel } from "@waste/domain/route-schemes/project-calendar"
import {
  formatClockTime,
  formatOccurrenceDate,
  shiftedNote,
  type Occurrence,
} from "@waste/domain/route-schemes/occurrences"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import {
  SERVICE_DAYS,
  SERVICE_DAY_LABELS,
  SERVICE_DAY_SHORT_LABELS,
  serviceDayOf,
  sortServiceDays,
  type ServiceDay,
} from "@waste/domain/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import type { WizardModel } from "./wizard-model"
import {
  HOLIDAY_POLICY_OPTIONS,
  WIZARD_FREQUENCIES,
  applyWizardFrequency,
  fortnightRotation,
  wizardFrequencyValue,
} from "./wizard-options"
import { Field, PILL_TOGGLE_ITEM_CLASS, SimpleSelect } from "./wizard-fields"

const PREVIEW_ROWS = 8
const PREVIEW_ROWS_EXPANDED = 60

function StatusBadge({ row }: { row: Occurrence }) {
  if (row.status === "planned") return <Badge variant="secondary">Planned</Badge>
  if (row.status === "shifted") {
    return (
      <Badge variant="secondary" className="bg-amber-50 text-amber-800">
        Shifted {shiftedNote(row)}
      </Badge>
    )
  }
  if (row.status === "skipped") {
    return <Badge variant="muted">Skipped · {row.note}</Badge>
  }
  return (
    <Badge variant="secondary" className="bg-amber-50 text-amber-800">
      Holiday · {row.note}
    </Badge>
  )
}

export function StepRecurrence({
  data,
  update,
  model,
}: {
  data: GuidedSchemeData
  update: (patch: Partial<GuidedSchemeData>) => void
  model: WizardModel
}) {
  const [showAll, setShowAll] = useState(false)
  const { occurrences } = model
  const rows = occurrences.rows.slice(0, showAll ? PREVIEW_ROWS_EXPANDED : PREVIEW_ROWS)
  const startTime = formatClockTime(data.plannedStartTime)
  const daily = data.frequency === "daily"

  const setEffectiveFrom = (effectiveFrom: string) =>
    update({
      effectiveFrom,
      // The fortnight anchor follows the start date.
      ...(data.frequency === "every-2-weeks"
        ? { weekRotation: fortnightRotation(effectiveFrom) }
        : {}),
    })

  return (
    <div className="max-w-4xl space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Field id="scheme-from" label="Effective from">
          <Input
            id="scheme-from"
            type="date"
            className="h-10 rounded-xl"
            value={data.effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </Field>
        <Field id="scheme-to" label="Effective to (optional)">
          <Input
            id="scheme-to"
            type="date"
            className="h-10 rounded-xl"
            value={data.effectiveTo}
            min={data.effectiveFrom || undefined}
            onChange={(event) => update({ effectiveTo: event.target.value })}
          />
        </Field>
        <Field id="scheme-frequency" label="Collection frequency">
          <SimpleSelect
            id="scheme-frequency"
            value={wizardFrequencyValue(data)}
            onChange={(value) => update(applyWizardFrequency(value, data))}
            options={WIZARD_FREQUENCIES}
            placeholder="Select frequency"
          />
        </Field>
        <Field id="scheme-start" label="Planned start time">
          <Input
            id="scheme-start"
            type="time"
            className="h-10 rounded-xl"
            value={data.plannedStartTime}
            onChange={(event) => update({ plannedStartTime: event.target.value })}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <Label className="text-sm" id="scheme-days-label">
          Service days
        </Label>
        <ToggleGroup
          type="multiple"
          variant="outline"
          value={data.serviceDays}
          onValueChange={(values) =>
            update({ serviceDays: sortServiceDays(values as ServiceDay[]) })
          }
          aria-labelledby="scheme-days-label"
          className="gap-2"
          disabled={daily}
        >
          {SERVICE_DAYS.map((day) => (
            <ToggleGroupItem
              key={day}
              value={day}
              aria-label={SERVICE_DAY_LABELS[day]}
              className={cn(PILL_TOGGLE_ITEM_CLASS, "h-10")}
            >
              {SERVICE_DAY_SHORT_LABELS[day]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Field id="scheme-holiday" label="On a public holiday">
          <SimpleSelect
            id="scheme-holiday"
            value={data.holidayPolicy}
            onChange={(value) => update({ holidayPolicy: value as GuidedSchemeData["holidayPolicy"] })}
            options={HOLIDAY_POLICY_OPTIONS}
            placeholder="Select"
          />
        </Field>
        {/* The project's calendar, read-only — there is no control to bind,
            so the label is plain text in label styling (a span, so it sits on
            the same baseline as the labels beside it). Which list the project
            brings and which days it rests on; amber while it has no list. */}
        <div className="space-y-2">
          <Label className="text-sm" asChild>
            <span>Holiday list · working week</span>
          </Label>
          <div
            data-testid="project-calendar"
            className={cn(
              "flex h-10 items-center gap-2 rounded-xl border border-input bg-muted/50 px-3 text-sm",
              !model.calendar.list &&
                "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
            )}
          >
            <CalendarDays
              className={cn(
                "size-4 shrink-0",
                model.calendar.list ? "text-muted-foreground" : "text-current",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{projectCalendarLabel(model.calendar)}</span>
            <Button
              variant="link"
              size="sm"
              className="h-auto shrink-0 p-0 text-xs text-current"
              asChild
            >
              <Link href={holidaySettingsHref(data.projectId)}>Settings</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-muted/40">
        <div className="flex h-12 items-center justify-between px-5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Next dates
          </span>
          {occurrences.rows.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {occurrences.count.toLocaleString("en-GB")} collections
              {occurrences.ongoing
                ? " · next 12 months"
                : occurrences.horizon
                  ? ` · until ${formatOccurrenceDate(occurrences.horizon)}`
                  : ""}
            </span>
          )}
        </div>
        {occurrences.rows.length === 0 ? (
          <div className="px-5 pb-5 text-sm text-muted-foreground">—</div>
        ) : (
          <div className="border-t border-border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 pl-5">#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead>ISO week</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead className="pr-5">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow
                    key={`${row.plannedDate}-${index}`}
                    className={row.status === "skipped" ? "text-muted-foreground" : undefined}
                  >
                    <TableCell className="pl-5 tabular-nums text-muted-foreground">
                      {row.n ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatOccurrenceDate(row.date)}</TableCell>
                    <TableCell>{SERVICE_DAY_LABELS[serviceDayOf(row.date)]}</TableCell>
                    <TableCell className="tabular-nums">{row.week}</TableCell>
                    <TableCell className="tabular-nums">{startTime}</TableCell>
                    <TableCell className="pr-5">
                      <StatusBadge row={row} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex h-11 items-center justify-between border-t border-border px-5 text-xs text-muted-foreground">
              <span>
                Showing 1–{rows.length} of {occurrences.rows.length}
              </span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll ? "Show fewer" : "Show all"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
