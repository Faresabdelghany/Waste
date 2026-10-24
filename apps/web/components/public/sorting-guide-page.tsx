// The public Sorting Guide (Issue #293, M1, ADR-0010): a server component a
// resident reaches without an account. The search is a plain GET form, so the
// page works with no JavaScript and every result has an address of its own;
// what it shows for each answer of the door is lib/public/sorting-guide.ts's.
// The page's own words are English until M21; what the office wrote — the
// project's name and its items — is marked with the project's language.
import { MagnifyingGlass, MapPin } from "@phosphor-icons/react/ssr"
import Link from "next/link"
import { headers } from "next/headers"
import { notFound } from "next/navigation"

import { PublicNav } from "@/components/public/public-nav"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { doorFor, readPublishedProject, searchSortingGuide } from "@/lib/public/door"
import { dropOffHrefOf } from "@/lib/public/drop-off-points"
import { DROP_OFF_COPY } from "@/lib/public/drop-off-points-copy"
import { pageViewOf, queryOf, SEARCH_MAX, type GuideView, type PageAsked } from "@/lib/public/sorting-guide"
import { SORTING_GUIDE_COPY as COPY } from "@/lib/public/sorting-guide-copy"

type SortingGuidePageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export async function SortingGuidePage({ params, searchParams }: SortingGuidePageProps) {
  const [{ slug }, { q }, incoming] = await Promise.all([params, searchParams, headers()])
  const door = doorFor(incoming)
  const query = queryOf(q)
  // One request to the door: a search's answer names its project too.
  const asked: PageAsked = query === null ? { query, answer: await readPublishedProject(slug, door) } : { query, answer: await searchSortingGuide(slug, query, door) }
  const page = pageViewOf(asked)
  if (page.kind === "not-published") notFound()

  return (
    <main className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
        <header className="space-y-2">
          {page.kind === "published" && (
            <p lang={page.project.language} className="text-sm font-medium text-muted-foreground">
              {page.project.name}
            </p>
          )}
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{COPY.title}</h1>
          <p className="text-base text-muted-foreground">{COPY.intro}</p>
          {page.kind === "published" && <PublicNav slug={slug} current="sorting" />}
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
              <GuideResults slug={slug} view={page.guide} language={page.project.language} />
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

function GuideResults({ slug, view, language }: { slug: string; view: GuideView; language: string }) {
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
                  <h3 lang={language} className="text-lg font-semibold">
                    {match.name}
                  </h3>
                  <Badge lang={match.fraction === null ? undefined : language} variant={match.fraction === null ? "outline" : "secondary"} className="text-sm">
                    {match.fraction?.name ?? COPY.noFraction}
                  </Badge>
                </div>
                {match.instructions !== null && (
                  <p lang={language} className="mt-2 whitespace-pre-line text-sm text-foreground">
                    {match.instructions}
                  </p>
                )}
                {match.matched !== match.name && <p className="mt-2 text-xs text-muted-foreground">{COPY.matchedAs(match.matched)}</p>}
                {match.synonyms.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {COPY.alsoCalled}: <span lang={language}>{match.synonyms.join(", ")}</span>
                  </p>
                )}
                {/* The drop-off points that take its fraction, or every point where it is for no bin at home (M3b). */}
                <Link href={dropOffHrefOf(slug, match.fraction?.key ?? null)} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline">
                  <MapPin aria-hidden="true" className="size-4" />
                  {match.fraction === null ? DROP_OFF_COPY.findDropOff : DROP_OFF_COPY.whereToHandIn}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )
  }
}
