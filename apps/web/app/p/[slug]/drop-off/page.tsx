import type { Metadata } from "next"

import { DropOffPage } from "@/components/public/drop-off-page"
import { DROP_OFF_COPY } from "@/lib/public/drop-off-points-copy"

// A published project's public Drop-off Points (Issue #293, M3b, ADR-0010):
// anyone's, no session. Like the Sorting Guide, it reads the request and waits
// for the door before it renders, and a slug nobody publishes under renders
// the not-found page.
export const instant = false

export const metadata: Metadata = { title: DROP_OFF_COPY.title }

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ fraction?: string | string[] }>
}

export default function PublicDropOffPage({ params, searchParams }: PageProps) {
  return <DropOffPage params={params} searchParams={searchParams} />
}
