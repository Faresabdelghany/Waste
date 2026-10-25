"use client"
// The decision letter (M7 of #293): a decided Application's latest Decision
// as a page to print and post, from the company `/me` names to the customer
// at their billing address, the Application named by its server id. The words are `decisionLetterOf`'s
// (lib/data/applications.ts); the page reads the applications and the
// customers through the store like any pane, and prints itself with the
// browser's own dialog — no PDF, which waits for C5's renderer.
import { useApiSession } from "@/components/waste/api-session-store"
import { useModuleRecords } from "@/components/waste/business-record-store"
import { Button } from "@/components/ui/button"
import { customersModule } from "@/lib/api/records/registry"
import { APPLICATION_SERVER_ID_KEY, APPLICATIONS_MODULE, decisionLetterOf, letterOffered } from "@/lib/data/applications"
import type { BusinessRecord } from "@/lib/data/business-modules"

const NO_FIXTURES: readonly BusinessRecord[] = []

export function DecisionLetterPage({ applicationId }: { applicationId: string }) {
  const { me } = useApiSession()
  const applications = useModuleRecords(APPLICATIONS_MODULE.workspaceId, APPLICATIONS_MODULE.moduleId, NO_FIXTURES)
  const customers = useModuleRecords(customersModule.workspaceId, customersModule.moduleId, NO_FIXTURES)
  // By the server id the record carries: the store's web id of a row made in another tab is that tab's alone.
  const record = applications.records.find((candidate) => candidate.submittedValues?.[APPLICATION_SERVER_ID_KEY] === applicationId)
  const customerId = typeof record?.submittedValues?.customerId === "string" ? record.submittedValues.customerId : undefined
  const customer = customers.records.find((candidate) => candidate.id === customerId)
  const letter = record === undefined || !letterOffered(record) ? null : decisionLetterOf(record, { company: me?.company.name ?? "", address: customer?.facts?.["Billing address"] ?? null })

  let notice: string | null = null
  if (applications.notGranted) notice = "The applications are not shown to your role."
  else if (!applications.ready) notice = "Reading the application…"
  else if (record === undefined) notice = "No such application here."
  else if (letter === null) notice = `${record.name} does not stand decided, so it has no letter: one under review on an appeal has its letter once decided again.`

  return (
    <main className="min-h-svh bg-background print:min-h-0 print:bg-white print:**:text-black">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 print:max-w-none print:py-0">
        {notice !== null || letter === null ? (
          <p className="text-sm text-muted-foreground">{notice}</p>
        ) : (
          <article className="space-y-6 text-sm leading-relaxed" data-testid="decision-letter">
            <div className="flex justify-end print:hidden">
              <Button size="sm" variant="outline" onClick={() => window.print()}>
                Print
              </Button>
            </div>
            <header className="space-y-4">
              <p className="font-semibold">{letter.sender}</p>
              <div>
                <p>{letter.recipient}</p>
                {letter.address !== null && <p className="whitespace-pre-line">{letter.address}</p>}
              </div>
              <p className="text-muted-foreground">{letter.date}</p>
              <h1 className="text-base font-semibold">{letter.subject}</h1>
            </header>
            <p>Dear {letter.recipient},</p>
            {letter.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {letter.conditions !== null && (
              <section className="space-y-1">
                <h2 className="font-semibold">{letter.conditions.heading}</h2>
                <p className="whitespace-pre-line">{letter.conditions.text}</p>
              </section>
            )}
            {letter.appeal !== null && (
              <section className="space-y-1">
                <h2 className="font-semibold">How to appeal</h2>
                <p className="whitespace-pre-line">{letter.appeal}</p>
              </section>
            )}
            <p>
              Yours sincerely,
              <br />
              {letter.sender}
            </p>
          </article>
        )}
      </div>
    </main>
  )
}
