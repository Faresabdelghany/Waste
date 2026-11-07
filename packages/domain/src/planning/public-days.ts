// What a resident asks the public door of an address's collection days
// (ADR-0010, M2 of #293): an address found by the first letters a person
// types, never a listing, and its days a few weeks ahead, each collected or
// skipped by the holiday policy.

/** The shortest and longest text an address search takes: a street's first letters, never a listing. */
export const ADDRESS_SEARCH = { min: 3, max: 100 } as const

/** The most weeks one read of an address's days spans, and how many when the query names none. */
export const COLLECTION_WEEKS = { max: 26, default: 8 } as const

/** What a day at an address is: collected, on its usual day or moved, or skipped by the holiday policy. A reading, never stored. */
export const COLLECTION_DAY_STATUSES = ["collected", "skipped"] as const
export type CollectionDayStatus = (typeof COLLECTION_DAY_STATUSES)[number]
