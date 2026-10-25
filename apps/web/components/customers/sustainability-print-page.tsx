"use client"
// A Customer's sustainability report as a page to print and send (M13 of
// #293): from the company `/me` names to the customer at their billing
// address, the window of days the address carries, and the report's body
// as the customer's details show it. The Customer is named by its server id
// and read on its own (`GET /customers/:id`), so the page waits on no module
// of the store; it prints itself with the browser's own dialog — no PDF,
// which waits for C5's renderer.
import type { Customer } from "@waste/contracts/customers"
import type { SustainabilityReport } from "@waste/contracts/sustainability"

import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { useApiSession } from "@/components/waste/api-session-store"
import { get } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { sustainabilityKey, sustainabilityReport } from "@/lib/api/reports"
import { periodLabel } from "@/lib/insight/compliance"
import { reportShowsAny, sustainabilityReadable, windowRefusal } from "@/lib/insight/sustainability"

import { SustainabilityReportBody } from "./sustainability-report-body"

export function SustainabilityPrintPage({ customerId, from, to }: { customerId: string; from: string; to: string }) {
  const { me } = useApiSession()
  // Until `/me` is read the grants are unknown: the page says it is reading, never that the role cannot see it.
  const known = me !== null
  const readable = known && sustainabilityReadable(me.role.grants)
  const refusal = windowRefusal({ from, to })
  const query = { customerId, from, to }
  const read = useReport<SustainabilityReport>(readable && refusal === null ? sustainabilityKey(query) : null, (asking) => sustainabilityReport(asking, query))
  // The customer alone, by its server id: the page waits on no module of the store.
  const customerPath = `/customers/${encodeURIComponent(customerId)}`
  const customer = useReport<Customer>(readable ? customerPath : null, (asking) => get<Customer>(asking, customerPath))

  let notice: string | null = null
  if (!known) notice = "Reading the sustainability report…"
  else if (!readable) notice = "The sustainability report is not shown to your role."
  else if (refusal !== null) notice = refusal
  else if (read.problem !== null) notice = `The sustainability report could not be read from the API: ${problemSentence(read.problem)}`
  else if (customer.problem !== null) notice = customer.problem.status === 404 ? "No such customer here." : `The customer could not be read from the API: ${problemSentence(customer.problem)}`
  else if (read.report === null || customer.report === null) notice = "Reading the sustainability report…"

  const report = read.report
  const named = customer.report
  return (
    <main className="min-h-svh bg-background print:min-h-0 print:bg-white print:**:text-black">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 print:max-w-none print:py-0">
        {notice !== null || report === null || named === null ? (
          <p className="text-sm text-muted-foreground">{notice}</p>
        ) : (
          <article className="space-y-6 text-sm leading-relaxed" data-testid="sustainability-print">
            <div className="flex justify-end print:hidden">
              <Button size="sm" variant="outline" onClick={() => window.print()}>
                Print
              </Button>
            </div>
            <header className="space-y-4">
              <p className="font-semibold">{me?.company.name}</p>
              <div>
                <p>{named.name}</p>
                {named.billingAddress !== null && <p className="whitespace-pre-line">{named.billingAddress}</p>}
              </div>
              <h1 className="text-base font-semibold">Sustainability report, {periodLabel(report.window)}</h1>
              <p className="text-muted-foreground">The waste we collected for you, by site and fraction: how much was weighed, how much of it was reused or recycled, and its carbon footprint.</p>
            </header>
            {reportShowsAny(report) ? <SustainabilityReportBody report={report} /> : <p>No collection was completed for you in this period.</p>}
          </article>
        )}
      </div>
    </main>
  )
}
