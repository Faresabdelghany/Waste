"use client"
// Payments on the Pilot (#291 slice 6, #292 C6w): the command surfaces of
// `commercial.payments`, and a customer's statement in `customers.contacts`.
//
// Register payment creates one through the store, and the invoices are read
// again once the API has it, since what it pays moves their standing. Import
// bank statement asks the project unmatched money lands in, reads our own CSV
// in the browser (`bankFileOf`, @waste/domain/finance/payments), and asks the
// API for a dry run of its lines a batch at a time: each line's outcome — the
// invoice it pays and how it was found, unmatched, or a line a statement
// already brought — beside the rows the file could not read. Only then does
// Import write them; the payments and the invoices are read again after.
//
// A payment's details read it with its allocations, each undone by Undo
// match while it stands, and offer Match to invoice while anything of it
// remains. A customer's details offer Statement: the days and the currency,
// then its lines from the opening balance to the closing one.
import { useState } from "react"
import { toast } from "sonner"
import type { BankLine as WireBankLine, BankLineResult, CustomerStatement, PaymentAllocation, PaymentDetail } from "@waste/contracts/payments"
import { bankFileOf, type BankFile } from "@waste/domain/finance/payments"
import { IMPORT_BATCH_MAX } from "@waste/domain/imports/vocabulary"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useServerModuleState } from "@/components/waste/business-record-store"
import { useCommercialPickers, useCommercialResolver } from "@/components/waste/commands/commercial-pickers"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { customerStatement, importBankLines, paymentDetail, wireLinesOf } from "@/lib/api/records/payments"
import { problemOfError } from "@/lib/api/records/server-records"
import { formatMinor } from "@/lib/commercial/money"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { INVOICES_MODULE, PAYMENTS_MODULE } from "@/lib/data/commercial"
import { allocateForm, BANK_IMPORT_FORM, blankNone, createPaymentRecord, PAYMENT_FORM, STATEMENT_FORM, text } from "@/lib/data/commercial-forms"
import { CONTACTS_MODULE } from "@/lib/data/properties"

// ---------------------------------------------------------------------------
// Register payment and Import bank statement
// ---------------------------------------------------------------------------

/** The module's two primaries: a payment by hand, and a bank statement's lines. */
export function PaymentsPrimarySurface({ label }: PrimarySurfaceProps) {
  const pickers = useCommercialPickers()
  const { refreshModule } = useBusinessRecordStore()
  return (
    <div className="flex flex-wrap gap-2">
      <CreateSurface
        label={label}
        module={PAYMENTS_MODULE}
        schema={PAYMENT_FORM}
        pickers={pickers}
        make={createPaymentRecord}
        created={() => ({ title: "Payment registered", description: "The invoice it names is paid what it owes at most; the rest is a credit on the payer's balance." })}
        // What it paid moves the invoice's standing.
        onCreated={() => void refreshModule(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)}
      />
      <ImportBankStatement />
    </div>
  )
}

/** A file's lines in batches the API takes, without the key the server computes again. */
function batchesOf(file: BankFile): WireBankLine[][] {
  const lines = wireLinesOf(file)
  const batches: WireBankLine[][] = []
  for (let start = 0; start < lines.length; start += IMPORT_BATCH_MAX) batches.push(lines.slice(start, start + IMPORT_BATCH_MAX))
  return batches
}

/** Every batch of the file, one after another, a dry run or the import itself; the lines' outcomes in the file's order. */
async function sendLines(client: ApiClient, projectId: string, file: BankFile, dryRun: boolean): Promise<BankLineResult[]> {
  const outcomes: BankLineResult[] = []
  for (const lines of batchesOf(file)) outcomes.push(...(await importBankLines(client, { projectId, dryRun, lines })).lines)
  return outcomes
}

/** How a line's outcome reads. */
function outcomeText(outcome: BankLineResult, invoiceName: (serverId: string) => string, currency: string): string {
  if (outcome.outcome === "duplicate") return "Imported already"
  if (outcome.outcome === "unmatched" || outcome.invoiceId === null) return "Unmatched: the office matches it"
  return `${invoiceName(outcome.invoiceId)} by its ${outcome.by === "reference" ? "payment reference" : "label"}, ${formatMinor(outcome.allocatedMinor, currency)}`
}

function ImportBankStatement() {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const resolve = useCommercialResolver()
  const moduleReady = useModuleReady(PAYMENTS_MODULE)
  const invoiceName = useServerNames(INVOICES_MODULE, "invoice")
  const [step, setStep] = useState<"closed" | "project" | "file">("closed")
  const [projectId, setProjectId] = useState<string | null>(null)
  const [read, setRead] = useState<{ name: string; file: BankFile } | null>(null)
  const [outcomes, setOutcomes] = useState<BankLineResult[] | null>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setStep("closed")
    setRead(null)
    setOutcomes(null)
  }

  const askProject = (values: BusinessFormValues) => {
    const webId = text(blankNone(values), "projectId")
    const serverId = webId === "" ? undefined : resolve.serverIdOf(webId)
    if (serverId === undefined) {
      toast.error("Pick a project the API holds")
      return
    }
    setProjectId(serverId)
    setStep("file")
  }

  const choose = async (picked: File | undefined) => {
    if (picked === undefined || client === null || projectId === null || busy) return
    const file = bankFileOf(await picked.text())
    setRead({ name: picked.name, file })
    setOutcomes(null)
    if (file.lines.length === 0) return
    setBusy(true)
    try {
      setOutcomes(await sendLines(client, projectId, file, true))
    } catch (error) {
      toast.error("The statement was not read", { description: problemSentence(problemOfError(error)) })
    } finally {
      setBusy(false)
    }
  }

  const importIt = async () => {
    if (client === null || projectId === null || read === null || busy) return
    setBusy(true)
    try {
      const done = await sendLines(client, projectId, read.file, false)
      const count = (outcome: BankLineResult["outcome"]) => done.filter((line) => line.outcome === outcome).length
      void refreshModule(PAYMENTS_MODULE.workspaceId, PAYMENTS_MODULE.moduleId)
      void refreshModule(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)
      close()
      toast.success("Bank statement imported", { description: `${count("matched")} matched, ${count("unmatched")} unmatched, ${count("duplicate")} imported already.` })
    } catch (error) {
      // A batch the API took stays taken: importing the file again adds only what it has not.
      void refreshModule(PAYMENTS_MODULE.workspaceId, PAYMENTS_MODULE.moduleId)
      toast.error("The statement was not imported whole", { description: `${problemSentence(problemOfError(error))} Import it again: the lines already in are recognised.` })
    } finally {
      setBusy(false)
    }
  }

  const byRow = new Map(read?.file.lines.map((line) => [line.row, line]) ?? [])
  return (
    <>
      <Button size="sm" variant="outline" disabled={!moduleReady || client === null || !pickers.readyFor(BANK_IMPORT_FORM)} onClick={() => setStep("project")}>
        Import bank statement
      </Button>
      {step === "project" && <BusinessRecordFormDialog schema={BANK_IMPORT_FORM} open onOpenChange={(isOpen) => !isOpen && close()} onSubmit={askProject} relationOptions={(field, values) => pickers.options(field, values, undefined, {})} />}
      {step === "file" && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && close()}>
          <DialogContent className="sm:max-w-3xl" data-testid="bank-import">
            <DialogHeader>
              <DialogTitle>Import bank statement</DialogTitle>
              <DialogDescription>Our CSV: booked_on, amount, currency, reference and text, separated by semicolons. You see what each line would be first; nothing is written until you import it.</DialogDescription>
            </DialogHeader>
            <input type="file" accept=".csv,text/csv" aria-label="Bank statement file" disabled={busy} onChange={(event) => void choose(event.target.files?.[0])} />
            {read !== null && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground" data-testid="bank-import-summary">
                  {read.name}: {read.file.lines.length} incoming line{read.file.lines.length === 1 ? "" : "s"}, {read.file.skipped.length} outgoing skipped, {read.file.refusals.length} not read.
                </p>
                {read.file.refusals.length > 0 && (
                  <ul className="text-sm text-destructive" data-testid="bank-import-refusals">
                    {read.file.refusals.map((refusal) => (
                      <li key={refusal.row}>
                        Row {refusal.row}: {refusal.message}
                      </li>
                    ))}
                  </ul>
                )}
                {busy && outcomes === null && <p className="text-sm text-muted-foreground">Matching the lines…</p>}
                {outcomes !== null && (
                  <div className="max-h-80 overflow-auto rounded-lg border border-border/60">
                    <Table data-testid="bank-import-lines">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Row</TableHead>
                          <TableHead>Booked</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Reference or text</TableHead>
                          <TableHead>Would be</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {outcomes.map((outcome) => {
                          const line = byRow.get(outcome.row)
                          return (
                            <TableRow key={outcome.row}>
                              <TableCell className="text-sm">{outcome.row}</TableCell>
                              <TableCell className="whitespace-nowrap text-sm">{line?.bookedOn}</TableCell>
                              <TableCell className="whitespace-nowrap text-sm">{line === undefined ? "" : formatMinor(line.amountMinor, line.currency)}</TableCell>
                              <TableCell className="text-sm">{line?.reference || line?.text}</TableCell>
                              <TableCell className="text-sm">{outcomeText(outcome, invoiceName, line?.currency ?? "DKK")}</TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setStep("project")}>
                Back
              </Button>
              <Button disabled={busy || outcomes === null || outcomes.every((outcome) => outcome.outcome === "duplicate")} onClick={() => void importIt()}>
                Import
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// A payment's details
// ---------------------------------------------------------------------------

const readPayment = (client: ApiClient, serverId: string) => paymentDetail(client, serverId).then((detail): PaymentDetail[] => [detail])

/** The allocations still standing: neither a reversal nor one a reversal names. */
function standing(allocations: readonly PaymentAllocation[]): Set<string> {
  const reversed = new Set(allocations.flatMap((allocation) => (allocation.reversesAllocationId === null ? [] : [allocation.reversesAllocationId])))
  return new Set(allocations.filter((allocation) => allocation.reversesAllocationId === null && !reversed.has(allocation.id)).map((allocation) => allocation.id))
}

/** A payment's allocations, each undone by Undo match while it stands, and Match to invoice while anything remains. */
export function PaymentCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useCommercialPickers()
  const moduleReady = useModuleReady(PAYMENTS_MODULE)
  const { busy, version, run } = useCommandRunner(PAYMENTS_MODULE, record.id)
  const read = useRowHistory(PAYMENTS_MODULE.workspaceId, PAYMENTS_MODULE.moduleId, record, version, readPayment)
  const invoiceName = useServerNames(INVOICES_MODULE, "invoice")
  const [matching, setMatching] = useState(false)
  const detail = read.rows?.[0]
  const live = standing(detail?.allocations ?? [])
  const money = (minor: number) => formatMinor(minor, detail?.currency ?? record.facts.Currency ?? "DKK")
  const remains = detail === undefined ? record.status !== "Allocated" : detail.unallocatedMinor > 0

  const match = (values: BusinessFormValues) =>
    run("allocate", blankNone(values), (outcome) => {
      setMatching(false)
      toast.success("Payment matched", { description: `${outcome.record.name}: ${outcome.record.facts.Unallocated ?? ""} remains unallocated.` })
    })
  const undo = (allocation: PaymentAllocation) =>
    run("reverse", { allocationId: allocation.id }, () => toast.success("Match undone", { description: `${invoiceName(allocation.invoiceId)} owes ${money(allocation.amountMinor)} again.` }))

  return (
    <section className="space-y-3" data-testid="payment-commands">
      <h3 className="text-sm font-semibold">Payment</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The payments are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy || !remains || !pickers.readyFor(allocateForm(record))} onClick={() => setMatching(true)}>
          Match to invoice
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Allocations</h4>
        <ReadRows
          read={{ rows: detail === undefined ? null : detail.allocations, problem: read.problem }}
          label="Reading the payment…"
          empty="Matched to no invoice yet."
          testId="payment-allocations"
          line={(allocation) => (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {invoiceName(allocation.invoiceId)} · {money(allocation.amountMinor)}
                {allocation.reversesAllocationId !== null ? " · undoes a match" : live.has(allocation.id) ? "" : " · undone"}
              </span>
              {live.has(allocation.id) && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => undo(allocation)}>
                  Undo match
                </Button>
              )}
            </span>
          )}
        />
      </div>
      {matching && <BusinessRecordFormDialog schema={allocateForm(record)} open onOpenChange={(isOpen) => !isOpen && setMatching(false)} onSubmit={match} relationOptions={(field, values) => pickers.options(field, values, record.projectIds?.[0], {})} />}
    </section>
  )
}

// ---------------------------------------------------------------------------
// A customer's statement
// ---------------------------------------------------------------------------

const KIND_LABELS: Readonly<Record<CustomerStatement["lines"][number]["kind"], string>> = { invoice: "Invoice", "credit-note": "Credit note", payment: "Payment" }

/** Statement, in a customer's details: the window and the currency asked, then the lines read. */
export function CustomerStatementSurface({ record }: RowSurfaceProps) {
  const client = useApiClient()
  const serverId = useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId)?.serverIds.get(record.id)
  const [asking, setAsking] = useState(false)
  const [statement, setStatement] = useState<CustomerStatement | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = (values: BusinessFormValues) => {
    if (client === null || serverId === undefined || busy) return
    setBusy(true)
    customerStatement(client, serverId, { currency: text(values, "currency").toUpperCase(), from: text(values, "from"), to: text(values, "to") })
      .then(
        (read) => {
          setAsking(false)
          setStatement(read)
        },
        (error: unknown) => toast.error("The statement was not read", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  const money = (minor: number) => formatMinor(minor, statement?.currency ?? "DKK")
  return (
    <section className="space-y-3" data-testid="customer-statement">
      <h3 className="text-sm font-semibold">Balance</h3>
      <Button variant="outline" size="sm" disabled={client === null || serverId === undefined || busy} onClick={() => setAsking(true)}>
        Statement
      </Button>
      {asking && <BusinessRecordFormDialog schema={STATEMENT_FORM} open onOpenChange={(isOpen) => !isOpen && setAsking(false)} onSubmit={ask} relationOptions={(field) => field.options ?? []} />}
      {statement !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setStatement(null)}>
          <DialogContent className="sm:max-w-2xl" data-testid="statement">
            <DialogHeader>
              <DialogTitle>Statement of {record.name}</DialogTitle>
              <DialogDescription>
                {statement.from} – {statement.to}, in {statement.currency}: an invoice raises the balance, a credit note and a payment lower it.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-96 overflow-auto rounded-lg border border-border/60">
              <Table data-testid="statement-lines">
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="text-sm" colSpan={3}>
                      Opening balance
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm" data-testid="statement-opening">
                      {money(statement.openingBalanceMinor)}
                    </TableCell>
                  </TableRow>
                  {statement.lines.map((line) => (
                    <TableRow key={`${line.kind}-${line.documentId}`}>
                      <TableCell className="whitespace-nowrap text-sm">{line.on}</TableCell>
                      <TableCell className="text-sm">
                        {KIND_LABELS[line.kind]}
                        {line.label === null ? "" : ` ${line.label}`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{money(line.amountMinor)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{money(line.balanceMinor)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="text-sm font-medium" colSpan={3}>
                      Closing balance
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm font-medium" data-testid="statement-closing">
                      {money(statement.closingBalanceMinor)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
