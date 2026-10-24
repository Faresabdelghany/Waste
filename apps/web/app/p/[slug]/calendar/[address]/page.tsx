import type { Metadata } from "next"

import { CollectionDaysPage } from "@/components/public/collection-days-pages"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"

// An address's collection days on the public calendar (Issue #293, M2b): the
// days by month, the feed to subscribe to and the print view. An address the
// project collects nothing at renders the not-found page. Kept out of search
// engines: an address is reached by searching for it, never by a listing.
export const instant = false

export const metadata: Metadata = { title: COLLECTION_DAYS_COPY.title, robots: { index: false } }

type PageProps = {
  params: Promise<{ slug: string; address: string }>
  searchParams: Promise<{ weeks?: string | string[] }>
}

export default function PublicCollectionDaysPage({ params, searchParams }: PageProps) {
  return <CollectionDaysPage params={params} searchParams={searchParams} embed={false} />
}
