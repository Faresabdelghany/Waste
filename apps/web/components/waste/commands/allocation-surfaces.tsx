"use client"
// Vehicle allocations on the Pilot (Issue #181, slice 5b of #81): the command
// surfaces of `fleet.vehicle-planning`. Allocate reserves a vehicle over a
// window; an allocation's details offer the change (with its reason, which
// goes on the history), confirm and release, and the history itself read
// from the API. A released allocation changes no more, and the API's 409
// says so. The forms are lib/data/allocations.ts's.
import { useMemo, useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useOpenRecord, useRelationPickers, useRowHistory } from "@/components/waste/commands/use-command-support"
import { allocationEvents, CONFIRM_ALLOCATION, RELEASE_ALLOCATION, VEHICLE_PLANNING_MODULE } from "@/lib/api/records/allocations"
import { ALLOCATE_FORM, allocationChangeForm, allocationFormValues, changedAllocationRecord, createAllocationRecord, RELEASE_FORM } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"

const { workspaceId, moduleId } = VEHICLE_PLANNING_MODULE

/** Allocate: the reservation through the store, the dialog open until the API has answered. */
export function AllocateSurface({ label }: PrimarySurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const openRecord = useOpenRecord(moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = createAllocationRecord(values, { now: Date.now() })
    setSaving(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, record),
      () => {
        setOpen(false)
        openRecord(record.id)
        toast.success("Vehicle allocated", { description: "The reservation is on the vehicle's plan." })
      },
      () => setSaving(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!pickers.ready || saving} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      <BusinessRecordFormDialog schema={ALLOCATE_FORM} open={open} onOpenChange={setOpen} onSubmit={submit} relationOptions={pickers.options} />
    </>
  )
}

/** An allocation's change, confirm and release, and its history, in its details. */
export function AllocationCommandsSurface({ record }: RowSurfaceProps) {
  const { upsertRecord, sendCommand } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const history = useRowHistory(workspaceId, moduleId, record, allocationEvents)
  // Held while the dialog is open: a new schema or new values reset what the person typed.
  const changeForm = useMemo(() => allocationChangeForm(record), [record])
  const changeValues = useMemo(() => allocationFormValues(record), [record])
  const [changing, setChanging] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [busy, setBusy] = useState(false)

  const change = (values: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, changedAllocationRecord(record, values)),
      () => {
        setChanging(false)
        toast.success("Allocation changed", { description: `${record.name}: the change is on its history.` })
      },
      () => setBusy(false),
    )
  }

  const command = (name: string, input?: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    void sendCommand(workspaceId, moduleId, record.id, name, input).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setReleasing(false)
      toast.success(`Allocation ${outcome.record.status.toLowerCase()}`, { description: outcome.record.name })
    })
  }

  return (
    <section className="space-y-4" data-testid="allocation-commands">
      <h3 className="text-sm font-semibold">Allocation commands</h3>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || !pickers.ready} onClick={() => setChanging(true)}>
          Change
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => command(CONFIRM_ALLOCATION)}>
          Confirm
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setReleasing(true)}>
          Release
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">History</h4>
        {history.problem !== null ? (
          <p className="text-sm text-destructive">{history.problem}</p>
        ) : history.rows === null ? (
          <p className="text-sm text-muted-foreground">Reading the history…</p>
        ) : (
          <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="allocation-history">
            {history.rows.map((event) => (
              <li key={event.id} className="py-2">
                {`${event.recordedAt.slice(0, 16).replace("T", " ")} · ${event.action} → ${event.status}${event.reason ? ` · ${event.reason}` : ""}`}
              </li>
            ))}
          </ol>
        )}
      </div>
      {changing && (
        <BusinessRecordFormDialog
          schema={changeForm}
          open
          onOpenChange={(open) => !open && setChanging(false)}
          onSubmit={change}
          relationOptions={pickers.options}
          initialValueOverrides={changeValues}
        />
      )}
      {releasing && (
        <BusinessRecordFormDialog
          schema={RELEASE_FORM}
          open
          onOpenChange={(open) => !open && setReleasing(false)}
          onSubmit={(values) => command(RELEASE_ALLOCATION, values)}
          relationOptions={pickers.options}
        />
      )}
    </section>
  )
}
