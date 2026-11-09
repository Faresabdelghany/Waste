"use client"

import { Suspense } from "react"

import { ImportsOnApi } from "@/components/imports/imports-on-api"
import { ReportNotice } from "@/components/insight/report-card"
import { OfficeShell } from "@/components/office-shell"
import { useApiConfigured } from "@/components/platform/api-session-store"

// Improve › Imports (#291 slice 12): on the Pilot a CSV file previewed and
// committed through the API. An import writes the API's records, so without
// the API there is nothing for it to write to and the page says so.
export function ImportsPage() {
  const onApi = useApiConfigured()
  return (
    <OfficeShell className="min-w-0 overflow-x-hidden">
      <Suspense fallback={null}>
        {onApi ? <ImportsOnApi /> : <ReportNotice empty="Imports write through the API: sign in to the Pilot to import a file." />}
      </Suspense>
    </OfficeShell>
  )
}
