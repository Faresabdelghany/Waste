import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { InboxPage } from "@/components/inbox/InboxPage"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function InboxRoutePage() {
    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <Suspense fallback={null}>
                    <InboxPage />
                </Suspense>
            </SidebarInset>
        </SidebarProvider>
    )
}
