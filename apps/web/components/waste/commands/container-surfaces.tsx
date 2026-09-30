"use client"
// Containers on the Pilot (Issue #181, slice 5b of #81): the command
// surfaces of `resources.containers` and `resources.inventory`. Add container
// registers the identity the wire carries; a container's details offer its
// edit, the ledger's five commands and the door into service, and its own
// ledger read from the API. Every command is offered whatever the container's
// state, and the API's 409 says why one does not apply (the rules on #81).
// The forms are lib/data/containers.ts's, their values the adapter's input.
import { useMemo, useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useOpenRecord, useRelationPickers, useRowHistory, useServerNames, WAREHOUSES } from "@/components/waste/commands/use-command-support"
import { CONTAINERS_MODULE, containerMovements } from "@/lib/api/records/containers"
import type { StockMovement } from "@waste/contracts/stock"
import type { BusinessFormField, BusinessFormValues } from "@/lib/data/business-form-types"
import {
  CONTAINER_COMMAND_FORMS,
  CONTAINER_COMMANDS_OFFERED,
  CONTAINER_FORM,
  containerEditForm,
  containerFormValues,
  createContainerRecord,
  updateContainerRecord,
  type OfferedContainerCommand,
} from "@/lib/data/containers"

const { workspaceId, moduleId } = CONTAINERS_MODULE

/** Add container: the create form of the identity, through the store, the dialog open until the API has answered. */
export function AddContainerSurface({ label }: PrimarySurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const openRecord = useOpenRecord(moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = createContainerRecord(values, { now: Date.now() })
    setSaving(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, record),
      () => {
        setOpen(false)
        openRecord(record.id)
        toast.success("Container added", { description: `${record.name} is registered with no stock record: receive it into a warehouse next.` })
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
      <BusinessRecordFormDialog schema={CONTAINER_FORM} open={open} onOpenChange={setOpen} onSubmit={submit} relationOptions={pickers.options} />
    </>
  )
}

/** The movement a ledger row reads as: when, its kind, where from and where to, and why. */
function movementLine(movement: StockMovement, warehouseName: (serverId: string) => string): string {
  const place = (kind: string, warehouseId: string | null) => (warehouseId === null ? kind : kind === "warehouse" ? warehouseName(warehouseId) : `${kind} at ${warehouseName(warehouseId)}`)
  return `${movement.occurredAt.slice(0, 16).replace("T", " ")} · ${movement.kind} · ${place(movement.fromKind, movement.fromWarehouseId)} → ${place(movement.toKind, movement.toWarehouseId)}${movement.reason ? ` · ${movement.reason}` : ""}`
}

/** A container's commands and its ledger, in its details. */
export function ContainerCommandsSurface({ record }: RowSurfaceProps) {
  const { upsertRecord, sendCommand } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const ledger = useRowHistory(workspaceId, moduleId, record, containerMovements)
  const warehouseName = useServerNames(WAREHOUSES, "warehouse")
  // Held while the dialog is open: a new schema or new values reset what the person typed.
  const editForm = useMemo(() => containerEditForm(record), [record])
  const editValues = useMemo(() => containerFormValues(record), [record])
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState<OfferedContainerCommand | null>(null)
  const [busy, setBusy] = useState(false)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const options = (field: BusinessFormField, values: BusinessFormValues) => pickers.options(field, values, projectId)

  const saveEdit = (values: BusinessFormValues) => {
    if (busy) return
    const edited = updateContainerRecord(record, values)
    setBusy(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, edited),
      () => {
        setEditing(false)
        toast.success("Container updated", { description: `${edited.name} was updated.` })
      },
      () => setBusy(false),
    )
  }

  const run = (name: OfferedContainerCommand, values: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    void sendCommand(workspaceId, moduleId, record.id, name, values).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setCommand(null)
      toast.success(CONTAINER_COMMAND_FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })
  }

  return (
    <section className="space-y-4" data-testid="container-commands">
      <h3 className="text-sm font-semibold">Container commands</h3>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || !pickers.ready} onClick={() => setEditing(true)}>
          Edit
        </Button>
        {CONTAINER_COMMANDS_OFFERED.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={busy || !pickers.ready} onClick={() => setCommand(name)}>
            {CONTAINER_COMMAND_FORMS[name].submitLabel}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Stock movements</h4>
        {ledger.problem !== null ? (
          <p className="text-sm text-destructive">{ledger.problem}</p>
        ) : ledger.rows === null ? (
          <p className="text-sm text-muted-foreground">Reading the ledger…</p>
        ) : ledger.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stock movement yet.</p>
        ) : (
          <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="container-ledger">
            {ledger.rows.map((movement) => (
              <li key={movement.id} className="py-2">
                {movementLine(movement, warehouseName)}
              </li>
            ))}
          </ol>
        )}
      </div>
      {editing && (
        <BusinessRecordFormDialog
          schema={editForm}
          open
          onOpenChange={(open) => !open && setEditing(false)}
          onSubmit={saveEdit}
          relationOptions={options}
          initialValueOverrides={editValues}
        />
      )}
      {command !== null && (
        <BusinessRecordFormDialog
          schema={CONTAINER_COMMAND_FORMS[command]}
          open
          onOpenChange={(open) => !open && setCommand(null)}
          onSubmit={(values) => run(command, values)}
          relationOptions={options}
        />
      )}
    </section>
  )
}
