"use client"
// Operate › Scale house on the Pilot (M16a of #293): the window's two
// creates and each row's commands. Weigh in opens a ticket at its gross, at
// one of our own stations with a weighbridge, for an account customer under
// one of its agreements in the ticket's project or a walk-in; Register tare
// adds a vehicle's weight empty to the register. An open ticket's details
// offer Weigh out — the tare from a second pass or the register, and the load
// split into up to three lines — and Void; a completed one Void, unless it is
// one of our own vehicles' and its route's unload; a tare Re-weigh and Retire,
// or Take back once retired. The API holds the rules and answers each at its
// field. A line may name the window's product, by the tonne or the cubic
// metre, and a completed ticket's details read what it comes to (M16b of
// #293): a read of the API's, nothing stored and nothing paid.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useApiClient } from "@/components/waste/api-session-store"
import { useModuleRecords, useServerModuleState, useServerResolver } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { useCommandRunner, useModuleReady, useRelationPickers, type RelationPickers } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { unloadingStationAdapter } from "@/lib/api/records/places"
import { problemOfError } from "@/lib/api/records/server-records"
import {
  amountDueOf,
  COMPLETE_TICKET,
  REACTIVATE_TARE,
  RETIRE_TARE,
  REWEIGH_TARE,
  tareCommandsOffered,
  ticketCommandsOffered,
  VOID_TICKET,
  vehicleTareAdapter,
} from "@/lib/api/records/scale-house"
import { AGREEMENTS_MODULE, isAgreementRecord } from "@/lib/data/agreements"
import { DEPOTS_MODULE } from "@/lib/data/allocations"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { mintedRecord } from "@/lib/data/containers"
import { BLOCK_REASON_LABELS, isProductRecord, PRODUCTS_MODULE } from "@/lib/data/commercial"
import { masterDataKindOf } from "@/lib/data/master-data-kinds"
import { formatMinor } from "@/lib/commercial/money"
import type { ScaleTicketAmountDue } from "@waste/contracts/scale-house"
import { recordsForProject } from "@/lib/data/project-scope"
import { REWEIGH_FORM, SCALE_HOUSE_MODULE, SCALE_TICKET_RECORD_KIND, TARE_FORM, VEHICLE_TARE_RECORD_KIND, VOID_TICKET_FORM, WEIGH_IN_FORM, WEIGH_OUT_FORM } from "@/lib/data/scale-house"

const MASTER_MODULE = { workspaceId: "configure", moduleId: "master" } as const

const optionOf = (record: BusinessRecord): BusinessFormOption => ({ value: record.id, label: record.name })

/** The pickers Weigh in reads: our own stations with a weighbridge for the site, the project's agreements of the customer picked, the rest the command surfaces' own. */
function useWindowPickers(): RelationPickers {
  const pickers = useRelationPickers()
  const places = useModuleRecords(DEPOTS_MODULE.workspaceId, DEPOTS_MODULE.moduleId)
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)
  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues): readonly BusinessFormOption[] => {
    if (field.id === "unloadingStationId") {
      return places.records.filter((record) => unloadingStationAdapter.owns(record) && record.submittedValues?.ownership === "company" && record.submittedValues?.weighbridgeAvailable === true).map(optionOf)
    }
    if (field.id === "agreementId") {
      const project = projectId ?? (typeof values.projectId === "string" && values.projectId !== "" ? values.projectId : undefined)
      const customer = typeof values.customerId === "string" ? values.customerId : ""
      return recordsForProject(agreements.records.filter(isAgreementRecord), project)
        .filter((record) => customer === "" || record.submittedValues?.customerId === customer)
        .map(optionOf)
    }
    return pickers.options(field, values, projectId, opened)
  }
  return { ...pickers, options }
}

/** The window's two creates: Weigh in, the module's primary action, and Register tare beside it. */
export function ScaleHousePrimarySurface({ label }: PrimarySurfaceProps) {
  const pickers = useWindowPickers()
  return (
    <div className="flex flex-wrap gap-2">
      <CreateSurface
        label={label}
        module={SCALE_HOUSE_MODULE}
        schema={WEIGH_IN_FORM}
        pickers={pickers}
        make={(values, now) => mintedRecord({ id: `scale-house-scale-ticket-${now}`, name: String(values.vehiclePlate ?? ""), status: "Weighed in", recordKind: SCALE_TICKET_RECORD_KIND, values })}
        created={(record) => ({ title: "Weighed in", description: `${record.name} is on the scale's open tickets.` })}
      />
      <CreateSurface
        label="Register tare"
        module={SCALE_HOUSE_MODULE}
        schema={TARE_FORM}
        pickers={pickers}
        make={(values, now) => mintedRecord({ id: `scale-house-vehicle-tare-${now}`, name: String(values.plate ?? ""), status: "Active", recordKind: VEHICLE_TARE_RECORD_KIND, values })}
        created={(record) => ({ title: "Tare registered", description: `${record.name} is found at the window by its plate.` })}
      />
    </div>
  )
}

type FormName = typeof COMPLETE_TICKET | typeof VOID_TICKET | typeof REWEIGH_TARE | typeof RETIRE_TARE | typeof REACTIVATE_TARE

const LABELS: Readonly<Record<FormName, string>> = {
  [COMPLETE_TICKET]: "Weigh out",
  [VOID_TICKET]: "Void",
  [REWEIGH_TARE]: "Re-weigh",
  [RETIRE_TARE]: "Retire",
  [REACTIVATE_TARE]: "Take back",
}

const DONE: Readonly<Record<FormName, string>> = {
  [COMPLETE_TICKET]: "Ticket completed",
  [VOID_TICKET]: "Ticket voided",
  [REWEIGH_TARE]: "Tare re-weighed",
  [RETIRE_TARE]: "Tare retired",
  [REACTIVATE_TARE]: "Tare taken back",
}

/** A ticket's Weigh out and Void, or a tare's Re-weigh, Retire and Take back; the fraction pickers of Weigh out from the master data's. */
export function ScaleHouseRowSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(SCALE_HOUSE_MODULE)
  const { busy, run } = useCommandRunner(SCALE_HOUSE_MODULE, record.id)
  const [open, setOpen] = useState<FormName | null>(null)
  const master = useServerModuleState(MASTER_MODULE.workspaceId, MASTER_MODULE.moduleId)
  const tare = vehicleTareAdapter.owns(record)
  const offered = (tare ? tareCommandsOffered(record) : ticketCommandsOffered(record)) as FormName[]
  const fractionOptions: BusinessFormOption[] = (master?.records ?? []).filter((row) => masterDataKindOf(row) === "waste-fraction").map(optionOf)
  // The window's products (M16b of #293): the ticket's project's, sold by the tonne or the cubic metre.
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId)
  const project = record.projectIds?.[0]
  const productOptions: BusinessFormOption[] = recordsForProject(products.records.filter(isProductRecord), project)
    .filter((row) => row.submittedValues?.priceUnit === "tonne" || row.submittedValues?.priceUnit === "m3")
    .map((row) => ({ value: row.id, label: `${row.name} · ${row.submittedValues?.priceUnit === "m3" ? "per m³" : "per tonne"}` }))

  // Weigh out's fraction pickers are this window's: the form is the schema with them filled in.
  const forms: Partial<Record<FormName, BusinessFormSchema>> = {
    [COMPLETE_TICKET]: {
      ...WEIGH_OUT_FORM,
      sections: WEIGH_OUT_FORM.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => (field.id.startsWith("fraction") ? { ...field, options: fractionOptions } : field.id.startsWith("product") ? { ...field, options: productOptions } : field)),
      })),
    },
    [VOID_TICKET]: VOID_TICKET_FORM,
    [REWEIGH_TARE]: REWEIGH_FORM,
  }

  const send = (name: FormName, values: BusinessFormValues | undefined) =>
    run(name, values, (outcome) => {
      setOpen(null)
      toast.success(DONE[name], { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })

  return (
    <section className="space-y-3" data-testid="scale-house-commands">
      <h3 className="text-sm font-semibold">{tare ? "Registered tare" : "Scale ticket"}</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The window is being read from the API; its commands follow.</p>}
      {offered.length === 0 && moduleReady && <p className="text-sm text-muted-foreground">{record.description}</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => (forms[name] === undefined ? send(name, undefined) : setOpen(name))}>
            {LABELS[name]}
          </Button>
        ))}
      </div>
      {!tare && record.submittedValues?.status === "completed" && <AmountDue record={record} />}
      {open !== null && forms[open] !== undefined && (
        <BusinessRecordFormDialog
          schema={forms[open]!}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => send(open, values)}
          relationOptions={(field) => field.options ?? []}
        />
      )}
    </section>
  )
}

type AmountRead = { status: "idle" } | { status: "reading" } | { status: "read"; answer: ScaleTicketAmountDue } | { status: "refused"; sentence: string }

/** What a completed ticket comes to at the window, read from the API when asked: each line priced as Finance would, or why it has no price, and the total. */
function AmountDue({ record }: RowSurfaceProps) {
  const client = useApiClient()
  const resolver = useServerResolver()
  const [read, setRead] = useState<AmountRead>({ status: "idle" })
  const ask = () => {
    const serverId = resolver.serverIdOf(record.id)
    if (client === null || serverId === undefined) {
      setRead({ status: "refused", sentence: "The ticket is not one the API holds yet." })
      return
    }
    setRead({ status: "reading" })
    amountDueOf(client, serverId).then(
      (answer) => setRead({ status: "read", answer }),
      (error: unknown) => setRead({ status: "refused", sentence: problemSentence(problemOfError(error)) }),
    )
  }
  const answer = read.status === "read" ? read.answer : null
  const money = (minor: number | null) => (minor === null || answer?.currency == null ? "—" : formatMinor(minor, answer.currency))
  return (
    <div className="space-y-2" data-testid="scale-ticket-amount-due">
      <Button variant="outline" size="sm" disabled={read.status === "reading"} onClick={ask}>
        {answer === null ? "Amount due" : "Read again"}
      </Button>
      {read.status === "refused" && <p className="text-sm text-destructive">{read.sentence}</p>}
      {answer !== null && (
        <div className="space-y-1 text-sm">
          {answer.lines.map((line, index) => (
            <p key={line.lineId}>
              Line {index + 1}: {line.blockReason === null ? `${line.quantity ?? ""} → ${money(line.netMinor)}` : BLOCK_REASON_LABELS[line.blockReason]}
            </p>
          ))}
          <p className="font-semibold">
            Total {money(answer.totalMinor)} (VAT {money(answer.vatMinor)}){answer.complete ? "" : " — not every line is priced"}
          </p>
        </div>
      )}
    </div>
  )
}
