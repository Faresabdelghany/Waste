// The links between a published project's public pages (Issue #293): the
// Sorting Guide and the Collection Days, the one shown marked as current.
// Hidden on paper.
import Link from "next/link"

import { calendarHrefOf } from "@/lib/public/collection-days"
import { COLLECTION_DAYS_COPY } from "@/lib/public/collection-days-copy"
import { SORTING_GUIDE_COPY } from "@/lib/public/sorting-guide-copy"

export function PublicNav({ slug, current }: { slug: string; current: "sorting" | "calendar" }) {
  const pages = [
    { key: "sorting", href: `/p/${encodeURIComponent(slug)}/sorting`, label: SORTING_GUIDE_COPY.title },
    { key: "calendar", href: calendarHrefOf(slug), label: COLLECTION_DAYS_COPY.title },
  ] as const
  return (
    <nav aria-label={COLLECTION_DAYS_COPY.pagesLabel} className="flex flex-wrap gap-x-4 gap-y-1 text-sm print:hidden">
      {pages.map((page) => (
        <Link
          key={page.key}
          href={page.href}
          aria-current={page.key === current ? "page" : undefined}
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {page.label}
        </Link>
      ))}
    </nav>
  )
}
