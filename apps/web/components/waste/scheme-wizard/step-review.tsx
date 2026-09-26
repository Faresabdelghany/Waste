"use client"

// Step 5 — Ready to create this scheme? Four sections with Change links
// back to their steps, what changed since the last review (Issue #40), then
// the create option.

import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { projectCalendarLabel } from "@waste/domain/route-schemes/project-calendar"
import { HOLIDAY_POLICY_LABELS, PREVIEW_HORIZON_MONTHS, formatClockTime, formatOccurrenceDate } from "@waste/domain/route-schemes/occurrences"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { recurrenceCadenceLabel, serviceDaysRangeLabel } from "@waste/domain/route-schemes/recurrence"

import type { WizardRecords } from "./use-wizard-records"
import { WhatChanged } from "./what-changed"
import type { WizardModel } from "./wizard-model"
import { CREATE_AS_OPTIONS, type WizardStepId } from "./wizard-options"
import { Field, SimpleSelect } from "./wizard-fields"

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 border-b border-border/60 py-2.5 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value}</dd>
    </div>
  )
}

function ReviewSection({
  title,
  step,
  go,
  children,
}: {
  title: string
  step: WizardStepId
  go: (step: WizardStepId) => void
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border px-5 py-3">
      <div className="flex h-9 items-center justify-between">
        <h3 className="font-medium">{title}</h3>
        <Button variant="link" className="h-auto p-0 text-sm" onClick={() => go(step)}>
          Change
        </Button>
      </div>
      <dl>{children}</dl>
    </section>
  )
}

const DASH = "—"

export function StepReview({
  data,
  update,
  model,
  records,
  go,
  initial,
  reviewed,
}: {
  data: GuidedSchemeData
  update: (patch: Partial<GuidedSchemeData>) => void
  model: WizardModel
  records: WizardRecords
  go: (step: WizardStepId) => void
  /** The draft the wizard opened with — the What changed baseline before any review. */
  initial: GuidedSchemeData
  /** The draft as it stood when this step was last left; null on the first visit. */
  reviewed: GuidedSchemeData | null
}) {
  const { occurrences, recurrence, groups } = model
  const first = occurrences.rows.find((row) => row.n !== null)
  const attention = groups
    .filter((summary) => summary.estimate.overShift || summary.estimate.overCapacity)
    .map((summary) => summary.group.name)

  return (
    <div className="max-w-4xl space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <ReviewSection title="Scheme & scope" step={1} go={go}>
          <ReviewRow label="Name" value={data.schemeName.trim() || DASH} />
          <ReviewRow label="Project" value={model.nameOf(records.projects, data.projectId) ?? DASH} />
          <ReviewRow
            label="Planning area"
            value={model.nameOf(records.areas, data.planningAreaId) ?? DASH}
          />
          <ReviewRow label="Waste fraction" value={data.wasteFraction || DASH} />
          <ReviewRow label="Service type" value={data.serviceType || DASH} />
          <ReviewRow
            label="Depot · station"
            value={`${model.nameOf(records.depots, data.depotId) ?? DASH} · ${
              model.nameOf(records.stations, data.unloadingStationId) ?? DASH
            }`}
          />
        </ReviewSection>
        <ReviewSection title="Recurrence" step={2} go={go}>
          <ReviewRow label="Frequency" value={recurrence ? recurrenceCadenceLabel(recurrence) : DASH} />
          <ReviewRow label="Service days" value={serviceDaysRangeLabel(model.serviceDays) || DASH} />
          <ReviewRow label="Start time" value={formatClockTime(data.plannedStartTime) || DASH} />
          <ReviewRow label="First collection" value={first ? formatOccurrenceDate(first.date) : DASH} />
          <ReviewRow
            label="Collections"
            value={`${occurrences.count.toLocaleString("en-GB")}${
              occurrences.ongoing ? ` in the next ${PREVIEW_HORIZON_MONTHS} months` : ""
            }`}
          />
          <ReviewRow label="Holiday list" value={projectCalendarLabel(model.calendar)} />
          <ReviewRow label="Holidays" value={HOLIDAY_POLICY_LABELS[data.holidayPolicy]} />
        </ReviewSection>
      </div>
      <ReviewSection title="Collection groups" step={3} go={go}>
        {groups.map(({ group, vehicle, driver, stops, estimate }) => (
          <ReviewRow
            key={group.id}
            label={group.name}
            value={`${serviceDaysRangeLabel(group.days)} · ${vehicle?.callsign ?? group.vehicleId ?? DASH} · ${
              driver?.name ?? "Unassigned"
            } · ${stops.toLocaleString("en-GB")} containers · ${estimate.loadT} t / ${estimate.capacityT} t`}
          />
        ))}
      </ReviewSection>
      <ReviewSection title="Routes" step={4} go={go}>
        <ReviewRow label="Per week" value={`${model.routesPerWeek} routes`} />
        <ReviewRow label="Attention" value={attention.length > 0 ? attention.join(", ") : "None"} />
      </ReviewSection>
      <WhatChanged data={data} initial={initial} reviewed={reviewed} model={model} records={records} />
      <div className="grid gap-6 pt-2 md:grid-cols-2">
        <Field id="scheme-create-as" label="Create as">
          <SimpleSelect
            id="scheme-create-as"
            value={data.createAs}
            onChange={(value) => update({ createAs: value as GuidedSchemeData["createAs"] })}
            options={CREATE_AS_OPTIONS}
            placeholder="Select"
          />
        </Field>
      </div>
    </div>
  )
}
