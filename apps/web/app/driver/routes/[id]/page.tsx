import { DriverRouteScreen } from "@/components/waste/driver/driver-route-screen"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function DriverRoutePage({ params }: PageProps) {
  const { id } = await params
  return <DriverRouteScreen routeId={id} />
}
