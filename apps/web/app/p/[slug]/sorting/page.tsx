import type { Metadata } from "next"

import { SortingGuidePage } from "@/components/public/sorting-guide-page"
import { SORTING_GUIDE_COPY } from "@/lib/public/sorting-guide-copy"

// A published project's public Sorting Guide (Issue #293, ADR-0010): anyone's,
// no session. It reads the request (the visitor's address, the query) and
// waits for the door, about a tenth of a second, before it renders. A slug
// nobody publishes under renders the not-found page; since the root layout
// streams (the sign-in gate's Suspense), that page goes out as a 200 marked
// `noindex`, which is how Next answers a not-found after the shell.
export const instant = false

export const metadata: Metadata = { title: SORTING_GUIDE_COPY.title }

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export default function PublicSortingGuidePage({ params, searchParams }: PageProps) {
  return <SortingGuidePage params={params} searchParams={searchParams} />
}
