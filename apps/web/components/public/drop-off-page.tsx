// The public map of Drop-off Points (Issue #293, M3b, ADR-0010): a server
// component a resident reaches without an account, from the project's other
// public pages or from a Sorting Guide answer, which asks for the points
// taking its fraction (`?fraction=<key>`). The list is the page — each point's
// kind, address, what it takes, today's opening and the week's, its note —
// and works with no JavaScript; the map beside it adds where. The pages' own
// words are English until M21; what the office wrote is marked with the
// project's language.
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"

import { DropOffMapLoader } from "@/components/public/drop-off-map-loader"
import { PublicNav } from "@/components/public/public-nav"
import { Badge } from "@/components/ui/badge"
import { doorFor, readDropOffPoints } from "@/lib/public/door"
import { dropOffHrefOf, fractionKeyOf, mapPointsOf, openingTextOf, pointAnchorOf, shortDayOf } from "@/lib/public/drop-off-points"
import { DROP_OFF_COPY as COPY } from "@/lib/public/drop-off-points-copy"
import type { PublicDropOffPoint } from "@waste/contracts/public"

type DropOffPageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ fraction?: string | string[] }>
}

export async function DropOffPage({ params, searchParams }: DropOffPageProps) {
  const [{ slug }, { fraction }, incoming] = await Promise.all([params, searchParams, headers()])
  const asked = fractionKeyOf(fraction)
  const door = doorFor(incoming)
  let answer = await readDropOffPoints(slug, asked, door)
  // A key the guide named that this project's fractions do not finds no point: ask again for every point, as the page then says it shows.
  const unknown = answer.kind === "ok" && asked !== null && answer.body.fraction === null
  if (unknown) answer = await readDropOffPoints(slug, null, door)
  if (answer.kind === "not-published") notFound()

  if (answer.kind !== "ok") {
    return (
      <main className="min-h-svh bg-background">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
          <p role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground">
            {answer.kind === "too-many" ? COPY.tooMany(answer.retryAfterSeconds) : COPY.unavailable}
          </p>
          <div className="mt-4">
            <PublicNav slug={slug} current="drop-off" />
          </div>
        </div>
      </main>
    )
  }

  const { project, fraction: named, points, truncated } = answer.body
  const language = project.language
  return (
    <main className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
        <header className="space-y-2">
          <p lang={language} className="text-sm font-medium text-muted-foreground">
            {project.name}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{COPY.title}</h1>
          <p className="text-base text-muted-foreground">{COPY.intro}</p>
          <PublicNav slug={slug} current="drop-off" />
        </header>

        {(named !== null || unknown) && (
          <p role="status" className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-foreground">
            {named !== null ? (
              <span>
                {COPY.takes}{" "}
                <span lang={language} className="font-medium">
                  {named.name}
                </span>
              </span>
            ) : (
              <span>{COPY.unknownFraction}</span>
            )}
            {named !== null && (
              <Link href={dropOffHrefOf(slug)} className="font-medium text-primary underline-offset-4 hover:underline">
                {COPY.showAll}
              </Link>
            )}
          </p>
        )}
        {truncated && <p className="mt-3 text-sm text-muted-foreground">{COPY.truncated(points.length)}</p>}

        {points.length === 0 ? (
          <p className="mt-8 text-sm text-foreground">{named !== null ? COPY.nothingFor(named.name) : COPY.nothing}</p>
        ) : (
          <>
            <div className="mt-6">
              <DropOffMapLoader points={mapPointsOf(points)} label={COPY.mapLabel} />
            </div>
            <ul className="mt-6 space-y-3">
              {points.map((point) => (
                <PointCard key={point.id} point={point} language={language} />
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  )
}

function PointCard({ point, language }: { point: PublicDropOffPoint; language: string }) {
  const [today, ...rest] = point.week
  return (
    <li id={pointAnchorOf(point.id)} className="scroll-mt-4 rounded-lg border border-border bg-card p-4 text-card-foreground target:ring-2 target:ring-ring">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 lang={language} className="text-lg font-semibold">
          {point.name}
        </h2>
        <Badge variant="outline" className="text-xs">
          {COPY.kinds[point.kind]}
        </Badge>
      </div>
      <p lang={language} className="mt-1 text-sm text-muted-foreground">
        {point.address}
      </p>
      {today !== undefined && (
        <p className="mt-3 text-sm">
          <span className="font-medium">{COPY.today}: </span>
          {openingTextOf(today)}
          {today.note !== null && (
            <span lang={language} className="text-muted-foreground">
              {" "}
              · {today.note}
            </span>
          )}
        </p>
      )}
      {point.fractions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted-foreground">{COPY.accepts}:</span>
          {point.fractions.map((fraction) => (
            <Badge key={fraction} lang={language} variant="secondary" className="text-sm">
              {fraction}
            </Badge>
          ))}
        </div>
      )}
      {point.publicNote !== null && (
        <p lang={language} className="mt-3 whitespace-pre-line text-sm text-foreground">
          {point.publicNote}
        </p>
      )}
      {rest.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-primary">{COPY.thisWeek}</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {point.week.map((day) => (
              <div key={day.date} className="contents">
                <dt className="text-muted-foreground">
                  <time dateTime={day.date}>{shortDayOf(day.date)}</time>
                </dt>
                <dd>
                  {openingTextOf(day)}
                  {day.note !== null && (
                    <span lang={language} className="text-muted-foreground">
                      {" "}
                      · {day.note}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  )
}
