"use client"

// Small pieces both Driver App screens draw: a rejected command's sentence,
// dismissible, the display cache's notice, and the words for a day and a
// route's progress.
import Link from "next/link"
import type { ComponentProps, MouseEvent } from "react"
import { ClockCounterClockwise, X } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { useDriverAppState } from "@/components/waste/driver/driver-app-provider"
import type { RouteProgress } from "@waste/contracts/routes"
import type { Rejection } from "@/lib/driver/driver-app"
import { keptNotice } from "@/lib/driver/route-view"

/** The sentences the server answered rejected commands with, each dismissible. */
export function RejectionList({ rejections, onDismiss }: { rejections: readonly Rejection[]; onDismiss: (commandId: string) => void }) {
  if (rejections.length === 0) return null
  return (
    <ul className="flex flex-col gap-2">
      {rejections.map((rejection) => (
        <li key={rejection.commandId} role="alert" className="flex items-start justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{rejection.sentence}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => onDismiss(rejection.commandId)}>
            <X aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** `2027-01-15` as a phone shows it: "Fri 15 Jan". The date is a calendar day, so it is read and written in UTC and never shifts. */
/**
 * A link between the Driver App's screens (O25 of #290): the app's own
 * navigation while the server answers, a whole page load while it does not —
 * the app's in-place move asks the server for the next screen and waits on
 * it, where a page load is answered by the shell's kept page.
 */
export function DriverLink({ href, onClick, ...props }: ComponentProps<typeof Link> & { href: string }) {
  const { unreachable } = useDriverAppState()
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !(unreachable || navigator.onLine === false)) return
    event.preventDefault()
    window.location.assign(href)
  }
  return <Link href={href} onClick={follow} {...props} />
}

/** A read the display cache stands in for (O25 of #290): the server's last answer, said so with when it came; nothing while the read is live. */
export function KeptNotice({ readAt }: { readAt: string | null | undefined }) {
  if (readAt == null) return null
  return (
    <p role="note" aria-label="Offline copy" className="flex gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <ClockCounterClockwise aria-hidden className="mt-0.5 shrink-0" />
      {keptNotice(readAt)}
    </p>
  )
}

export function operatingDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
}

/** "3 of 12 stops done". */
export function progressLine(progress: RouteProgress): string {
  const done = progress.total - progress.planned
  return `${done} of ${progress.total} ${progress.total === 1 ? "stop" : "stops"} done`
}
