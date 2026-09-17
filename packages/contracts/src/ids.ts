// Record identity on the wire. Ids are UUID version 7: time-ordered, which
// keeps inserts append-friendly. The server mints them for web writes
// (ADR-0001: the API is the single data path); a driver's device mints them
// for the commands it queues offline, so the same command replayed twice is
// one record (ADR-0004). Generating one needs a clock and randomness; no
// generator lives here yet, and a shared one would have to be pure
// (timestamp and random bytes passed in).
//
// RFC 9562 parses both cases and writes lowercase; so does this schema, so one
// id never circulates as two strings.
import * as z from "zod"

/** A record id: a UUID version 7, normalised to lowercase. */
export const Id = z.uuidv7().toLowerCase()
export type Id = z.infer<typeof Id>
