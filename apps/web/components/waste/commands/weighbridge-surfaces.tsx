"use client"
// Route Studio › Weighbridge on the Pilot (O27 of #290): what an unmatched
// ticket's details offer. Match asks for the route the load came off — one
// that ran, from the routes the account reads, its own project's where the
// ticket's vehicle has one — and the fraction, from the master data's; the
// API holds the station's acceptance and answers its sentence at the field.
// Dismiss asks why. A matched or dismissed ticket offers nothing.
import { useState } from "react"
import { toast } from "sonner"

import { moduleAt } from "@/lib/modules/keys"
import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/platform/business-record-form-dialog"
import { useModuleRecords, useServerModuleState } from "@/components/platform/business-record-store"
import type { RowSurfaceProps } from "@/components/platform/surface-props"
import { ranRoutes } from "@/components/waste/commands/provider-money-surfaces"
import { useCommandRunner, useModuleReady } from "@/components/platform/use-command-support"
import { ROUTES_MODULE } from "@/lib/data/routes"
import { DISMISS_TICKET, MATCH_TICKET, ticketCommandsOffered } from "@/lib/api/records/weighbridge"
import type { BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import { masterDataKindOf } from "@/lib/data/master-data-kinds"
import { DISMISS_FORM, MATCH_FORM, WEIGHBRIDGE_MODULE } from "@/lib/data/weighbridge"
import { waitingSentence } from "@/lib/api/read-state"

const MASTER_MODULE = moduleAt("configure.master")

const FORMS = { [MATCH_TICKET]: MATCH_FORM, [DISMISS_TICKET]: DISMISS_FORM } as const

/** An unmatched ticket's Match and Dismiss; nothing once it is matched or dismissed. */
export function WeighbridgeTicketSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(WEIGHBRIDGE_MODULE)
  const { busy, run } = useCommandRunner(WEIGHBRIDGE_MODULE, record.id)
  const [open, setOpen] = useState<keyof typeof FORMS | null>(null)
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
  const master = useServerModuleState(MASTER_MODULE.workspaceId, MASTER_MODULE.moduleId)
  const offered = ticketCommandsOffered(record) as (keyof typeof FORMS)[]
  const project = record.projectIds?.[0]

  // A ticket of a known vehicle is matched within its project; one of no known vehicle to any route that ran.
  const routeOptions: BusinessFormOption[] = ranRoutes(routes.records)
    .filter((route) => project === undefined || (route.projectIds ?? []).includes(project))
    .map((route) => ({ value: route.id, label: `${route.name} · ${route.status}` }))
  const fractionOptions: BusinessFormOption[] = (master?.records ?? []).filter((row) => masterDataKindOf(row) === "waste-fraction").map((row) => ({ value: row.id, label: row.name }))

  // The two pickers' options are this ticket's: the form is the schema with them filled in.
  const forms = {
    [MATCH_TICKET]: {
      ...MATCH_FORM,
      sections: MATCH_FORM.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => (field.id === "routeId" ? { ...field, options: routeOptions } : field.id === "wasteFractionId" ? { ...field, options: fractionOptions } : field)),
      })),
    },
    [DISMISS_TICKET]: DISMISS_FORM,
  }

  const send = (name: keyof typeof FORMS, values: BusinessFormValues) =>
    run(name, values, (outcome) => {
      setOpen(null)
      toast.success(FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })

  return (
    <section className="space-y-3" data-testid="weighbridge-ticket-commands">
      <h3 className="text-sm font-semibold">Weighbridge ticket</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">{waitingSentence("tickets", "their commands follow")}</p>}
      {offered.length === 0 && moduleReady && <p className="text-sm text-muted-foreground">{record.description}</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen(name)}>
            {FORMS[name].submitLabel}
          </Button>
        ))}
      </div>
      {open !== null && (
        <BusinessRecordFormDialog
          schema={forms[open]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => send(open, values)}
          relationOptions={(field) => field.options ?? []}
        />
      )}
    </section>
  )
}
