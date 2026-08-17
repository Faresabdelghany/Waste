"use client"

import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { PerformanceControlRoom } from "@/components/performance-control-room"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function PerformancePage() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <Suspense fallback={null}>
          <PerformanceControlRoom />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
