"use client"
// Applications on the Pilot (M7 of #293): what an Application's details offer
// beyond its correction, which the generic Edit makes while it is undecided
// (`applicationCorrectable`). The commands its status moves it by
// (`applicationCommandsOffered`, the domain's moves) — Decide through its own
// dialog, the rest at a press, each told in its own words — its Decisions
// read from the API, oldest first, and, while it stands decided, the decision
// letter to print. The API's refusal is the store's toast in its own words.
// The forms and readings are lib/data/applications.ts's.
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useProjectTimezone, useRowHistory } from "@/components/waste/commands/use-command-support"
import { applicationDecisions } from "@/lib/api/records/applications"
import { shownOn } from "@/lib/api/records/clock"
import { APPLICATION_SERVER_ID_KEY, applicationCommandsOffered, APPLICATIONS_MODULE, DECIDE_FORM, decisionLetterHref, letterOffered, outcomeLabel, periodText, type ApplicationOffer } from "@/lib/data/applications"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { Decision } from "@waste/contracts/applications"

const { workspaceId, moduleId } = APPLICATIONS_MODULE

/** One Decision as the history lists it: when, the outcome, and its period by its last day in force. */
function decisionLine(decision: Decision, timezone: string | undefined): string {
  const period = decision.validFrom === null ? "" : ` · ${periodText(decision.validFrom, decision.validTo).replace(/^From /, "from ")}`
  return `${shownOn(decision.decidedAt, timezone)} · ${outcomeLabel(decision.outcome)}${period}`
}

/** An Application's commands, its Decisions and its letter, in its details. */
export function ApplicationCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(APPLICATIONS_MODULE)
  // The version is bumped after each command the API took: a decision appends to the history, whatever the row shows.
  const { busy, version, run } = useCommandRunner(APPLICATIONS_MODULE, record.id)
  const decisions = useRowHistory(workspaceId, moduleId, record, version, applicationDecisions)
  const [deciding, setDeciding] = useState(false)
  const timezone = useProjectTimezone(typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined)
  const applicationId = record.submittedValues?.[APPLICATION_SERVER_ID_KEY]

  const send = ({ command, done }: ApplicationOffer, input?: BusinessFormValues) =>
    run(command, input, (outcome) => {
      setDeciding(false)
      toast.success(done, { description: outcome.record.name })
    })

  return (
    <section className="space-y-4" data-testid="application-commands">
      <h3 className="text-sm font-semibold">Application</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The applications are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {applicationCommandsOffered(record).map((offer) => (
          <Button key={offer.command} variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => (offer.command === "decide" ? setDeciding(true) : send(offer))}>
            {offer.label}
          </Button>
        ))}
        {letterOffered(record) && typeof applicationId === "string" && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={decisionLetterHref(applicationId)} target="_blank" rel="noopener">
              Decision letter
            </Link>
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Decisions</h4>
        <ReadRows read={decisions} label="Reading the decisions…" empty="Not decided yet." testId="application-decisions" line={(decision) => decisionLine(decision, timezone)} />
      </div>
      {deciding && (
        <BusinessRecordFormDialog
          schema={DECIDE_FORM}
          open
          onOpenChange={(isOpen) => !isOpen && setDeciding(false)}
          onSubmit={(values) => send({ command: "decide", label: "Decide", done: "Decision recorded" }, values)}
          relationOptions={(field) => field.options ?? []}
          submitting={busy}
        />
      )}
    </section>
  )
}
