// The public door's own shapes (Issue #293, ADR-0010): the path that names a
// published project, and what an anonymous reader may know of it. The
// project's ids never leave the door; its slug is its public name.
import { ADDRESS_SEARCH, COLLECTION_DAY_STATUSES, COLLECTION_WEEKS } from "@waste/domain/planning/public-days"
import * as z from "zod"

import { IsoDate, IsoTime } from "./dates"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { ProjectBranding, PublicSlug } from "./organisation"
import { QueryWhole } from "./query-numbers"
import { DropOffPointKind } from "./resources"
import { Slug } from "./text"

/** `/public/:slug`: the project published under the slug. */
export const PublicSlugParam = z.object({ slug: PublicSlug })
export type PublicSlugParam = z.infer<typeof PublicSlugParam>

/** A published project as its public pages name it: the slug, the name, the language and clock its pages speak in, and its branding (M22). */
export const PublishedProject = z.object({
  slug: PublicSlug,
  name: z.string(),
  /** BCP 47 (`da`): the language its public pages are written in. */
  language: z.string(),
  /** IANA (`Europe/Copenhagen`): the clock its dates are read on. */
  timezone: z.string(),
  /** The project's colour, logo and accessibility statement, each null where it set none (`PUT /projects/:id/branding`). */
  branding: ProjectBranding,
})
export type PublishedProject = z.infer<typeof PublishedProject>

/** A resident's address search: a street's first letters, never a listing. */
export const AddressSearch = z.object({ q: z.string().trim().min(ADDRESS_SEARCH.min).max(ADDRESS_SEARCH.max) })
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

/** How far ahead an address's days are read, in weeks from today on the project's clock. */
export const CollectionDaysQuery = z.object({
  weeks: QueryWhole.pipe(z.int().min(1).max(COLLECTION_WEEKS.max)).default(COLLECTION_WEEKS.default),
})
export type CollectionDaysQuery = z.infer<typeof CollectionDaysQuery>

/** One collection at the address: the day, what is collected, and why the day is not the usual one. A skipped day is one the holiday policy leaves out. */
export const PublicCollectionDay = z.object({
  date: IsoDate,
  /** The usual day it stands for; differs from `date` where a holiday or the office moved it. */
  serviceDate: IsoDate,
  fractions: z.array(z.string()),
  status: z.enum(COLLECTION_DAY_STATUSES),
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

/** The public map's question: the fraction a resident brings, by its key; every point on the map when absent. */
export const DropOffPointsQuery = z.object({ fraction: Slug().optional() })
export type DropOffPointsQuery = z.infer<typeof DropOffPointsQuery>

/** One day's opening at a point: its windows, or open all day, and why it is not the usual (an exception's note, a holiday's name). */
export const PublicOpeningDay = z.object({
  date: IsoDate,
  windows: z.array(z.object({ opensAt: IsoTime, closesAt: IsoTime })),
  allDay: z.boolean(),
  note: z.string().nullable(),
})
export type PublicOpeningDay = z.infer<typeof PublicOpeningDay>

/** A Drop-off Point as the public map draws it: never its code or the office's notes. */
export const PublicDropOffPoint = z.object({
  id: Id,
  name: z.string(),
  kind: DropOffPointKind,
  address: z.string(),
  location: FlatPoint,
  /** The fractions it takes, by name. */
  fractions: z.array(z.string()),
  publicNote: z.string().nullable(),
  /** The next `DROP_OFF_WEEK_DAYS` days from today, with exceptions and the project's holidays applied. */
  week: z.array(PublicOpeningDay),
})
export type PublicDropOffPoint = z.infer<typeof PublicDropOffPoint>

/**
 * A published project's drop-off points on the map, by name: the project, the
 * fraction asked for, by its key and name (null when none was asked, or the
 * key names no fraction of the company's, which finds no point), the first
 * day of the week read, and the points.
 */
export const PublicDropOffPoints = z.object({
  project: PublishedProject,
  fraction: z.object({ key: z.string(), name: z.string() }).nullable(),
  from: IsoDate,
  points: z.array(PublicDropOffPoint),
  /** More points stood than one read carries (a city's bring banks past a thousand), the first by name answered: ask by fraction to see the rest. */
  truncated: z.boolean(),
})
export type PublicDropOffPoints = z.infer<typeof PublicDropOffPoints>
