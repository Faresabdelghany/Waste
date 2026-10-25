"use client"

// Commercial › Accounting export's surfaces on the Pilot (#291 C7w). Export
// period is the module's primary: the project and the period, previewed
// first — the vouchers it would book counted per kind, the back-dated ones,
// the debits per currency, and every row the mapping cannot book yet with
// the sentence saying what to set up in Settings › Commercial › Accounting —
// then exported through the store, the module's create. An export's details
// offer its file, our CSV as the API rendered it from the lines the export
// froze, saved under the name the API gave it.
import { useState } from "react"
import { toast } from "sonner"
import type { AccountingExportCreate, AccountingExportPreview } from "@waste/contracts/accounting"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useApiClient } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useCommercialPickers, useCommercialResolver } from "@/components/waste/commands/commercial-pickers"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useModuleReady, useOpenRecord } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { isLocalRefusal } from "@/lib/api/records/adapter"
import { accountingExportBody, accountingExportFile, previewAccountingExport } from "@/lib/api/records/accounting"
import { problemOfError } from "@/lib/api/records/server-records"
import { formatMinor } from "@/lib/commercial/money"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { downloadBlob } from "@/lib/data/csv"
import { ACCOUNTING_MODULE } from "@/lib/data/commercial"
import { blankNone, createAccountingExportRecord, EXPORT_PERIOD_FORM } from "@/lib/data/commercial-forms"

/** The kinds of row a preview counts, as a person reads them. */
const KIND_ROWS = [
  ["invoice", "Invoices"],
  ["credit-note", "Credit notes"],
  ["payment", "Payments"],
  ["allocation", "Matches of unmatched payments"],
] as const

export function ExportPeriodSurface({ label }: PrimarySurfaceProps) {
  const client = useApiClient()
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const resolve = useCommercialResolver()
  const moduleReady = useModuleReady(ACCOUNTING_MODULE)
  const openRecord = useOpenRecord(ACCOUNTING_MODULE.moduleId)
  const [step, setStep] = useState<"closed" | "period" | "preview">("closed")
  const [values, setValues] = useState<BusinessFormValues>({})
  const [preview, setPreview] = useState<{ body: AccountingExportCreate; answer: AccountingExportPreview } | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = (submitted: BusinessFormValues) => {
    if (busy || client === null) return
    setValues(submitted)
    const body = accountingExportBody(blankNone(submitted), resolve)
    if (isLocalRefusal(body)) {
      toast.error("The export was not previewed", { description: body.message })
      return
    }
    setBusy(true)
    previewAccountingExport(client, body)
      .then(
        (answer) => {
          setPreview({ body, answer })
          setStep("preview")
        },
        (error: unknown) => toast.error("The export was not previewed", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  const exportIt = () => {
    if (busy || preview === null) return
    const record = createAccountingExportRecord(values, Date.now())
    setBusy(true)
    whenSaved(
      upsertRecord(ACCOUNTING_MODULE.workspaceId, ACCOUNTING_MODULE.moduleId, record),
      (saved) => {
        setStep("closed")
        openRecord(record.id)
        if (saved?.kind === "created") toast.success("Period exported", { description: `${saved.record.name}: download its file from the details.` })
      },
      () => setBusy(false),
    )
  }

  const answer = preview?.answer
  return (
    <>
      <Button size="sm" disabled={!moduleReady || client === null || !pickers.readyFor(EXPORT_PERIOD_FORM)} onClick={() => setStep("period")}>
        {label}
      </Button>
      {step === "period" && (
        <BusinessRecordFormDialog schema={EXPORT_PERIOD_FORM} open onOpenChange={(isOpen) => !isOpen && setStep("closed")} onSubmit={ask} relationOptions={(field, current) => pickers.options(field, current, undefined, values)} initialValueOverrides={values} />
      )}
      {step === "preview" && preview !== null && answer !== undefined && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && setStep("closed")}>
          <DialogContent className="sm:max-w-xl" data-testid="accounting-preview">
            <DialogHeader>
              <DialogTitle>Export period</DialogTitle>
              <DialogDescription>
                What an export of {preview.body.periodFrom} – {preview.body.periodTo} would book now. Nothing is written until you export it.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Vouchers</dt>
              <dd data-testid="preview-vouchers">{answer.voucherCount}</dd>
              {KIND_ROWS.filter(([kind]) => answer.byKind[kind] > 0).map(([kind, name]) => (
                <div key={kind} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd>{answer.byKind[kind]}</dd>
                </div>
              ))}
              <dt className="text-muted-foreground">Back-dated</dt>
              <dd data-testid="preview-back-dated">{answer.backDatedCount}</dd>
              {answer.totals.map((total) => (
                <div key={total.currency} className="contents">
                  <dt className="text-muted-foreground">Debits in {total.currency}</dt>
                  <dd>{formatMinor(total.debitMinor, total.currency)}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">Rows the mapping cannot book yet</h4>
              {answer.gaps.length === 0 ? (
                <p className="text-sm text-muted-foreground">None: every row of the period books to the project&apos;s chart.</p>
              ) : (
                <ul className="text-sm" data-testid="preview-gaps">
                  {answer.gaps.map((gap) => (
                    <li key={`${gap.kind}/${gap.sourceId}`}>
                      {gap.document ?? "A payment"}: {gap.sentence}
                    </li>
                  ))}
                </ul>
              )}
              {answer.gaps.length > 0 && <p className="text-xs text-muted-foreground">Set them up in Settings › Commercial › Accounting, then preview again.</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setStep("period")}>
                Back
              </Button>
              <Button disabled={busy || answer.voucherCount === 0 || answer.gaps.length > 0} onClick={exportIt}>
                Export
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** An export's details: its file, our CSV or SAF-T, saved under the name the API gave it. */
export function AccountingExportSurface({ record }: RowSurfaceProps) {
  const client = useApiClient()
  const serverId = useServerModuleState(ACCOUNTING_MODULE.workspaceId, ACCOUNTING_MODULE.moduleId)?.serverIds.get(record.id)
  const [busy, setBusy] = useState(false)

  const download = async (format: "csv" | "saf-t") => {
    if (client === null || serverId === undefined || busy) return
    setBusy(true)
    try {
      const file = await accountingExportFile(client, serverId, format)
      const [extension, type] = format === "csv" ? [".csv", "text/csv"] : ["-saf-t.xml", "application/xml"]
      downloadBlob(file.fileName ?? `${record.name}${extension}`, new Blob([file.bytes], { type: file.contentType ?? type }))
    } catch (error) {
      toast.error("The file could not be read", { description: problemSentence(problemOfError(error)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="accounting-export-commands">
      <p className="text-sm text-muted-foreground">Our CSV, semicolon-separated, one row per voucher line: the same file every time, whatever the mapping becomes.</p>
      <p className="text-sm text-muted-foreground">SAF-T, the Danish standard file, made today from the same lines with the company&apos;s identity and the mapping&apos;s standard numbers as they now stand.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || client === null || serverId === undefined} onClick={() => void download("csv")}>
          Download CSV
        </Button>
        <Button size="sm" variant="outline" disabled={busy || client === null || serverId === undefined} onClick={() => void download("saf-t")}>
          Download SAF-T
        </Button>
      </div>
    </div>
  )
}
