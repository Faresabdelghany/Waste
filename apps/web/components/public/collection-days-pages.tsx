// The public Collection Days (Issue #293, M2b, ADR-0010): server components a
// resident reaches without an account. The address search is a plain GET form
// and every page has an address of its own, so it works with no JavaScript.
// Each page comes in full and as the widget a municipality embeds on its own
// site (`…/calendar/embed`): the same search and days in a compact frame, the
// widget's links staying inside it and the full page opening apart. What each
// answer of the door shows is lib/public/collection-days.ts's. The pages'
// own words are English until M21; what the office wrote — the project's
// name, the addresses, the fractions — is marked with the project's language.
import { MagnifyingGlass } from "@phosphor-icons/react/ssr"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { CalendarFeed } from "@/components/public/calendar-feed"
import { ProjectFooter, ProjectMark } from "@/components/public/project-brand"
import { PublicNav } from "@/components/public/public-nav"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ADDRESS_SEARCH,
  addressQueryOf,
  askable,
  calendarHrefOf,
  dayLabelOf,
  EMBED_DATES,
  feedPathOf,
  isAddressId,
  monthLabelOf,
  monthsOf,
  nextDatesOf,
  searchPageViewOf,
  WEEK_CHOICES,
  weeksOf,
  type AddressSearchView,
  type CalendarDate,
} from "@/lib/public/collection-days"
import { COLLECTION_DAYS_COPY as COPY } from "@/lib/public/collection-days-copy"
import { doorFor, readCollectionDays, readPublishedProject, searchAddresses } from "@/lib/public/door"
import { cn } from "@/lib/utils"

type SearchParams = Promise<{ q?: string | string[]; weeks?: string | string[] }>

/** The page's frame: the full page's width or the widget's compact one. On paper, black on white whatever the theme. */
function PublicFrame({ embed, children }: { embed: boolean; children: ReactNode }) {
  return (
    <main className="public-page min-h-svh bg-background print:min-h-0 print:bg-white print:**:text-black">
      <div className={cn("mx-auto w-full px-4", embed ? "max-w-xl py-4" : "max-w-2xl py-10 sm:py-16 print:max-w-none print:py-0")}>{children}</div>
    </main>
  )
}

function Refused({ slug, embed, retryAfterSeconds }: { slug: string; embed: boolean; retryAfterSeconds: number | null }) {
  return (
    <PublicFrame embed={embed}>
      <p role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground">
        {retryAfterSeconds === null ? COPY.unavailable : COPY.tooMany(retryAfterSeconds)}
      </p>
      {!embed && (
        <div className="mt-4">
          <PublicNav slug={slug} current="calendar" />
        </div>
      )}
    </PublicFrame>
  )
}

export async function CollectionSearchPage({ params, searchParams, embed }: { params: Promise<{ slug: string }>; searchParams: SearchParams; embed: boolean }) {
  const [{ slug }, { q }, incoming] = await Promise.all([params, searchParams, headers()])
  const door = doorFor(incoming)
  const query = addressQueryOf(q)
  // One request to the door: a search's answer names its project too.
  const page = searchPageViewOf(askable(query) ? { asked: "search", query, answer: await searchAddresses(slug, query, door) } : { asked: "project", query, answer: await readPublishedProject(slug, door) })
  if (page.kind === "not-published") notFound()
  if (page.kind !== "published") return <Refused slug={slug} embed={embed} retryAfterSeconds={page.kind === "too-many" ? page.retryAfterSeconds : null} />

  return (
    <PublicFrame embed={embed}>
      <header className="space-y-2">
        <ProjectMark project={page.project} />
        <h1 className={cn("font-semibold tracking-tight text-foreground", embed ? "text-xl" : "text-3xl")}>{COPY.title}</h1>
        <p className="text-base text-muted-foreground">{COPY.intro}</p>
        {!embed && <PublicNav slug={slug} current="calendar" />}
      </header>
      <form role="search" method="get" action={calendarHrefOf(slug, { embed })} className={cn("flex gap-2", embed ? "mt-4" : "mt-8")}>
        <label htmlFor="collection-days-q" className="sr-only">
          {COPY.label}
        </label>
        <Input
          id="collection-days-q"
          name="q"
          type="search"
          defaultValue={query ?? ""}
          placeholder={COPY.placeholder}
          minLength={ADDRESS_SEARCH.min}
          maxLength={ADDRESS_SEARCH.max}
          required
          autoComplete="street-address"
          className="h-11 text-base"
        />
        <Button type="submit" className="h-11 gap-2 px-5">
          <MagnifyingGlass aria-hidden="true" className="size-4" />
          {COPY.search}
        </Button>
      </form>
      <section aria-live="polite" className={embed ? "mt-4" : "mt-8"}>
        <SearchResults slug={slug} embed={embed} language={page.project.language} view={page.search} />
      </section>
      <ProjectFooter project={page.project} embed={embed} />
    </PublicFrame>
  )
}

function SearchResults({ slug, embed, language, view }: { slug: string; embed: boolean; language: string; view: AddressSearchView }) {
  switch (view.kind) {
    case "prompt":
      return null
    case "too-short":
      return <p className="text-sm text-foreground">{COPY.tooShort(ADDRESS_SEARCH.min)}</p>
    case "nothing":
      return <p className="text-sm text-foreground">{COPY.nothing(view.query)}</p>
    case "matches":
      return (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">{COPY.results(view.addresses.length, view.query)}</h2>
          <ul lang={language} className="mt-3 divide-y divide-border rounded-lg border border-border bg-card text-card-foreground">
            {view.addresses.map((match) => (
              <li key={match.id}>
                <Link href={calendarHrefOf(slug, { embed, addressId: match.id })} className="block px-4 py-3 text-base font-medium hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none">
                  {match.address}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )
  }
}

export async function CollectionDaysPage({ params, searchParams, embed }: { params: Promise<{ slug: string; address: string }>; searchParams: SearchParams; embed: boolean }) {
  const [{ slug, address }, { weeks: asked }, incoming] = await Promise.all([params, searchParams, headers()])
  if (!isAddressId(address)) notFound()
  const weeks = weeksOf(asked)
  const answer = await readCollectionDays(slug, address, weeks, doorFor(incoming))
  if (answer.kind === "not-published") notFound()
  if (answer.kind !== "ok") return <Refused slug={slug} embed={embed} retryAfterSeconds={answer.kind === "too-many" ? answer.retryAfterSeconds : null} />
  const { project, days } = answer.body

  if (embed) {
    const next = nextDatesOf(days, EMBED_DATES)
    return (
      <PublicFrame embed>
        <header className="space-y-1">
          <ProjectMark project={project} />
          <h1 lang={project.language} className="text-xl font-semibold tracking-tight text-foreground">
            {answer.body.address.address}
          </h1>
        </header>
        {next.length === 0 ? <p className="mt-4 text-sm text-foreground">{COPY.noDays}</p> : <DateList dates={next} language={project.language} className="mt-4" />}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={calendarHrefOf(slug, { addressId: address })} target="_blank" rel="noopener" className="font-medium text-primary underline-offset-4 hover:underline">
            {COPY.fullCalendar}
          </Link>
          <Link href={calendarHrefOf(slug, { embed: true })} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {COPY.anotherAddress}
          </Link>
        </div>
        <ProjectFooter project={project} embed />
      </PublicFrame>
    )
  }

  const months = monthsOf(days)
  return (
    <PublicFrame embed={false}>
      <header className="space-y-2">
        <ProjectMark project={project}>
          <span>· {COPY.title}</span>
        </ProjectMark>
        <h1 lang={project.language} className="text-3xl font-semibold tracking-tight text-foreground">
          {answer.body.address.address}
        </h1>
        <p className="text-base text-muted-foreground">{COPY.shown(weeks)}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm print:hidden">
          <Link href={calendarHrefOf(slug)} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {COPY.anotherAddress}
          </Link>
          <PublicNav slug={slug} current="calendar" />
        </div>
      </header>

      <div className="mt-6 space-y-4 print:hidden">
        <CalendarFeed feedPath={feedPathOf(slug, address)} />
        <nav aria-label={COPY.weeksLabel} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{COPY.weeksLabel}</span>
          {WEEK_CHOICES.map((choice) => (
            <Link
              key={choice}
              href={calendarHrefOf(slug, { addressId: address, weeks: choice })}
              aria-current={choice === weeks ? "page" : undefined}
              className="rounded-md border border-border px-2.5 py-1 hover:bg-accent aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
            >
              {COPY.weeks(choice)}
            </Link>
          ))}
        </nav>
      </div>

      {months.length === 0 ? (
        <p className="mt-8 text-sm text-foreground">{COPY.noDays}</p>
      ) : (
        <div className="mt-8 space-y-8 print:mt-4 print:space-y-4">
          {months.map((month) => (
            <section key={month.month} aria-labelledby={`month-${month.month}`} className="break-inside-avoid">
              <h2 id={`month-${month.month}`} className="text-lg font-semibold text-foreground">
                {monthLabelOf(`${month.month}-01`)}
              </h2>
              <DateList dates={month.dates} language={project.language} className="mt-3" />
            </section>
          ))}
        </div>
      )}
      <ProjectFooter project={project} />
    </PublicFrame>
  )
}

/** The dates, each with what is collected that day (the fractions in the project's language), why a day moved, and what the holiday policy skips. */
function DateList({ dates, language, className }: { dates: CalendarDate[]; language: string; className?: string }) {
  return (
    <ul className={cn("divide-y divide-border rounded-lg border border-border bg-card text-card-foreground print:rounded-none print:border-black/30", className)}>
      {dates.map((date) => (
        <li key={date.date} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-6 print:flex-row print:gap-6 print:py-1.5">
          <p className="w-48 shrink-0 text-sm font-medium">
            <time dateTime={date.date}>{dayLabelOf(date.date)}</time>
          </p>
          <div className="space-y-1.5">
            {date.collections.map((collection, index) => (
              <div key={`${collection.serviceDate}-${index}`} className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {collection.status === "skipped" && <span className="text-sm font-medium text-destructive">{COPY.skipped}:</span>}
                  {collection.fractions.map((fraction) => (
                    <Badge key={fraction} lang={language} variant={collection.status === "skipped" ? "outline" : "secondary"} className={cn("text-sm print:border-black/40", collection.status === "skipped" && "line-through")}>
                      {fraction}
                    </Badge>
                  ))}
                </div>
                {collection.note !== null && <p className="text-xs text-muted-foreground">{collection.note}</p>}
              </div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
