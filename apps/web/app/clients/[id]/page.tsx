import { AppSidebar } from "@/components/app-sidebar"
import { ClientDetailsPage } from "@/components/clients/ClientDetailsPage"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function Page({ params }: PageProps) {
  const { id } = await params
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <ClientDetailsPage clientId={id} />
      </SidebarInset>
    </SidebarProvider>
  )
}
