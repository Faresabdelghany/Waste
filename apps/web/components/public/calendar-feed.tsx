"use client"

// The Collection Days page's two browser-side controls (Issue #293, M2b): the
// feed's links, which need the origin the visitor reached to spell `webcal:`,
// and the print button. Without JavaScript the Subscribe link is the feed's
// own path, which a browser downloads, and the page prints from the
// browser's menu with the same print styles.
import { CalendarPlus, DownloadSimple, Printer } from "@phosphor-icons/react"
import { useSyncExternalStore } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { feedUrlsOf } from "@/lib/public/collection-days"
import { COLLECTION_DAYS_COPY as COPY } from "@/lib/public/collection-days-copy"

const unchanging = () => () => {}

/** The origin this page was reached on; null on the server and while hydrating. */
const useOrigin = () =>
  useSyncExternalStore(
    unchanging,
    () => window.location.origin,
    () => null,
  )

export function CalendarFeed({ feedPath }: { feedPath: string }) {
  const origin = useOrigin()
  const urls = origin === null ? null : feedUrlsOf(origin, feedPath)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button asChild className="h-10 gap-2">
          <a href={urls?.webcal ?? feedPath}>
            <CalendarPlus aria-hidden="true" className="size-4" />
            {COPY.subscribe}
          </a>
        </Button>
        <Button asChild variant="outline" className="h-10 gap-2">
          <a href={feedPath} download="collection-days.ics">
            <DownloadSimple aria-hidden="true" className="size-4" />
            {COPY.download}
          </a>
        </Button>
        <Button type="button" variant="outline" className="h-10 gap-2" onClick={() => window.print()}>
          <Printer aria-hidden="true" className="size-4" />
          {COPY.print}
        </Button>
      </div>
      {urls !== null && (
        <div className="space-y-1">
          <label htmlFor="calendar-feed-url" className="text-xs font-medium text-muted-foreground">
            {COPY.feedAddress}
          </label>
          <Input id="calendar-feed-url" readOnly value={urls.https} onFocus={(event) => event.currentTarget.select()} className="h-9 font-mono text-xs" />
          <p className="text-xs text-muted-foreground">{COPY.feedHint}</p>
        </div>
      )}
    </div>
  )
}
