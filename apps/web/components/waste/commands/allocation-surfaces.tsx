"use client"
// Vehicle allocations on the Pilot (Issue #181, slice 5b of #81): the command
// surfaces of `fleet.vehicle-planning`. Allocate reserves a vehicle over a
// window; an allocation's details offer the change (with its reason, which
// goes on the history), confirm and release, and the history itself read
// from the API, on the project's clock. A released allocation changes no
// more, and the API's 409 says so. The forms are lib/data/allocations.ts's.
// Nothing is offered until the module reads the API's rows.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useRelationPickers, useRowHistory } from "@/components/waste/commands/use-command-support"
import { allocationEvents, CONFIRM_ALLOCATION, RELEASE_ALLOCATION, VEHICLE_PLANNING_MODULE } from "@/lib/api/records/allocations"
import { shownOn } from "@/lib/api/records/clock"
import { ALLOCATE_FORM, allocationChangeForm, allocationFormValues, changedAllocationRecord, createAllocationRecord, RELEASE_FORM } from "@/lib/data/allocations"
import type { BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"

const { workspaceId, moduleId } = VEHICLE_PLANNING_MODULE

/** Allocate: the reservation. */
export function AllocateSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateSurface
      label={label}
      module={VEHICLE_PLANNING_MODULE}
      schema={ALLOCATE_FORM}
      make={(values, now) => createAllocationRecord(values, { now })}
      created={() => ({ title: "Vehicle allocated", description: "The reservation is on the vehicle's plan." })}
    />
  )
}

/** A dialog open on a snapshot of the row: the change's schema and values hold while the store's optimistic write and its rollback replace the row. */
type Open = { kind: "change"; schema: BusinessFormSchema; values: BusinessFormValues } | { kind: "release" }

/** An allocation's change, confirm and release, and its history, in its details. */
export function AllocationCommandsSurface({ record }: RowSurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(VEHICLE_PLANNING_MODULE)
  // The version is bumped after each write and command the API took: the history is appended to, whatever the row shows.
  const { busy, version, save, run: send } = useCommandRunner(VEHICLE_PLANNING_MODULE, record.id)
  const history = useRowHistory(workspaceId, moduleId, record, version, allocationEvents)
  const [open, setOpen] = useState<Open | null>(null)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const timezone = pickers.timezoneOf(projectId)
  const changeForm = allocationChangeForm(record)

  const change = (values: BusinessFormValues) => {
    if (busy) return
    const outcome = upsertRecord(workspaceId, moduleId, changedAllocationRecord(record, values))
    save(outcome, () => setOpen(null))
    void outcome?.then((result) => {
      if (result.kind === "updated") toast.success("Allocation changed", { description: `${record.name}: the change and its reason are on its history.` })
      // Nothing but the reason moved: no change was sent, and nothing went on the history.
      else if (result.kind === "unchanged") toast.info("Nothing to change", { description: `${record.name} already reserves what the form says; no change was recorded.` })
    })
  }

  const command = (name: string, input?: BusinessFormValues) =>
    send(name, input, (outcome) => {
      setOpen(null)
      toast.success(`Allocation ${outcome.record.status.toLowerCase()}`, { description: outcome.record.name })
    })

  return (
    <section className="space-y-4" data-testid="allocation-commands">
      <h3 className="text-sm font-semibold">Allocation commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The allocations are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(changeForm)} onClick={() => setOpen({ kind: "change", schema: changeForm, values: allocationFormValues(record) })}>
          Change
        </Button>
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => command(CONFIRM_ALLOCATION)}>
          Confirm
        </Button>
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen({ kind: "release" })}>
          Release
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">History</h4>
        <ReadRows read={history} label="Reading the history…" empty="Nothing on the history yet." testId="allocation-history" line={(event) => `${shownOn(event.recordedAt, timezone)} · ${event.action} → ${event.status}${event.reason ? ` · ${event.reason}` : ""}`} />
      </div>
      {open?.kind === "change" && (
        <BusinessRecordFormDialog schema={open.schema} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={change} relationOptions={pickers.options} initialValueOverrides={open.values} />
      )}
      {open?.kind === "release" && (
        <BusinessRecordFormDialog schema={RELEASE_FORM} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => command(RELEASE_ALLOCATION, values)} relationOptions={pickers.options} />
      )}
    </section>
  )
}
