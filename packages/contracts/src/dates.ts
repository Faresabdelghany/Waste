// Time on the wire. Three shapes: a calendar day for anything planned by
// date (a Collection Calendar entry, a Route's service date), an instant with
// its UTC offset for anything that happened (a Pickup's Completed-at), and a
// time of day for a plan on a project's clock (a Route Scheme's planned start,
// Issue #97). A wall-clock date-time without an offset is ambiguous and is
// rejected; a bare time of day is not, because it names no instant — it is
// read against the project's timezone on the day it is used, and an offset
// on it would say something the scheme does not know.
import * as z from "zod"

/** A calendar day, `YYYY-MM-DD`. */
export const IsoDate = z.iso.date()
export type IsoDate = z.infer<typeof IsoDate>

/** An instant as RFC 3339 with seconds and a UTC offset (`Z` or `±hh:mm`). */
export const IsoDateTime = z.iso.datetime({ offset: true })
export type IsoDateTime = z.infer<typeof IsoDateTime>

/** A time of day on the project's clock, `HH:MM`: no seconds, no offset. Postgres spells its `time` with seconds; the API drops them. */
export const IsoTime = z.iso.time({ precision: -1 })
export type IsoTime = z.infer<typeof IsoTime>
