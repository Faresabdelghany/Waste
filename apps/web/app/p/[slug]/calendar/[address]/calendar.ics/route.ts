// An address's collection days as an iCalendar feed (Issue #293, M2b), on the
// web's own origin: read from the public door on the server like the pages,
// the visitor or calendar app named the same way, and answered as
// lib/public/collection-days.ts's feedResponseOf says.
import { headers } from "next/headers"

import { FEED_WEEKS, feedResponseOf, isAddressId } from "@/lib/public/collection-days"
import { doorFor, readCollectionFeed } from "@/lib/public/door"

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; address: string }> }) {
  const [{ slug, address }, incoming] = await Promise.all([params, headers()])
  if (!isAddressId(address)) return feedResponseOf({ kind: "not-published" })
  return feedResponseOf(await readCollectionFeed(slug, address, FEED_WEEKS, doorFor(incoming)))
}
