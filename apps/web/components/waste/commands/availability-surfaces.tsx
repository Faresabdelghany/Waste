"use client"
// When a driver or a vehicle is not there, on the Pilot (O6 of #290): the
// row surfaces of `fleet.drivers` and `fleet.vehicles`. A driver's details
// list the absences, earliest first, each removable, and record a new one;
// a vehicle's or a trailer's the periods it is out of use, the same way. The
// periods are read from the API beside the row (`useRowHistory`), again after
// each action the API took, and written as the row's actions
// (lib/api/records/availability.ts); a refusal — a second period over a day
// one covers — is the store's toast in the API's words, and the dialog stays
// open on it. The row keeps the generic Edit beside this (`genericEdit`).
// Nothing is offered until the module reads the API's rows.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useRowHistory } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import {
  awayLine,
  driverAbsences,
  recordDriverAbsence,
  recordVehicleUnavailability,
  removeDriverAbsence,
  removeVehicleUnavailability,
  vehicleUnavailability,
  type AwayInput,
  type AwayPeriod,
} from "@/lib/api/records/availability"
import type { ActionOutcome, SendAction } from "@/lib/api/records/server-records"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "@/lib/data/allocations"
import { ABSENCE_FORM, UNAVAILABILITY_FORM } from "@/lib/data/availability"
import type { BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"

/** What differs between a driver's surface and a vehicle's. */
type AwayKind = {
  module: ModuleLocation
  heading: string
  form: BusinessFormSchema
  read: (client: ApiClient, serverId: string) => Promise<AwayPeriod[]>
  record: (sendAction: SendAction, recordId: string, input: AwayInput) => Promise<ActionOutcome<unknown>>
  remove: (sendAction: SendAction, recordId: string, periodId: string) => Promise<ActionOutcome<unknown>>
  recorded: string
  removed: string
  empty: string
  testId: string
}

const DRIVER_AWAY: AwayKind = {
  module: DRIVERS_MODULE,
  heading: "Absences",
  form: ABSENCE_FORM,
  read: driverAbsences,
  record: recordDriverAbsence,
  remove: removeDriverAbsence,
  recorded: "Absence recorded",
  removed: "Absence removed",
  empty: "No absence recorded.",
  testId: "driver-absences",
}

const VEHICLE_AWAY: AwayKind = {
  module: VEHICLES_MODULE,
  heading: "Out of use",
  form: UNAVAILABILITY_FORM,
  read: vehicleUnavailability,
  record: recordVehicleUnavailability,
  remove: removeVehicleUnavailability,
  recorded: "Out of use recorded",
  removed: "Period removed",
  empty: "No period out of use recorded.",
  testId: "vehicle-unavailability",
}

const text = (values: BusinessFormValues, key: string): string => (typeof values[key] === "string" ? (values[key] as string) : "")

function AwaySurface({ record, kind }: RowSurfaceProps & { kind: AwayKind }) {
  const { sendAction } = useBusinessRecordStore()
  const moduleReady = useModuleReady(kind.module)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  // Bumped after each action the API took: the periods are read again, whatever the row shows.
  const [version, setVersion] = useState(0)
  const periods = useRowHistory(kind.module.workspaceId, kind.module.moduleId, record, version, kind.read)

  const settle = (outcome: Promise<ActionOutcome<unknown>>, done: () => void) => {
    setBusy(true)
    void outcome.then((result) => {
      setBusy(false)
      if (result.kind !== "done") return
      setVersion((current) => current + 1)
      done()
    })
  }

  const submit = (values: BusinessFormValues) => {
    if (busy) return
    const input: AwayInput = { validFrom: text(values, "validFrom"), lastDay: text(values, "lastDay"), reason: text(values, "reason"), note: text(values, "note") }
    settle(kind.record(sendAction, record.id, input), () => {
      setOpen(false)
      toast.success(kind.recorded, { description: record.name })
    })
  }

  const removePeriod = (period: AwayPeriod) => {
    if (busy) return
    settle(kind.remove(sendAction, record.id, period.id), () => toast.success(kind.removed, { description: `${record.name}: ${awayLine(period)}` }))
  }

  return (
    <section className="space-y-4" data-testid={kind.testId}>
      <h3 className="text-sm font-semibold">{kind.heading}</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The rows are being read from the API; what they are away for follows.</p>}
      <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen(true)}>
        {kind.form.submitLabel}
      </Button>
      <ReadRows
        read={periods}
        label="Reading the periods…"
        empty={kind.empty}
        testId={`${kind.testId}-periods`}
        line={(period) => (
          <div className="flex items-center justify-between gap-2">
            <span>{awayLine(period)}</span>
            <Button variant="ghost" size="sm" disabled={!moduleReady || busy} onClick={() => removePeriod(period)}>
              Remove
            </Button>
          </div>
        )}
      />
      {open && <BusinessRecordFormDialog schema={kind.form} open onOpenChange={(isOpen) => !isOpen && setOpen(false)} onSubmit={submit} relationOptions={(field) => field.options ?? []} submitting={busy} />}
    </section>
  )
}

/** A driver's absences, in the driver's details. */
export function DriverAbsenceSurface({ record }: RowSurfaceProps) {
  return <AwaySurface record={record} kind={DRIVER_AWAY} />
}

/** A vehicle's or a trailer's periods out of use, in its details. */
export function VehicleUnavailabilitySurface({ record }: RowSurfaceProps) {
  return <AwaySurface record={record} kind={VEHICLE_AWAY} />
}
