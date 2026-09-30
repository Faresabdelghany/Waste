"use client"

// Small pieces both Driver App screens draw: a rejected command's sentence,
// dismissible, and the words for a day and a route's progress.
import { X } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import type { RouteProgress } from "@waste/contracts/routes"
import type { Rejection } from "@/lib/driver/driver-app"

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
export function operatingDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
}

/** "3 of 12 stops done". */
export function progressLine(progress: RouteProgress): string {
  const done = progress.total - progress.planned
  return `${done} of ${progress.total} ${progress.total === 1 ? "stop" : "stops"} done`
}
