import type { ReactNode } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

/** The office's frame around a page: its sidebar beside the page's content. */
export function OfficeShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className={className}>{children}</SidebarInset>
    </SidebarProvider>
  )
}
