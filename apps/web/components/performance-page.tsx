"use client"

import { Suspense } from "react"
import { useRouter } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { DashboardOnApi } from "@/components/insight/dashboard-on-api"
import { PerformanceControlRoom } from "@/components/performance-control-room"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useApiConfigured } from "@/components/waste/api-session-store"

// The Dashboard (#292): on the Pilot the API's reports (components/insight),
// in fixture mode the prototype's control room over its fixtures, unchanged.
export function PerformancePage() {
  const router = useRouter()
  const onApi = useApiConfigured()

  // Dashboard rows use route codes (RC-1042); route records use ids (route-day-1042).
  const openRoute = (routeId: string) => {
    const recordId = `route-day-${routeId.replace(/^RC-/, "")}`
    router.push(`/route-studio?module=routes&record=${recordId}`)
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <Suspense fallback={null}>
          {onApi ? (
            <DashboardOnApi />
          ) : (
            <PerformanceControlRoom
              hideTableColumns={["proof", "exceptions", "trend"]}
              onRouteOpen={openRoute}
            />
          )}
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
