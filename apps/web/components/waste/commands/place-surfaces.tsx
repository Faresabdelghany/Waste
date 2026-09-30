"use client"
// Properties, property groups and shared collection points on the Pilot
// (Issue #184, slice 9b of #81): the command surfaces of
// `customers.properties`, `customers.groups` and `customers.shared`. Each
// module's primary action is its own create form, and a row's details offer
// its Edit, which saves the fields that moved and the set — the parties, the
// members — whole through its `PUT` (lib/api/records/properties.ts). The
// status moves by the details' own lifecycle actions, which the adapters'
// `statuses` spell. The forms are lib/data/properties.ts's. Nothing is
// offered until the module reads the API's rows and every module its form
// picks from has answered: before that, a write would reach the browser's
// bucket and never the API.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { useModuleReady, useRelationPickers } from "@/components/waste/commands/use-command-support"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"
import {
  createPropertyGroupRecord,
  createPropertyRecord,
  createSharedPointRecord,
  formValuesOf,
  PROPERTIES_MODULE,
  PROPERTY_EDIT_FORM,
  PROPERTY_FORM,
  PROPERTY_GROUP_EDIT_FORM,
  PROPERTY_GROUP_FORM,
  PROPERTY_GROUPS_MODULE,
  SHARED_POINT_EDIT_FORM,
  SHARED_POINT_FORM,
  SHARED_POINTS_MODULE,
  updatedRecord,
} from "@/lib/data/properties"

/** Create property: the address, its point where known, and its parties in one request. */
export function AddPropertySurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateSurface
      label={label}
      module={PROPERTIES_MODULE}
      schema={PROPERTY_FORM}
      make={(values, now) => createPropertyRecord(values, { now })}
      created={(record) => ({ title: "Property registered", description: `${record.name} is registered with its parties.` })}
    />
  )
}

/** Create property group: the group and its members in one request. */
export function AddPropertyGroupSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateSurface
      label={label}
      module={PROPERTY_GROUPS_MODULE}
      schema={PROPERTY_GROUP_FORM}
      make={(values, now) => createPropertyGroupRecord(values, { now })}
      created={(record) => ({ title: "Property group created", description: `${record.name} is ${record.status.toLowerCase()}.` })}
    />
  )
}

/** Create shared point: the place, its access and billing, and its members in one request. */
export function AddSharedPointSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateSurface
      label={label}
      module={SHARED_POINTS_MODULE}
      schema={SHARED_POINT_FORM}
      make={(values, now) => createSharedPointRecord(values, { now })}
      created={(record) => ({ title: "Shared collection point created", description: `${record.name} is ${record.status.toLowerCase()}.` })}
    />
  )
}

/**
 * A row's Edit: the module's edit form opened on the row's values as they
 * stand when it opens — the store's optimistic write and its rollback may
 * replace the row while the dialog is open — and the write through the store,
 * the dialog open until the API has answered and on its refusal.
 */
function EditSurface({ record, module, schema, noun }: RowSurfaceProps & { module: ModuleLocation; schema: BusinessFormSchema; noun: string }) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(module)
  const [opened, setOpened] = useState<BusinessFormValues | null>(null)
  const [busy, setBusy] = useState(false)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const options = (field: BusinessFormField, values: BusinessFormValues) => pickers.options(field, values, projectId)

  const save = (values: BusinessFormValues) => {
    if (busy) return
    const edited = updatedRecord(record, values, schema.nameField ?? "name")
    const outcome = upsertRecord(module.workspaceId, module.moduleId, edited)
    setBusy(true)
    whenSaved(
      outcome,
      () => setOpened(null),
      () => setBusy(false),
    )
    void outcome?.then((result) => {
      if (result.kind === "updated") toast.success(`${noun} updated`, { description: `${edited.name} was updated.` })
      else if (result.kind === "unchanged") toast.info("Nothing to change", { description: `${edited.name} is as the API holds it.` })
    })
  }

  return (
    <section className="space-y-3" data-testid="place-commands">
      {!moduleReady && <p className="text-sm text-muted-foreground">The rows are being read from the API; the edit follows.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(schema)} onClick={() => setOpened(formValuesOf(schema, record))}>
          Edit {noun.toLowerCase()}
        </Button>
      </div>
      {opened !== null && (
        <BusinessRecordFormDialog schema={schema} open onOpenChange={(isOpen) => !isOpen && setOpened(null)} onSubmit={save} relationOptions={options} initialValueOverrides={opened} />
      )}
    </section>
  )
}

/** A property's details: its Edit, its parties replaced whole. */
export function PropertyCommandsSurface({ record }: RowSurfaceProps) {
  return <EditSurface record={record} module={PROPERTIES_MODULE} schema={PROPERTY_EDIT_FORM} noun="Property" />
}

/** A property group's details: its Edit, its members replaced whole. */
export function PropertyGroupCommandsSurface({ record }: RowSurfaceProps) {
  return <EditSurface record={record} module={PROPERTY_GROUPS_MODULE} schema={PROPERTY_GROUP_EDIT_FORM} noun="Property group" />
}

/** A shared point's details: its Edit, its members replaced whole. */
export function SharedPointCommandsSurface({ record }: RowSurfaceProps) {
  return <EditSurface record={record} module={SHARED_POINTS_MODULE} schema={SHARED_POINT_EDIT_FORM} noun="Shared point" />
}
