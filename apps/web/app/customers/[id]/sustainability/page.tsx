import { SustainabilityPrintPage } from "@/components/customers/sustainability-print-page"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}

export default async function CustomerSustainabilityPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { from, to } = await searchParams
  return <SustainabilityPrintPage customerId={decodeURIComponent(id)} from={from ?? ""} to={to ?? ""} />
}
