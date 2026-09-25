"use client"

// "Simulate next N occurrences" (Issue #40) — step 2's what-if panel. The
// person picks a candidate change to the recurrence (a holiday policy, a
// cadence, service days on or off, another effective window) and the panel
// runs the occurrence generator over the draft's next N collections twice —
// as the draft stands and with the candidate — and shows the delta row by
// row. Both runs go through the domain's simulateOccurrences, which calls the
// same generateOccurrences the next-dates table and route generation use, so
// what the simulation says would happen is what generation would write.
// "Apply" writes the candidate into the draft; the table above then shows it.

import { useMemo, useState } from "react"
import { ArrowRight, FlaskConical } from "lucide-react"

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
import { count } from "@waste/domain/text"
import {
  draftOccurrenceInput,
  type DraftRecurrenceFields,
} from "@waste/domain/route-schemes/draft"
import {
  formatOccurrenceDate,
  formatOccurrenceShortDate,
  type Occurrence,
} from "@waste/domain/route-schemes/occurrences"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import {
  SERVICE_DAYS,
  SERVICE_DAY_LABELS,
  SERVICE_DAY_SHORT_LABELS,
  sortServiceDays,
  type ServiceDay,
} from "@waste/domain/route-schemes/recurrence"
import {
  DEFAULT_SIMULATION_COUNT,
  SIMULATION_COUNTS,
  simulateOccurrences,
  type OccurrenceChange,
  type SimulatedOccurrence,
} from "@waste/domain/route-schemes/simulation"
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

const CHANGE_LABELS: Record<OccurrenceChange, string> = {
  unchanged: "Unchanged",
  added: "Added",
  removed: "Removed",
  moved: "Moved",
}

const CHANGE_BADGE_CLASS: Record<OccurrenceChange, string> = {
  unchanged: "",
  added: "border-transparent bg-emerald-50 text-emerald-700",
  removed: "border-transparent bg-red-50 text-red-700",
  moved: "border-transparent bg-amber-50 text-amber-800",
}

/** The recurrence fields a candidate may change, lifted off the draft. */
export function candidateFieldsOf(data: GuidedSchemeData): DraftRecurrenceFields {
  return {
    frequency: data.frequency,
    weekRotation: data.weekRotation,
    serviceDays: data.serviceDays,
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    plannedStartTime: data.plannedStartTime,
    holidayPolicy: data.holidayPolicy,
  }
}

/** "05 Oct 2026" for a collection; "Skipped" when the side skips the date; "—" when it has no row. */
function sideCell(row: Occurrence | null): string {
  if (!row) return "—"
  if (row.status === "skipped") return "Skipped"
  return formatOccurrenceDate(row.date)
}

function ChangeBadge({ change }: { change: OccurrenceChange }) {
  return (
    <Badge
      variant={change === "unchanged" ? "muted" : "secondary"}
      className={cn(CHANGE_BADGE_CLASS[change])}
    >
      {CHANGE_LABELS[change]}
    </Badge>
  )
}

export function SimulationPanel({
  data,
  model,
  onApply,
}: {
  data: GuidedSchemeData
  model: WizardModel
  /** Writes the candidate's recurrence fields into the draft. */
  onApply: (candidate: DraftRecurrenceFields) => void
}) {
  const [open, setOpen] = useState(false)
  const [countValue, setCount] = useState<number>(DEFAULT_SIMULATION_COUNT)
  const [candidate, setCandidate] = useState<DraftRecurrenceFields | null>(null)
  const [changedOnly, setChangedOnly] = useState(true)

  // The candidate starts as the draft and follows it until the person edits
  // it; a draft edit while the panel is open re-bases an untouched candidate.
  const fields = candidate ?? candidateFieldsOf(data)
  const setField = (patch: Partial<DraftRecurrenceFields>) => setCandidate({ ...fields, ...patch })
  const daily = fields.frequency === "daily"

  const simulation = useMemo(
    () =>
      simulateOccurrences({
        current: model.occurrenceInput,
        candidate: draftOccurrenceInput(fields, model.schemeCalendar),
        count: countValue,
      }),
    [model.occurrenceInput, model.schemeCalendar, fields, countValue],
  )
  const changed = simulation.rows.filter((row) => row.change !== "unchanged")
  const rows: SimulatedOccurrence[] = changedOnly ? changed : simulation.rows
  const differs = changed.length > 0
  const net = simulation.after - simulation.before

  if (!open) {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-dashed border-border px-5 py-3">
        <span className="text-sm text-muted-foreground">
          Try a change to the recurrence and see which collections it adds, removes, or moves
          before you make it.
        </span>
        <Button
          variant="outline"
          className="rounded-xl"
          onClick={() => setOpen(true)}
          disabled={!model.occurrenceInput}
        >
          <FlaskConical /> Simulate next {countValue} occurrences
        </Button>
      </div>
    )
  }

  return (
    <section
      aria-labelledby="scheme-simulation-heading"
      data-testid="simulation-panel"
      className="space-y-5 rounded-2xl border border-border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="scheme-simulation-heading" className="font-medium">
            Simulate next {countValue} occurrences
          </h3>
          <p className="text-xs text-muted-foreground">
            The draft as it stands against the change below, over the draft&apos;s next{" "}
            {count(countValue, "collection")}
            {simulation.window
              ? ` · ${formatOccurrenceShortDate(simulation.window.from)} – ${formatOccurrenceDate(simulation.window.to)}`
              : ""}
            .
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="scheme-simulation-count" className="text-sm">
            Next
          </Label>
          <SimpleSelect
            id="scheme-simulation-count"
            value={String(countValue)}
            onChange={(value) => setCount(Number(value))}
            options={SIMULATION_COUNTS.map((value) => ({
              value: String(value),
              label: `${value} occurrences`,
            }))}
            placeholder="Occurrences"
          />
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Field id="scheme-simulation-holiday" label="On a public holiday">
          <SimpleSelect
            id="scheme-simulation-holiday"
            value={fields.holidayPolicy}
            onChange={(value) =>
              setField({ holidayPolicy: value as DraftRecurrenceFields["holidayPolicy"] })
            }
            options={HOLIDAY_POLICY_OPTIONS}
            placeholder="Select"
          />
        </Field>
        <Field id="scheme-simulation-frequency" label="Collection frequency">
          <SimpleSelect
            id="scheme-simulation-frequency"
            value={wizardFrequencyValue(fields)}
            onChange={(value) => setField(applyWizardFrequency(value, fields))}
            options={WIZARD_FREQUENCIES}
            placeholder="Select frequency"
          />
        </Field>
        <Field id="scheme-simulation-from" label="Effective from">
          <Input
            id="scheme-simulation-from"
            type="date"
            className="h-10 rounded-xl"
            value={fields.effectiveFrom}
            onChange={(event) =>
              setField({
                effectiveFrom: event.target.value,
                ...(fields.frequency === "every-2-weeks"
                  ? { weekRotation: fortnightRotation(event.target.value) }
                  : {}),
              })
            }
          />
        </Field>
        <Field id="scheme-simulation-to" label="Effective to (optional)">
          <Input
            id="scheme-simulation-to"
            type="date"
            className="h-10 rounded-xl"
            value={fields.effectiveTo}
            min={fields.effectiveFrom || undefined}
            onChange={(event) => setField({ effectiveTo: event.target.value })}
          />
        </Field>
      </div>
      <div className="space-y-2">
        <Label className="text-sm" id="scheme-simulation-days-label">
          Service days
        </Label>
        <ToggleGroup
          type="multiple"
          variant="outline"
          value={fields.serviceDays}
          onValueChange={(values) =>
            setField({ serviceDays: sortServiceDays(values as ServiceDay[]) })
          }
          aria-labelledby="scheme-simulation-days-label"
          className="gap-2"
          disabled={daily}
        >
          {SERVICE_DAYS.map((day) => (
            <ToggleGroupItem
              key={day}
              value={day}
              aria-label={`Simulate ${SERVICE_DAY_LABELS[day]}`}
              className={cn(PILL_TOGGLE_ITEM_CLASS, "h-9")}
            >
              {SERVICE_DAY_SHORT_LABELS[day]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* The delta: the two counts and the tally, then the rows. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-muted/40">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-5 py-2">
          <span
            className="flex items-center gap-2 text-sm tabular-nums"
            data-testid="simulation-summary"
          >
            <span>{count(simulation.before, "collection")}</span>
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{count(simulation.after, "collection")}</span>
            {net !== 0 && (
              <span className={cn("text-xs", net > 0 ? "text-emerald-700" : "text-red-700")}>
                ({net > 0 ? "+" : ""}
                {net})
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {differs
              ? [
                  simulation.added > 0 ? `${simulation.added} added` : null,
                  simulation.removed > 0 ? `${simulation.removed} removed` : null,
                  simulation.moved > 0 ? `${simulation.moved} moved` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : candidate
                ? "No difference in this span"
                : "Change something above to compare"}
          </span>
        </div>
        {simulation.rows.length > 0 && (
          <div className="border-t border-border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Recurrence date</TableHead>
                  <TableHead>As it stands</TableHead>
                  <TableHead>With the change</TableHead>
                  <TableHead className="pr-5">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.plannedDate}
                    className={row.change === "unchanged" ? "text-muted-foreground" : undefined}
                  >
                    <TableCell className="pl-5 tabular-nums">
                      {formatOccurrenceShortDate(row.plannedDate)}
                    </TableCell>
                    <TableCell className="tabular-nums">{sideCell(row.current)}</TableCell>
                    <TableCell className="tabular-nums">{sideCell(row.candidate)}</TableCell>
                    <TableCell className="pr-5">
                      <ChangeBadge change={row.change} />
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="pl-5 text-muted-foreground">
                      Every one of the {count(simulation.rows.length, "date")} in this span stays
                      as it is.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="flex h-11 items-center justify-between border-t border-border px-5 text-xs text-muted-foreground">
              <span>
                {changedOnly
                  ? `${count(changed.length, "changed date")} of ${simulation.rows.length}`
                  : `${count(simulation.rows.length, "date")} in this span`}
              </span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setChangedOnly((current) => !current)}
              >
                {changedOnly ? "Show every date" : "Show changes only"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          className="rounded-xl"
          onClick={() => {
            setCandidate(null)
            setOpen(false)
          }}
        >
          Close simulation
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="rounded-xl"
            disabled={!candidate}
            onClick={() => setCandidate(null)}
          >
            Reset to draft
          </Button>
          <Button
            className="rounded-xl"
            disabled={!candidate}
            onClick={() => {
              onApply(fields)
              setCandidate(null)
            }}
          >
            Apply to draft
          </Button>
        </div>
      </div>
    </section>
  )
}
