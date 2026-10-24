import type { Metadata } from "next"

import { CollectionDaysPage } from "@/components/public/collection-days-pages"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"

// An address's next collections in the embedded widget (Issue #293, M2b): the
// next few dates, the full calendar opening apart from the frame.
export const instant = false

export const metadata: Metadata = { title: COLLECTION_DAYS_COPY.title, robots: { index: false } }

type PageProps = {
  params: Promise<{ slug: string; address: string }>
  searchParams: Promise<{ weeks?: string | string[] }>
}

export default function EmbeddedCollectionDaysPage({ params, searchParams }: PageProps) {
  return <CollectionDaysPage params={params} searchParams={searchParams} embed />
}
