// The public door's own shapes (Issue #293, ADR-0010): the path that names a
// published project, and what an anonymous reader may know of it. The
// project's ids never leave the door; its slug is its public name.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { PublicSlug } from "./organisation"

/** `/public/:slug`: the project published under the slug. */
export const PublicSlugParam = z.object({ slug: PublicSlug })
export type PublicSlugParam = z.infer<typeof PublicSlugParam>

/** A published project as its public pages name it: the slug, the name, and the language and clock its pages speak in. */
export const PublishedProject = z.object({
  slug: PublicSlug,
  name: z.string(),
  /** BCP 47 (`da`): the language its public pages are written in. */
  language: z.string(),
  /** IANA (`Europe/Copenhagen`): the clock its dates are read on. */
  timezone: z.string(),
})
export type PublishedProject = z.infer<typeof PublishedProject>

/** The shortest text an address search takes: a street's first letters, never a listing. */
export const ADDRESS_SEARCH_MIN = 3
/** The longest. */
export const ADDRESS_SEARCH_MAX = 100

/** A resident's address search: at least three characters of the address. */
export const AddressSearch = z.object({ q: z.string().trim().min(ADDRESS_SEARCH_MIN).max(ADDRESS_SEARCH_MAX) })
export type AddressSearch = z.infer<typeof AddressSearch>

/** An address the search found: its id, to ask for its days, and the address as written. Nothing about who lives there. */
export const AddressMatch = z.object({ id: Id, address: z.string() })
export type AddressMatch = z.infer<typeof AddressMatch>

/** The project searched, so a page that searches asks once, and at most ten addresses, by address. */
export const AddressMatches = z.object({ project: PublishedProject, addresses: z.array(AddressMatch) })
export type AddressMatches = z.infer<typeof AddressMatches>

/** `/public/:slug/addresses/:id/…`: the published project and the address. */
export const PublicAddressParam = z.object({ slug: PublicSlug, id: Id })
export type PublicAddressParam = z.infer<typeof PublicAddressParam>

/** The most weeks one read of an address's days spans, and how many when the query names none. */
export const COLLECTION_WEEKS = { max: 26, default: 8 } as const

/** How far ahead an address's days are read, in weeks from today on the project's clock. */
export const CollectionDaysQuery = z.object({
  weeks: z
    .union([z.int(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.int().min(1).max(COLLECTION_WEEKS.max))
    .default(COLLECTION_WEEKS.default),
})
export type CollectionDaysQuery = z.infer<typeof CollectionDaysQuery>

/** One collection at the address: the day, what is collected, and why the day is not the usual one. A skipped day is one the holiday policy leaves out. */
export const PublicCollectionDay = z.object({
  date: IsoDate,
  /** The usual day it stands for; differs from `date` where a holiday or the office moved it. */
  serviceDate: IsoDate,
  fractions: z.array(z.string()),
  status: z.enum(["collected", "skipped"]),
  /** The shift, the holiday, or the skip, in a sentence; null for a usual day. */
  note: z.string().nullable(),
})
export type PublicCollectionDay = z.infer<typeof PublicCollectionDay>

/** An address's collection days: the project, the address, the window read and the days in it. */
export const PublicCollectionDays = z.object({
  project: PublishedProject,
  address: AddressMatch,
  from: IsoDate,
  to: IsoDate,
  days: z.array(PublicCollectionDay),
})
export type PublicCollectionDays = z.infer<typeof PublicCollectionDays>
