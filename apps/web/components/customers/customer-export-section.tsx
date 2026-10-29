"use client"
// A Customer's export in its details (#291 C19, part 2, #381): everything the
// company holds about it as one JSON file, the answer to a person's request
// to see their data. Read when asked, never on opening — it is a read of
// every family — from the API's own reads filtered by the customer
// (lib/api/customer-export.ts), so each part is read under its own grant: a
// part the role is refused is named in the file and here, never left out
// silently, and any other failure fails the export rather than hand over a
// file with a part missing.
import { useState } from "react"
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useServerModuleState } from "@/components/waste/business-record-store"
import { useProjectTimezone } from "@/components/waste/commands/use-command-support"
import { readCustomerExport } from "@/lib/api/customer-export"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { downloadBlob } from "@/lib/data/csv"
import { customerExportFileName, customerExportOf } from "@/lib/data/customer-export"
import { CONTACTS_MODULE } from "@/lib/data/properties"
import { projectToday } from "@/lib/data/route-schemes"

export function CustomerExportSection({ record }: { record: BusinessRecord }) {
  const client = useApiClient()
  const { me } = useApiSession()
  const serverId = useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId)?.serverIds.get(record.id)
  const today = projectToday(useProjectTimezone(record.projectIds?.[0]))
  const [exporting, setExporting] = useState(false)
  const [notIncluded, setNotIncluded] = useState<{ section: string; reason: string }[] | null>(null)

  const exportAll = () => {
    if (client === null || serverId === undefined) return
    setExporting(true)
    readCustomerExport(client, serverId).then(
      (outcomes) => {
        const document = customerExportOf({ customerId: serverId, customerName: record.name, exportedAt: new Date().toISOString(), exportedBy: me?.user.fullName ?? "", outcomes })
        downloadBlob(customerExportFileName(record.name, today), new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }))
        setNotIncluded(document.notIncluded)
        setExporting(false)
        toast.success("Customer data exported", { description: document.notIncluded.length === 0 ? `Everything held about ${record.name}.` : `${document.notIncluded.length} part${document.notIncluded.length === 1 ? " was" : "s were"} not included: your role does not read ${document.notIncluded.length === 1 ? "it" : "them"}.` })
      },
      (error: unknown) => {
        setExporting(false)
        toast.error("The export was not made", { description: problemSentence(problemOfError(error)) })
      },
    )
  }

  return (
    <section className="space-y-3" aria-labelledby={`customer-export-${record.id}`}>
      <div className="space-y-1">
        <h3 id={`customer-export-${record.id}`} className="text-sm font-semibold">
          Personal data
        </h3>
        <p className="text-xs text-muted-foreground">Everything held about this customer as one file: its details and history, properties, agreements, money, tickets and messages, site access and visits, bookings and applications.</p>
      </div>
      <Button variant="outline" size="sm" onClick={exportAll} disabled={exporting || client === null || serverId === undefined}>
        <DownloadSimple className="h-4 w-4" />
        {exporting ? "Exporting…" : "Export customer data"}
      </Button>
      {notIncluded !== null && notIncluded.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground" role="status">
          <p>Not included in the last export:</p>
          <ul className="list-disc pl-4">
            {notIncluded.map((part) => (
              <li key={part.section}>
                {part.section}: {part.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
