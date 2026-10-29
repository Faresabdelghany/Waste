"use client"
// Customers › Right-sizing on the Pilot (M23b of #293). The module's primary
// is Propose now: the night's run over the person's projects, through the
// client, the module read again once it lands. An open proposal's details
// offer Approve — for a size, the day and the product, the suggested one
// picked, from the project's active products; for a frequency, a decision
// alone — and Dismiss with why. A decided proposal offers nothing.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useApiClient } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { APPROVE_PROPOSAL, approveChangesTheProduct, DISMISS_PROPOSAL, proposalCommandsOffered, runRightSizing } from "@/lib/api/records/right-sizing"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { APPROVE_SIZE_FORM, DISMISS_FORM, RIGHT_SIZING_MODULE } from "@/lib/data/right-sizing"

const NO_PRODUCTS: readonly BusinessRecord[] = []

/** Propose now: the run over the person's projects. */
export function ProposeRightSizingSurface({ label }: PrimarySurfaceProps) {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const [running, setRunning] = useState(false)
  const propose = async () => {
    if (client === null) return
    setRunning(true)
    try {
      const proposed = await runRightSizing(client)
      await refreshModule(RIGHT_SIZING_MODULE.workspaceId, RIGHT_SIZING_MODULE.moduleId)
      toast.success(proposed === 0 ? "Nothing new to propose" : `${proposed} proposal${proposed === 1 ? "" : "s"} made`)
    } catch (error) {
      toast.error("Right-sizing did not run", { description: problemSentence(problemOfError(error)) })
    } finally {
      setRunning(false)
    }
  }
  return (
    <Button size="sm" disabled={running || client === null} onClick={() => void propose()}>
      {running ? "Proposing…" : label}
    </Button>
  )
}

/** An open proposal's Approve and Dismiss; nothing once decided. */
export function RightSizingSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(RIGHT_SIZING_MODULE)
  const { busy, run } = useCommandRunner(RIGHT_SIZING_MODULE, record.id)
  const [open, setOpen] = useState<"approve" | "dismiss" | null>(null)
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, NO_PRODUCTS)
  const offered = proposalCommandsOffered(record)
  const sized = approveChangesTheProduct(record)
  const project = record.projectIds?.[0]
  const suggested = typeof record.submittedValues?.suggestedProductId === "string" ? record.submittedValues.suggestedProductId : ""

  // The project's active products, the size the proposal suggests among them and picked.
  const productOptions: BusinessFormOption[] = products.records
    .filter((row) => (project === undefined || (row.projectIds ?? []).includes(project)) && (row.status === "Active" || row.id === suggested))
    .map((row) => ({ value: row.id, label: row.name }))
  const approveForm = {
    ...APPROVE_SIZE_FORM,
    sections: APPROVE_SIZE_FORM.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (field.id === "productId" ? { ...field, options: productOptions, defaultValue: suggested } : field)),
    })),
  }

  const send = (name: string, values: BusinessFormValues, message: string) =>
    run(name, values, () => {
      setOpen(null)
      toast.success(message)
    })

  return (
    <section className="space-y-3" data-testid="right-sizing-commands">
      <h3 className="text-sm font-semibold">Right-sizing</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The proposals are being read from the API; their commands follow.</p>}
      {offered.length === 0 && moduleReady && <p className="text-sm text-muted-foreground">{record.description}</p>}
      {offered.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => (sized ? setOpen("approve") : send(APPROVE_PROPOSAL, {}, "Proposal approved"))}>
            Approve
          </Button>
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("dismiss")}>
            Dismiss
          </Button>
        </div>
      )}
      {open === "approve" && (
        <BusinessRecordFormDialog
          schema={approveForm}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => send(APPROVE_PROPOSAL, values, "Proposal approved")}
          relationOptions={(field) => field.options ?? []}
        />
      )}
      {open === "dismiss" && (
        <BusinessRecordFormDialog schema={DISMISS_FORM} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => send(DISMISS_PROPOSAL, values, "Proposal dismissed")} relationOptions={(field) => field.options ?? []} />
      )}
    </section>
  )
}
