"use client"

// Step 1 — Which scope does this scheme plan for?

import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import type { BusinessRecord } from "@/lib/data/business-modules"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"

import type { WizardRecords } from "./use-wizard-records"
import { Field, SimpleSelect } from "./wizard-fields"

const toOptions = (records: readonly BusinessRecord[]) =>
  records.map((record) => ({ value: record.id, label: record.name }))

export function StepScope({
  data,
  update,
  records,
}: {
  data: GuidedSchemeData
  update: (patch: Partial<GuidedSchemeData>) => void
  records: WizardRecords
}) {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Field id="scheme-name" label="Route scheme name">
          <Input
            id="scheme-name"
            className="h-10 rounded-xl"
            placeholder="e.g. Central weekly plan"
            value={data.schemeName}
            onChange={(event) => update({ schemeName: event.target.value })}
          />
        </Field>
        <Field id="scheme-project" label="Project">
          <SimpleSelect
            id="scheme-project"
            value={data.projectId}
            onChange={(projectId) => update({ projectId })}
            options={toOptions(records.projects)}
            placeholder="Select project"
          />
        </Field>
        <Field id="scheme-area" label="Operational planning area">
          <SimpleSelect
            id="scheme-area"
            value={data.planningAreaId}
            onChange={(planningAreaId) => update({ planningAreaId })}
            options={toOptions(records.areas)}
            placeholder="Select planning area"
          />
        </Field>
        <Field id="scheme-calendar" label="Collection calendar">
          <SimpleSelect
            id="scheme-calendar"
            value={data.calendarId}
            onChange={(calendarId) => update({ calendarId })}
            options={toOptions(records.calendars)}
            placeholder="Select collection calendar"
          />
        </Field>
      </div>
      <Separator />
      <div className="text-sm text-muted-foreground">Operational defaults (optional)</div>
      <div className="grid gap-6 md:grid-cols-2">
        <Field id="scheme-depot" label="Departure depot">
          <SimpleSelect
            id="scheme-depot"
            value={data.depotId}
            onChange={(depotId) => update({ depotId })}
            options={toOptions(records.depots)}
            placeholder="Select depot"
          />
        </Field>
        <Field id="scheme-station" label="Unloading station">
          <SimpleSelect
            id="scheme-station"
            value={data.unloadingStationId}
            onChange={(unloadingStationId) => update({ unloadingStationId })}
            options={toOptions(records.stations)}
            placeholder="Select unloading station"
          />
        </Field>
      </div>
    </div>
  )
}
