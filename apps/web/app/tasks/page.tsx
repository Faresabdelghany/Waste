import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { MyTasksPage } from "@/components/tasks/MyTasksPage"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function TasksPage() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Suspense fallback={null}>
          <MyTasksPage />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
