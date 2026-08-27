"use client"

import { Suspense } from "react"
import { useRouter } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { PerformanceControlRoom } from "@/components/performance-control-room"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function PerformancePage() {
  const router = useRouter()

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
          <PerformanceControlRoom
            hideTableColumns={["proof", "exceptions", "trend"]}
            onRouteOpen={openRoute}
          />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
