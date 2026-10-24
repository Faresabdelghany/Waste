// The public Sorting Guide (Issue #293, M1, ADR-0010): a server component a
// resident reaches without an account. The search is a plain GET form, so the
// page works with no JavaScript and every result has an address of its own;
// what it shows for each answer of the door is lib/public/sorting-guide.ts's.
// The page marks itself with the project's language, the language the
// office's items are written in.
import { MagnifyingGlass } from "@phosphor-icons/react/ssr"
import { headers } from "next/headers"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { readPublishedProject, searchSortingGuide } from "@/lib/public/door"
import { pageViewOf, queryOf, SEARCH_MAX, type GuideView, type PageAsked } from "@/lib/public/sorting-guide"
import { SORTING_GUIDE_COPY as COPY } from "@/lib/public/sorting-guide-copy"

type SortingGuidePageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export async function SortingGuidePage({ params, searchParams }: SortingGuidePageProps) {
  const [{ slug }, { q }, incoming] = await Promise.all([params, searchParams, headers()])
  const door = { origin: process.env.WASTE_API_ORIGIN, forwardedFor: incoming.get("x-forwarded-for") }
  const query = queryOf(q)
  // One request to the door: a search's answer names its project too.
  const asked: PageAsked = query === null ? { query, answer: await readPublishedProject(slug, door) } : { query, answer: await searchSortingGuide(slug, query, door) }
  const page = pageViewOf(asked)
  if (page.kind === "not-published") notFound()

  return (
    <main lang={page.kind === "published" ? page.project.language : undefined} className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
        <header className="space-y-2">
          {page.kind === "published" && <p className="text-sm font-medium text-muted-foreground">{page.project.name}</p>}
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{COPY.title}</h1>
          <p className="text-base text-muted-foreground">{COPY.intro}</p>
        </header>

        {page.kind === "published" ? (
          <>
            <form role="search" method="get" className="mt-8 flex gap-2">
              <label htmlFor="sorting-guide-q" className="sr-only">
                {COPY.label}
              </label>
              <Input id="sorting-guide-q" name="q" type="search" defaultValue={query ?? ""} placeholder={COPY.placeholder} maxLength={SEARCH_MAX} autoComplete="off" className="h-11 text-base" />
              <Button type="submit" className="h-11 gap-2 px-5">
                <MagnifyingGlass aria-hidden="true" className="size-4" />
                {COPY.search}
              </Button>
            </form>
            <section aria-live="polite" className="mt-8">
              <GuideResults view={page.guide} />
            </section>
          </>
        ) : (
          <p role="status" className="mt-8 rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground">
            {page.kind === "too-many" ? COPY.tooMany(page.retryAfterSeconds) : COPY.unavailable}
          </p>
        )}
      </div>
    </main>
  )
}

function GuideResults({ view }: { view: GuideView }) {
  switch (view.kind) {
    case "prompt":
      return null
    case "nothing":
      return <p className="text-sm text-foreground">{COPY.nothing(view.query)}</p>
    case "matches":
      return (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">{COPY.results(view.matches.length, view.query)}</h2>
          <ul className="mt-3 space-y-3">
            {view.matches.map((match) => (
              <li key={match.id} className="rounded-lg border border-border bg-card p-4 text-card-foreground">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-semibold">{match.name}</h3>
                  <Badge variant={match.fraction === null ? "outline" : "secondary"} className="text-sm">
                    {match.fraction?.name ?? COPY.noFraction}
                  </Badge>
                </div>
                {match.instructions !== null && <p className="mt-2 whitespace-pre-line text-sm text-foreground">{match.instructions}</p>}
                {match.matched !== match.name && <p className="mt-2 text-xs text-muted-foreground">{COPY.matchedAs(match.matched)}</p>}
                {match.synonyms.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {COPY.alsoCalled}: {match.synonyms.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )
  }
}
