import { DecisionLetterPage } from "@/components/applications/decision-letter"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function ApplicationLetterPage({ params }: PageProps) {
  const { id } = await params
  return <DecisionLetterPage applicationId={decodeURIComponent(id)} />
}
