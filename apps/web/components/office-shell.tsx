import type { ReactNode } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function OfficeShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className={className}>{children}</SidebarInset>
    </SidebarProvider>
  )
}
