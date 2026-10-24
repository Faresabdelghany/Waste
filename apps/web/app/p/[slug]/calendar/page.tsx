import type { Metadata } from "next"

import { CollectionSearchPage } from "@/components/public/collection-days-pages"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"

// A published project's public Collection Days, their address search
// (Issue #293, M2b, ADR-0010): anyone's, no session. Like the Sorting Guide,
// it reads the request and waits for the door before it renders, and a slug
// nobody publishes under renders the not-found page.
export const instant = false

export const metadata: Metadata = { title: COLLECTION_DAYS_COPY.title }

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export default function PublicCollectionSearchPage({ params, searchParams }: PageProps) {
  return <CollectionSearchPage params={params} searchParams={searchParams} embed={false} />
}
