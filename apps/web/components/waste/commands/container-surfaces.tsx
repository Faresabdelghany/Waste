"use client"
// Containers on the Pilot (Issue #181, slice 5b of #81): the command
// surfaces of `resources.containers`. Add container registers the identity
// the wire carries; a container's details offer its edit, the ledger's five
// commands and the door into service, and its own ledger read from the API.
// Every command is offered whatever the container's state, and the API's 409
// says why one does not apply (the rules on #81). The forms are
// lib/data/containers.ts's, their values the adapter's input. Nothing is
// offered until the module reads the API's rows: before that, and after its
// load failed, a write would reach the browser's bucket and never the API.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { useModuleReady, useRelationPickers, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { shownOn } from "@/lib/api/records/clock"
import { CONTAINERS_MODULE, containerMovements } from "@/lib/api/records/containers"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  CONTAINER_COMMAND_FORMS,
  CONTAINER_COMMANDS_OFFERED,
  CONTAINER_FORM,
  containerEditForm,
  containerFormValues,
  createContainerRecord,
  updateContainerRecord,
  WAREHOUSES_MODULE,
  type OfferedContainerCommand,
} from "@/lib/data/containers"
import type { StockMovement } from "@waste/contracts/stock"

const { workspaceId, moduleId } = CONTAINERS_MODULE

/** Add container: the create form of the identity. */
export function AddContainerSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateSurface
      label={label}
      module={CONTAINERS_MODULE}
      schema={CONTAINER_FORM}
      make={(values, now) => createContainerRecord(values, { now })}
      created={(record) => ({ title: "Container added", description: `${record.name} is registered with no stock record: receive it into a warehouse next.` })}
    />
  )
}

/** The movement a ledger row reads as: when on the project's clock, its kind, where from and where to, and why. */
function movementLine(movement: StockMovement, warehouseName: (serverId: string) => string, timezone: string | undefined): string {
  const place = (kind: string, warehouseId: string | null) => (warehouseId === null ? kind : kind === "warehouse" ? warehouseName(warehouseId) : `${kind} at ${warehouseName(warehouseId)}`)
  return `${shownOn(movement.occurredAt, timezone)} · ${movement.kind} · ${place(movement.fromKind, movement.fromWarehouseId)} → ${place(movement.toKind, movement.toWarehouseId)}${movement.reason ? ` · ${movement.reason}` : ""}`
}

/** A dialog open on a snapshot of the row: the schema and values it opened with hold while the store's optimistic write and its rollback replace the row. */
type Open = { kind: "edit"; schema: BusinessFormSchema; values: BusinessFormValues } | { kind: "command"; name: OfferedContainerCommand }

/** A container's commands and its ledger, in its details. */
export function ContainerCommandsSurface({ record }: RowSurfaceProps) {
  const { upsertRecord, sendCommand } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(CONTAINERS_MODULE)
  // Bumped after each write and command the surface sends: a movement need not change what the row shows.
  const [version, setVersion] = useState(0)
  const ledger = useRowHistory(workspaceId, moduleId, record, version, containerMovements)
  const warehouseName = useServerNames(WAREHOUSES_MODULE, "warehouse")
  const [open, setOpen] = useState<Open | null>(null)
  const [busy, setBusy] = useState(false)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const timezone = pickers.timezoneOf(projectId)
  const options = (field: BusinessFormField, values: BusinessFormValues) => pickers.options(field, values, projectId)
  const offered = (schema: BusinessFormSchema) => moduleReady && !busy && pickers.readyFor(schema)

  const openEdit = (row: BusinessRecord) => setOpen({ kind: "edit", schema: containerEditForm(row), values: containerFormValues(row) })

  const saveEdit = (values: BusinessFormValues) => {
    if (busy) return
    const edited = updateContainerRecord(record, values)
    const outcome = upsertRecord(workspaceId, moduleId, edited)
    setBusy(true)
    whenSaved(
      outcome,
      () => {
        setOpen(null)
        setVersion((current) => current + 1)
      },
      () => setBusy(false),
    )
    void outcome?.then((result) => {
      if (result.kind === "updated") toast.success("Container updated", { description: `${edited.name} was updated.` })
      else if (result.kind === "unchanged") toast.info("Nothing to change", { description: `${edited.name} is as the API holds it.` })
    })
  }

  const run = (name: OfferedContainerCommand, values: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    void sendCommand(workspaceId, moduleId, record.id, name, values).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setOpen(null)
      setVersion((current) => current + 1)
      toast.success(CONTAINER_COMMAND_FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })
  }

  const editForm = containerEditForm(record)

  return (
    <section className="space-y-4" data-testid="container-commands">
      <h3 className="text-sm font-semibold">Container commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The containers are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!offered(editForm)} onClick={() => openEdit(record)}>
          Edit
        </Button>
        {CONTAINER_COMMANDS_OFFERED.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!offered(CONTAINER_COMMAND_FORMS[name])} onClick={() => setOpen({ kind: "command", name })}>
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
                {movementLine(movement, warehouseName, timezone)}
              </li>
            ))}
          </ol>
        )}
      </div>
      {open?.kind === "edit" && (
        <BusinessRecordFormDialog schema={open.schema} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={saveEdit} relationOptions={options} initialValueOverrides={open.values} />
      )}
      {open?.kind === "command" && (
        <BusinessRecordFormDialog schema={CONTAINER_COMMAND_FORMS[open.name]} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => run(open.name, values)} relationOptions={options} />
      )}
    </section>
  )
}
