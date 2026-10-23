"use client"
// Products and Price rows on the Pilot (Issue #185, slice 10 of #81, for
// #148): the command surfaces of `commercial.products` and
// `commercial.price-rows`. Both modules' primary action is Add price, a row
// of a price list (a product is added and edited in Settings › Commercial ›
// Products, as the prototype had it); the price rows offer Explain price
// beside it, and a row's details its edit — its price, its note and its end,
// since its conditions and its start are its key — and Explain price asked
// with the row's own conditions. A product's details offer Explain price for
// it under its project's default list, and the way to its form in Settings.
//
// Explain price is a read the surface asks itself (`GET /price-lists/:id/
// resolve`, lib/api/records/pricing.ts): the question's dialog, then every
// row's verdict — won, eligible, or why it lost — the winning price with the
// product's VAT rate in the list's currency, and the resolution rule as the
// module's Info text has it. The forms are lib/data/commercial-forms.ts';
// nothing is offered until the module reads the API's rows.
import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import type { PriceResolution, RowVerdict } from "@waste/contracts/price-lists"
import { RESOLUTION_RULE } from "@waste/domain/finance/pricing"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useCommercialPickers, useCommercialResolver } from "@/components/waste/commands/commercial-pickers"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { useModuleReady } from "@/components/waste/commands/use-command-support"
import { isLocalRefusal } from "@/lib/api/records/adapter"
import { dayIn } from "@/lib/api/records/planning"
import { explainPrice, explainQuery } from "@/lib/api/records/pricing"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { formatMinor } from "@/lib/commercial/money"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { isPriceListRecord, PRICE_ROWS_MODULE } from "@/lib/data/commercial"
import { blankNone, createPriceRowRecord, editedRecord, EXPLAIN_PRICE_FORM, formValuesOf, PRICE_ROW_FORM, priceRowEditForm } from "@/lib/data/commercial-forms"

/** Settings › Commercial › Products, where a product is added and edited. */
export const PRODUCTS_SETTINGS_HREF = "/settings?pane=commercial-products"

/** Add price: a row of a price list, made from either module's header. */
function AddPrice({ label }: PrimarySurfaceProps) {
  const pickers = useCommercialPickers()
  return (
    <CreateSurface
      label={label}
      module={PRICE_ROWS_MODULE}
      schema={PRICE_ROW_FORM}
      pickers={pickers}
      make={(values, now) => createPriceRowRecord(values, now)}
      created={() => ({ title: "Price added", description: "The row is in its list, and prices what it matches from the day it starts." })}
    />
  )
}

/** Products' primary action: Add price, the module's real one; a product itself is made in Settings. */
export function ProductsPrimarySurface({ label }: PrimarySurfaceProps) {
  return <AddPrice label={label} />
}

/** Price rows' primary actions: Explain price, and Add price. */
export function PriceRowsPrimarySurface({ label }: PrimarySurfaceProps) {
  return (
    <div className="flex items-center gap-2">
      <ExplainPrice />
      <AddPrice label={label} />
    </div>
  )
}

/** The verdict a row was given, as a badge reads it. */
const verdictLabel = (verdict: RowVerdict) => (verdict.winner ? "Won" : verdict.eligible ? "Eligible" : "Lost")

/**
 * Explain price: the question's dialog, then the verdicts. `initial` is what
 * the question opens with — a row's conditions, a product's default list —
 * and the day is today on the browser's clock unless it says another.
 */
export function ExplainPrice({ initial = {}, label = "Explain price" }: { initial?: BusinessFormValues; label?: string }) {
  const client = useApiClient()
  const pickers = useCommercialPickers()
  const resolve = useCommercialResolver()
  const rows = useServerModuleState(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
  const [step, setStep] = useState<"closed" | "question" | "answer">("closed")
  const [values, setValues] = useState<BusinessFormValues>({})
  const [answer, setAnswer] = useState<PriceResolution | null>(null)
  const [asking, setAsking] = useState(false)

  const rowOf = (serverId: string): BusinessRecord | undefined => {
    for (const [webId, id] of rows?.serverIds ?? []) if (id === serverId) return rows?.records.find((record) => record.id === webId)
    return undefined
  }

  const open = () => {
    setValues({ on: dayIn(new Date(), undefined), ...initial })
    setStep("question")
  }

  const ask = (submitted: BusinessFormValues) => {
    if (asking || client === null) return
    setValues(submitted)
    const question = explainQuery(blankNone(submitted), resolve)
    if (isLocalRefusal(question)) {
      toast.error("The price was not explained", { description: question.message })
      return
    }
    setAsking(true)
    explainPrice(client, question.priceListId, question.query)
      .then(
        (resolution) => {
          setAnswer(resolution)
          setStep("answer")
        },
        (error: unknown) => toast.error("The price was not explained", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setAsking(false))
  }

  const winner = answer?.winner === null || answer?.winner === undefined ? undefined : rowOf(answer.winner.row.id)

  return (
    <>
      <Button variant="outline" size="sm" disabled={client === null || !pickers.readyFor(EXPLAIN_PRICE_FORM)} onClick={open}>
        {label}
      </Button>
      {step === "question" && (
        <BusinessRecordFormDialog schema={EXPLAIN_PRICE_FORM} open onOpenChange={(isOpen) => !isOpen && setStep("closed")} onSubmit={ask} relationOptions={(field, current) => pickers.options(field, current, undefined, values)} initialValueOverrides={values} />
      )}
      {step === "answer" && answer !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setStep("closed")}>
          <DialogContent className="sm:max-w-3xl" data-testid="explain-price">
            <DialogHeader>
              <DialogTitle>Why this price</DialogTitle>
              <DialogDescription>
                {answer.winner === null || answer.unitPriceMinor === null
                  ? "No row is eligible: an event priced on this question would be blocked with no price row."
                  : `${winner?.name ?? "The winning row"} wins at ${formatMinor(answer.unitPriceMinor, answer.currency)}${answer.vatPercent === null ? ", and the product has no VAT rate: its events block until it has one." : ` + ${answer.vatPercent}% VAT.`}`}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Verdict</TableHead>
                    <TableHead>Why</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {answer.verdicts.map((verdict) => {
                    const row = rowOf(verdict.row.id)
                    return (
                      <TableRow key={verdict.row.id} data-verdict={verdictLabel(verdict)}>
                        <TableCell className="text-sm">
                          <div className="font-medium">{row?.name ?? verdict.row.id}</div>
                          <div className="text-xs text-muted-foreground">{row?.facts["Effective from"] === undefined ? verdict.row.validFrom : `From ${row.facts["Effective from"]}`}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{formatMinor(verdict.row.unitPriceMinor, answer.currency)}</TableCell>
                        <TableCell>
                          <Badge variant={verdict.winner ? "default" : "outline"} className="rounded-full text-[11px]">
                            {verdictLabel(verdict)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{verdict.reason ?? (verdict.matched.length === 0 ? "Matches everyone" : `Matches ${verdict.matched.join(", ")}`)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{RESOLUTION_RULE}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("question")}>
                Change the question
              </Button>
              <Button onClick={() => setStep("closed")}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** A row's question, as Explain price opens on it: its list, its product, its conditions, today. */
function rowQuestion(record: BusinessRecord): BusinessFormValues {
  const values = record.submittedValues ?? {}
  const keys = ["priceListId", "productId", "planningAreaId", "customerKind", "containerType", "wasteFraction", "customerId"]
  return Object.fromEntries(keys.flatMap((key) => (typeof values[key] === "string" ? [[key, values[key]]] : [])))
}

/** A price row's details: its edit, and Explain price on its own conditions. */
export function PriceRowCommandsSurface({ record }: RowSurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const moduleReady = useModuleReady(PRICE_ROWS_MODULE)
  const [opened, setOpened] = useState<BusinessFormValues | null>(null)
  const [busy, setBusy] = useState(false)
  const schema = priceRowEditForm(record)

  const save = (values: BusinessFormValues) => {
    if (busy) return
    const edited = editedRecord(record, values)
    const outcome = upsertRecord(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId, edited)
    setBusy(true)
    whenSaved(
      outcome,
      () => setOpened(null),
      () => setBusy(false),
    )
    void outcome?.then((result) => {
      if (result.kind === "updated") toast.success("Price updated", { description: `${record.context}: ${result.record.value}.` })
      else if (result.kind === "unchanged") toast.info("Nothing to change", { description: "The row is as the API holds it." })
    })
  }

  return (
    <section className="space-y-3" data-testid="price-row-commands">
      <h3 className="text-sm font-semibold">Price row</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The price rows are being read from the API; the edit follows.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(schema)} onClick={() => setOpened(formValuesOf(schema, record))}>
          Edit price
        </Button>
        <ExplainPrice initial={rowQuestion(record)} />
      </div>
      {opened !== null && <BusinessRecordFormDialog schema={schema} open onOpenChange={(isOpen) => !isOpen && setOpened(null)} onSubmit={save} relationOptions={(field, values) => pickers.options(field, values, undefined, opened)} initialValueOverrides={opened} />}
    </section>
  )
}

/** A product's details: Explain price for it under its project's default list, and its form in Settings. */
export function ProductCommandsSurface({ record }: RowSurfaceProps) {
  const rows = useServerModuleState(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
  const project = record.projectIds?.[0]
  const defaultList = rows?.records.find((row) => isPriceListRecord(row) && row.submittedValues?.isDefault === true && (project === undefined || row.projectIds?.includes(project)))
  return (
    <section className="space-y-3" data-testid="product-commands">
      <h3 className="text-sm font-semibold">Product</h3>
      <div className="flex flex-wrap gap-2">
        <ExplainPrice initial={{ productId: record.id, ...(defaultList === undefined ? {} : { priceListId: defaultList.id }) }} />
        <Button variant="outline" size="sm" asChild>
          <Link href={PRODUCTS_SETTINGS_HREF}>Edit in Settings</Link>
        </Button>
      </div>
    </section>
  )
}
