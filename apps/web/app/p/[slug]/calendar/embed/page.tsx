import type { Metadata } from "next"

import { CollectionSearchPage } from "@/components/public/collection-days-pages"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"

// The Collection Days as the widget a municipality embeds on its own site
// in an iframe (Issue #293, M2b): the address search, compact, its results
// staying inside the frame. Kept out of search engines; the full page is the
// one to find.
export const instant = false

export const metadata: Metadata = { title: COLLECTION_DAYS_COPY.title, robots: { index: false } }

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export default function EmbeddedCollectionSearchPage({ params, searchParams }: PageProps) {
  return <CollectionSearchPage params={params} searchParams={searchParams} embed />
}
