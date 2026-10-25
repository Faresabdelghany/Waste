"use client"
// Billable events, billing runs and invoices on the Pilot (Issue #185, slice
// 10 of #81, for #148): the command surfaces of `commercial.events`,
// `.billing` and `.invoices`.
//
// Events: Add manual event creates one through the store, and an event's
// details offer the commands the API moves it by from its status
// (`eventCommandsOffered`, #281: reprice a blocked one, cancel a blocked or a
// ready one) — never one its status refuses — and Explain price, the price
// rows' own dialog opened on the event's question (`eventQuestion`, #259):
// why it costs what it costs, or why it is blocked.
//
// Billing runs: Run billing asks the project and the period, previews the run
// through the client (`POST /billing-runs/preview` writes nothing), shows the
// counts, the totals per currency and the payers it would exclude, and only
// then runs it through the store's create; once the run has landed, the
// events it invoiced and the invoices it issued are read again
// (`refreshModule`). A run's details read it back with its exclusions and
// the invoices it issued, each opening its invoice, and their totals per
// currency.
//
// Invoices: a document's details read it with its lines by position and the
// credit notes naming it; an invoice offers New credit note — every line by
// what remains of it, or the named lines by quantity — a create in this
// module (lib/api/records/billing.ts), after which the invoice and the
// module are read again, the invoice's standing and the new note with them.
// A credit note is not credited, so it offers none.
import { useState } from "react"
import { toast } from "sonner"
import type { BillingRunCreate, BillingRunDetail, BillingRunPreview } from "@waste/contracts/billing"
import type { Invoice, InvoiceDetail } from "@waste/contracts/invoices"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useCommercialPickers, useCommercialResolver } from "@/components/waste/commands/commercial-pickers"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ExplainPrice } from "@/components/waste/commands/pricing-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useOpenRecord, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { isLocalRefusal, moduleKeyOf, webIdOf } from "@/lib/api/records/adapter"
import { billingRunBody, billingRunDetail, billingRunInvoices, eventCommandsOffered, eventPricedByList, eventQuestion, invoiceDetail, invoiceDocument, previewBillingRun } from "@/lib/api/records/billing"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { PICKUPS_MODULE } from "@/lib/api/records/pickups"
import { problemOfError, resolverOver, type ModuleState } from "@/lib/api/records/server-records"
import { formatMinor } from "@/lib/commercial/money"
import { AGREEMENTS_MODULE } from "@/lib/data/agreements"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { downloadBlob } from "@/lib/data/csv"
import { BILLING_MODULE, EVENTS_MODULE, INVOICE_PREFIX, INVOICES_MODULE, PRICE_ROWS_MODULE, ROUTES_MODULE_LOCATION } from "@/lib/data/commercial"
import {
  blankNone,
  createBillingRunRecord,
  createCreditNoteRecord,
  createEventRecord,
  creditNoteForm,
  EVENT_COMMAND_FORMS,
  EVENT_FORM,
  remainingByLine,
  RUN_BILLING_FORM,
  type EventCommand,
} from "@/lib/data/commercial-forms"
import { CONTACTS_MODULE } from "@/lib/data/properties"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"

// ---------------------------------------------------------------------------
// Billable events
// ---------------------------------------------------------------------------

/** Add manual event: the office's entry, priced by the agreement's list or at a price of the person's own. */
export function AddManualEventSurface({ label }: PrimarySurfaceProps) {
  const pickers = useCommercialPickers()
  return (
    <CreateSurface
      label={label}
      module={EVENTS_MODULE}
      schema={EVENT_FORM}
      pickers={pickers}
      make={(values, now) => createEventRecord(values, now)}
      created={() => ({ title: "Event added", description: "It is priced by the agreement's list, or blocked with what to put right: its status says which." })}
    />
  )
}

/** What each command is told once the API has taken it. */
const EVENT_DONE: Readonly<Record<EventCommand, string>> = { reprice: "Event repriced", cancel: "Event cancelled" }

/** What a command the API took is told: a reprice that leaves the event blocked says what still blocks it. */
function eventDone(name: EventCommand, record: { name: string; status: string; value: string }): void {
  if (name === "reprice" && record.status === "Blocked") {
    toast.info("Still blocked", { description: `${record.name}: ${record.value}. Put it right, then reprice it again.` })
    return
  }
  toast.success(EVENT_DONE[name], { description: `${record.name} is now ${record.status.toLowerCase()}${record.value === "" ? "" : `: ${record.value}`}.` })
}

/** The modules an event's price question is read through (`eventQuestion`): its agreement and customer, the price rows, its route, scheme, pickup and container. */
const QUESTION_MODULES = [AGREEMENTS_MODULE, CONTACTS_MODULE, PRICE_ROWS_MODULE, ROUTES_MODULE_LOCATION, ROUTE_SCHEMES_MODULE, PICKUPS_MODULE, CONTAINERS_MODULE] as const

/** An event's price question, asked of the store as it holds those modules when Explain price opens. */
function useEventQuestion(record: BusinessRecord): () => BusinessFormValues {
  const states = [
    useServerModuleState(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId),
    useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId),
    useServerModuleState(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId),
    useServerModuleState(ROUTES_MODULE_LOCATION.workspaceId, ROUTES_MODULE_LOCATION.moduleId),
    useServerModuleState(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId),
    useServerModuleState(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId),
    useServerModuleState(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId),
  ]
  return () => {
    const held = QUESTION_MODULES.flatMap((location, index): [string, ModuleState][] => {
      const state = states[index]
      return state === null ? [] : [[moduleKeyOf(location.workspaceId, location.moduleId), state]]
    })
    return eventQuestion(record, resolverOver(new Map(held)))
  }
}

/** The commands an event's status moves it by and, where its price is a list's, Explain price on its own question, in its details. */
export function EventCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useCommercialPickers()
  const moduleReady = useModuleReady(EVENTS_MODULE)
  const { busy, run } = useCommandRunner(EVENTS_MODULE, record.id)
  const question = useEventQuestion(record)
  const [open, setOpen] = useState<EventCommand | null>(null)
  const offered = eventCommandsOffered(record)

  const send = (name: EventCommand, values: BusinessFormValues) =>
    run(name, blankNone(values), (outcome) => {
      setOpen(null)
      eventDone(name, outcome.record)
    })

  return (
    <section className="space-y-3" data-testid="event-commands">
      <h3 className="text-sm font-semibold">Event commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The events are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(EVENT_COMMAND_FORMS[name])} onClick={() => setOpen(name)}>
            {EVENT_COMMAND_FORMS[name].submitLabel}
          </Button>
        ))}
        {eventPricedByList(record) && <ExplainPrice initial={question} />}
      </div>
      {/* Asked only while the status still moves the event by it: a re-read or another desk may have moved it since. */}
      {open !== null && offered.includes(open) && (
        <BusinessRecordFormDialog schema={EVENT_COMMAND_FORMS[open]} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => send(open, values)} relationOptions={(field, values) => pickers.options(field, values, record.projectIds?.[0], {})} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Billing runs
// ---------------------------------------------------------------------------

/** A payer the store holds, by server id: its name, or its id chip. */
function useCustomerName(): (serverId: string) => string {
  return useServerNames(CONTACTS_MODULE, "customer")
}

/** Run billing: the period, the preview, then the run. */
export function RunBillingSurface({ label }: PrimarySurfaceProps) {
  const client = useApiClient()
  const { upsertRecord, refreshModule } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const resolve = useCommercialResolver()
  const moduleReady = useModuleReady(BILLING_MODULE)
  const openRecord = useOpenRecord(BILLING_MODULE.moduleId)
  const customerName = useCustomerName()
  const [step, setStep] = useState<"closed" | "period" | "preview">("closed")
  const [values, setValues] = useState<BusinessFormValues>({})
  const [preview, setPreview] = useState<{ body: BillingRunCreate; answer: BillingRunPreview } | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = (submitted: BusinessFormValues) => {
    if (busy || client === null) return
    setValues(submitted)
    const body = billingRunBody(blankNone(submitted), resolve)
    if (isLocalRefusal(body)) {
      toast.error("The run was not previewed", { description: body.message })
      return
    }
    setBusy(true)
    previewBillingRun(client, body)
      .then(
        (answer) => {
          setPreview({ body, answer })
          setStep("preview")
        },
        (error: unknown) => toast.error("The run was not previewed", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  const runIt = () => {
    if (busy || preview === null) return
    const record = createBillingRunRecord(values, Date.now())
    const outcome = upsertRecord(BILLING_MODULE.workspaceId, BILLING_MODULE.moduleId, record)
    setBusy(true)
    whenSaved(
      outcome,
      (saved) => {
        setStep("closed")
        // A run invoices the events it selected and issues the invoices: both are read again.
        void refreshModule(EVENTS_MODULE.workspaceId, EVENTS_MODULE.moduleId)
        void refreshModule(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)
        openRecord(record.id)
        // What the run itself did, which may differ from what its preview said: an event can be put right or billed in between.
        if (saved?.kind === "created") toast.success("Billing run completed", { description: `${saved.record.value} issued for ${preview.body.periodFrom} – ${preview.body.periodTo}.` })
      },
      () => setBusy(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!moduleReady || client === null || !pickers.readyFor(RUN_BILLING_FORM)} onClick={() => setStep("period")}>
        {label}
      </Button>
      {step === "period" && (
        <BusinessRecordFormDialog schema={RUN_BILLING_FORM} open onOpenChange={(isOpen) => !isOpen && setStep("closed")} onSubmit={ask} relationOptions={(field, current) => pickers.options(field, current, undefined, values)} initialValueOverrides={values} />
      )}
      {step === "preview" && preview !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && setStep("closed")}>
          <DialogContent className="sm:max-w-xl" data-testid="billing-preview">
            <DialogHeader>
              <DialogTitle>Run billing</DialogTitle>
              <DialogDescription>
                What a run over {preview.body.periodFrom} – {preview.body.periodTo} would do. Nothing is written until you run it.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Ready events</dt>
              <dd data-testid="preview-events">{preview.answer.eventCount}</dd>
              <dt className="text-muted-foreground">Invoices</dt>
              <dd data-testid="preview-invoices">{preview.answer.invoiceCount}</dd>
              {preview.answer.totals.map((total) => (
                <div key={total.currency} className="contents">
                  <dt className="text-muted-foreground">Total in {total.currency}</dt>
                  <dd>
                    {formatMinor(total.netMinor, total.currency)} + VAT {formatMinor(total.vatMinor, total.currency)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">Excluded customers</h4>
              {preview.answer.exclusions.length === 0 ? (
                <p className="text-sm text-muted-foreground">None: every payer with events in the period is invoiced.</p>
              ) : (
                <ul className="text-sm" data-testid="preview-exclusions">
                  {preview.answer.exclusions.map((exclusion) => (
                    <li key={exclusion.customerId}>
                      {customerName(exclusion.customerId)} · {exclusion.eventCount} event{exclusion.eventCount === 1 ? "" : "s"}, all blocked
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setStep("period")}>
                Back
              </Button>
              <Button disabled={busy || preview.answer.invoiceCount === 0} onClick={runIt}>
                Run billing
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** The run's own read and the invoices it issued, as a one-row history its surface reads. */
const readRun = (client: ApiClient, serverId: string) =>
  Promise.all([billingRunDetail(client, serverId), billingRunInvoices(client, serverId)]).then(([detail, invoices]): { detail: BillingRunDetail; invoices: Invoice[] }[] => [{ detail, invoices }])

/** The totals of a run's invoices, one figure per currency: the run's own sum every currency it touched together. */
function totalsByCurrency(invoices: readonly Invoice[]): { currency: string; netMinor: number; vatMinor: number }[] {
  const totals = new Map<string, { netMinor: number; vatMinor: number }>()
  for (const invoice of invoices) {
    const total = totals.get(invoice.currency) ?? { netMinor: 0, vatMinor: 0 }
    totals.set(invoice.currency, { netMinor: total.netMinor + invoice.netMinor, vatMinor: total.vatMinor + invoice.vatMinor })
  }
  return [...totals].map(([currency, total]) => ({ currency, ...total }))
}

/** A run's details: its exclusions, the invoices it issued, each opening its invoice, and their totals per currency. */
export function BillingRunSurface({ record }: RowSurfaceProps) {
  const read = useRowHistory(BILLING_MODULE.workspaceId, BILLING_MODULE.moduleId, record, 0, readRun)
  const customerName = useCustomerName()
  const openInvoice = useOpenRecord(INVOICES_MODULE.moduleId)
  const run = read.rows?.[0]
  const rowsOf = <T,>(rows: readonly T[] | undefined) => ({ rows: rows === undefined ? null : [...rows], problem: read.problem })
  return (
    <section className="space-y-4" data-testid="billing-run-commands">
      <h3 className="text-sm font-semibold">Billing run</h3>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Totals per currency</h4>
        <ReadRows read={rowsOf(run === undefined ? undefined : totalsByCurrency(run.invoices))} label="Reading the run…" empty="No invoice, so no total." testId="run-totals" line={(total) => `${total.currency}: ${formatMinor(total.netMinor, total.currency)} + VAT ${formatMinor(total.vatMinor, total.currency)}`} />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Excluded customers</h4>
        <ReadRows read={rowsOf(run?.detail.exclusions)} label="Reading the run…" empty="None: no payer was skipped." testId="run-exclusions" line={(exclusion) => `${customerName(exclusion.customerId)} · ${exclusion.eventCount} event${exclusion.eventCount === 1 ? "" : "s"}, all blocked`} />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Invoices issued</h4>
        <ReadRows
          read={rowsOf(run?.invoices)}
          label="Reading the run…"
          empty="None issued."
          testId="run-invoices"
          line={(invoice) => (
            <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => openInvoice(webIdOf(INVOICE_PREFIX, invoice.id))}>
              {invoice.label} · {customerName(invoice.customerId)} · {formatMinor(invoice.grossMinor, invoice.currency)}
            </button>
          )}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------

/** The document's own read, as a one-row history its surface reads again after a credit note. */
const readInvoice = (client: ApiClient, serverId: string) => invoiceDetail(client, serverId).then((detail): InvoiceDetail[] => [detail])

/** An invoice's or a credit note's details: its lines by position, the credit notes naming it, Download PDF (#291 C5), and — on an invoice — New credit note. */
export function InvoiceSurface({ record }: RowSurfaceProps) {
  const client = useApiClient()
  const { upsertRecord, refreshModule } = useBusinessRecordStore()
  const moduleReady = useModuleReady(INVOICES_MODULE)
  const [version, setVersion] = useState(0)
  const read = useRowHistory(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId, record, version, readInvoice)
  const [credit, setCredit] = useState<{ remaining: ReadonlyMap<string, number>; detail: InvoiceDetail } | null>(null)
  const [busy, setBusy] = useState(false)
  const detail = read.rows?.[0]
  const isInvoice = record.submittedValues?.kind === "invoice"
  const money = (minor: number) => formatMinor(minor, detail?.currency ?? record.facts.Currency ?? "DKK")

  const openCredit = async () => {
    if (client === null || detail === undefined || busy) return
    setBusy(true)
    try {
      // What remains of each line is what the credit notes naming it have not credited: they are read whole.
      const notes = await Promise.all(detail.creditNotes.map((note) => invoiceDetail(client, note.id)))
      setCredit({ remaining: remainingByLine(detail, notes), detail })
    } catch (error) {
      toast.error("The invoice's credit notes could not be read", { description: problemSentence(problemOfError(error)) })
    } finally {
      setBusy(false)
    }
  }

  /** The document's PDF, as the API renders it from the rows as issued, saved under its label. */
  const download = async () => {
    const serverId = detail?.id
    if (client === null || serverId === undefined || busy) return
    setBusy(true)
    try {
      const file = await invoiceDocument(client, serverId)
      downloadBlob(file.fileName ?? `${detail?.label ?? record.name}.pdf`, new Blob([file.bytes], { type: file.contentType ?? "application/pdf" }))
    } catch (error) {
      toast.error("The document could not be read", { description: problemSentence(problemOfError(error)) })
    } finally {
      setBusy(false)
    }
  }

  const issue = (values: BusinessFormValues) => {
    if (busy) return
    const note = createCreditNoteRecord(record, values, Date.now())
    setBusy(true)
    whenSaved(
      upsertRecord(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId, note),
      () => {
        setCredit(null)
        setVersion((current) => current + 1)
        // The invoice's standing moves with the note: the module is read again, the note's own row with it.
        void refreshModule(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)
        toast.success("Credit note issued", { description: `${record.name} is credited by the new note.` })
      },
      () => setBusy(false),
    )
  }

  return (
    <section className="space-y-4" data-testid="invoice-commands">
      <h3 className="text-sm font-semibold">{isInvoice ? "Invoice" : "Credit note"}</h3>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || detail === undefined} onClick={() => void download()}>
          Download PDF
        </Button>
        {isInvoice && (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy || detail === undefined || record.status === "Credited"} onClick={() => void openCredit()}>
            New credit note
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Lines</h4>
        {read.problem !== null ? (
          <p className="text-sm text-destructive">{read.problem}</p>
        ) : detail === undefined ? (
          <p className="text-sm text-muted-foreground">Reading the document…</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table data-testid="invoice-lines">
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Line</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Unit price</TableHead>
                  <TableHead>Net</TableHead>
                  <TableHead>VAT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="text-sm">{line.position}</TableCell>
                    <TableCell className="text-sm">{line.description}</TableCell>
                    <TableCell className="text-sm">{line.quantity}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{money(line.unitPriceMinor)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{money(line.netMinor)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {line.vatPercent}% · {money(line.vatMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      {isInvoice && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Credit notes</h4>
          <ReadRows read={{ rows: detail === undefined ? (read.rows === null ? null : []) : detail.creditNotes, problem: read.problem }} label="Reading the document…" empty="No credit note yet." testId="invoice-credit-notes" line={(note) => `${note.label} · ${note.issuedOn} · ${money(note.grossMinor)}`} />
        </div>
      )}
      {credit !== null && (
        <BusinessRecordFormDialog schema={creditNoteForm(record, credit.detail, credit.remaining)} open onOpenChange={(isOpen) => !isOpen && setCredit(null)} onSubmit={issue} relationOptions={(field) => field.options ?? []} />
      )}
    </section>
  )
}
