"use client"
// A command surface's primary action that creates a row (Issue #181): the
// button, a form of the module's own, the write through the record store —
// the dialog open until the API has answered, the API's refusal the store's
// toast over the form still holding what was typed — and the row made opened
// in the workspace's details, as the generic create path opens what it made.
// Offered only while the module reads the API's rows and every module the
// form picks from has answered.
import { useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import { useModuleReady, useOpenRecord, useRelationPickers } from "@/components/waste/commands/use-command-support"
import type { BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"

export function CreateSurface({
  label,
  module,
  schema,
  make,
  created,
}: {
  label: string
  module: ModuleLocation
  schema: BusinessFormSchema
  /** The row the form's values make, minted for the session. */
  make: (values: BusinessFormValues, now: number) => BusinessRecord
  /** What the person is told once the API has taken it. */
  created: (record: BusinessRecord) => { title: string; description: string }
}) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(module)
  const openRecord = useOpenRecord(module.moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = make(values, Date.now())
    setSaving(true)
    whenSaved(
      upsertRecord(module.workspaceId, module.moduleId, record),
      () => {
        setOpen(false)
        openRecord(record.id)
        const said = created(record)
        toast.success(said.title, { description: said.description })
      },
      () => setSaving(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!moduleReady || !pickers.readyFor(schema) || saving} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      {/* A create opens with nothing to keep: a pick no longer offered — made before the project changed — is flagged, not kept. */}
      <BusinessRecordFormDialog schema={schema} open={open} onOpenChange={setOpen} onSubmit={submit} relationOptions={(field, values) => pickers.options(field, values, undefined, {})} />
    </>
  )
}
