// Record identity on the wire (ADR-0001: the API is the single data path, so
// ids are minted by the server, never by a client). UUID version 7 is time-
// ordered, which keeps inserts append-friendly; generating one needs a clock
// and randomness, so generation lives in apps/api, not here.
import { z } from "zod"

/** A record id: a UUID version 7 as a lower- or upper-case string. */
export const Id = z.uuidv7()
export type Id = z.infer<typeof Id>
