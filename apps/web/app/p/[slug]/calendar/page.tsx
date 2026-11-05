import type { Metadata } from "next"

import { CollectionSearchPage } from "@/components/public/collection-days-pages"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"

// A published project's public Collection Days, their address search
// (Issue #293, M2b, ADR-0010): anyone's, no session. It reads the request
// (the visitor's address, the query) and waits for the door before it
// renders. A slug nobody publishes under renders the not-found page; since
// the root layout streams (the sign-in gate's Suspense), that page goes out
// as a 200 marked `noindex`, which is how Next answers a not-found after the
// shell.
export const instant = false

export const metadata: Metadata = { title: COLLECTION_DAYS_COPY.title }

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export default function PublicCollectionSearchPage({ params, searchParams }: PageProps) {
  return <CollectionSearchPage params={params} searchParams={searchParams} embed={false} />
}
