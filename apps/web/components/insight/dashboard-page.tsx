"use client"

import { Suspense } from "react"

import { DashboardOnApi } from "@/components/insight/dashboard-on-api"
import { OfficeShell } from "@/components/office-shell"

// The Dashboard (#292): the API's reports (components/insight).
export function DashboardPage() {
  return (
    <OfficeShell className="min-w-0 overflow-x-hidden">
      <Suspense fallback={null}>
        <DashboardOnApi />
      </Suspense>
    </OfficeShell>
  )
}
