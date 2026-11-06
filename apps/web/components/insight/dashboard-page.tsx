"use client"

import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { DashboardOnApi } from "@/components/insight/dashboard-on-api"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

// The Dashboard (#292): the API's reports (components/insight).
export function DashboardPage() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <Suspense fallback={null}>
          <DashboardOnApi />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
