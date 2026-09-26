"use client"

// "What changed" (Issue #40) — the review step's diff of the draft against an
// earlier version of itself: the draft as it stood when the person last
// reviewed it (they went back through Change or the rail and returned), or
// the draft the wizard opened with (blank, or Map Planning's seed). One row
// per field whose reading differs — what it said, what it says now — and one
// per collection group added, removed, or changed. The reading is the
// domain's schemeDraftChanges; ids read as names through the records.

import { useState } from "react"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { count } from "@waste/domain/text"
import {
  schemeDraftChanges,
  type SchemeDraftNames,
} from "@waste/domain/route-schemes/changes"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { cn } from "@/lib/utils"

import type { WizardRecords } from "./use-wizard-records"
import type { WizardModel } from "./wizard-model"

export type ChangeBaseline = "review" | "start"

const BASELINE_LABELS: Record<ChangeBaseline, string> = {
  review: "Since last review",
  start: "Since you started",
}

/** How the diff reads an id: the record's name, the vehicle's callsign, the driver's name. */
export function draftNamesOf(model: WizardModel, records: WizardRecords): SchemeDraftNames {
  return {
    project: (id) => model.nameOf(records.projects, id),
    area: (id) => model.nameOf(records.areas, id),
    depot: (id) => model.nameOf(records.depots, id),
    station: (id) => model.nameOf(records.stations, id),
    vehicle: (id) => model.vehicleById(id)?.callsign,
    driver: (id) => model.driverById(id)?.name,
  }
}

export function WhatChanged({
  data,
  initial,
  reviewed,
  model,
  records,
}: {
  data: GuidedSchemeData
  /** The draft the wizard opened with. */
  initial: GuidedSchemeData
  /** The draft as it stood when the person last left the review step; null until they have. */
  reviewed: GuidedSchemeData | null
  model: WizardModel
  records: WizardRecords
}) {
  const [baselineState, setBaseline] = useState<ChangeBaseline | null>(null)
  // Default to the last review once there is one; before that only the start exists.
  const baseline: ChangeBaseline = baselineState ?? (reviewed ? "review" : "start")
  const against = baseline === "review" && reviewed ? reviewed : initial
  const changes = schemeDraftChanges(against, data, draftNamesOf(model, records))

  return (
    <section
      className="rounded-2xl border border-border px-5 py-3"
      aria-labelledby="scheme-what-changed-heading"
      data-testid="what-changed"
    >
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h3 id="scheme-what-changed-heading" className="font-medium">
          What changed
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {changes.length === 0 ? "Nothing" : count(changes.length, "change")}
          </span>
        </h3>
        {reviewed && (
          <div className="flex gap-1 text-xs" role="group" aria-label="Compare against">
            {(["review", "start"] as const).map((option) => (
              <Button
                key={option}
                variant="ghost"
                size="sm"
                aria-pressed={baseline === option}
                className={cn(
                  "h-7 rounded-full px-3 text-xs",
                  baseline === option && "bg-muted font-medium",
                )}
                onClick={() => setBaseline(option)}
              >
                {BASELINE_LABELS[option]}
              </Button>
            ))}
          </div>
        )}
      </div>
      {changes.length === 0 ? (
        <p className="pb-2 text-sm text-muted-foreground">
          {baseline === "review"
            ? "The scheme reads exactly as it did when you last reviewed it."
            : "The scheme reads exactly as it did when you opened the guided setup."}
        </p>
      ) : (
        <dl>
          {changes.map((change) => (
            <div
              key={change.field}
              className="grid grid-cols-3 gap-4 border-b border-border/60 py-2.5 text-sm last:border-0"
            >
              <dt className="text-muted-foreground">{change.label}</dt>
              <dd className="col-span-2 flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground line-through decoration-muted-foreground/60">
                  {change.before}
                </span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span>{change.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!reviewed && (
        <p className="pb-2 text-xs text-muted-foreground">
          {BASELINE_LABELS.start}. Go back through Change and return to compare against this
          review instead.
        </p>
      )}
    </section>
  )
}
