// Time on the wire. Two shapes only: a calendar day for anything planned by
// date (a Collection Calendar entry, a Route's service date) and an instant
// with its UTC offset for anything that happened (a Pickup's Completed-at).
// A wall-clock time without an offset is ambiguous and is rejected.
import { z } from "zod"

/** A calendar day, `YYYY-MM-DD`. */
export const IsoDate = z.iso.date()
export type IsoDate = z.infer<typeof IsoDate>

/** An instant as RFC 3339 with seconds and a UTC offset (`Z` or `±hh:mm`). */
export const IsoDateTime = z.iso.datetime({ offset: true })
export type IsoDateTime = z.infer<typeof IsoDateTime>
