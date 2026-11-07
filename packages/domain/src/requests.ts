// What every request is held to, whatever its resource: a whole number fits
// the column it lands in, a patch changes something, a set names each entry
// once, a page is bounded, and a number a query string spells is spelled
// plainly; and what every refusal is.

/**
 * The bounds of Postgres's `integer`, the column every whole number a body
 * writes lands in. A number past them would reach the database and come back
 * as 22003, a 500; held at the boundary, it is the 400 naming its field.
 */
export const INT4_MAX = 2_147_483_647
export const INT4_MIN = -2_147_483_648

/** Whether a number a route computed from a body — a quantity times a price, an indexed fee — still fits an `integer` column. */
export const fitsInt4 = (value: number): boolean => Number.isInteger(value) && value >= INT4_MIN && value <= INT4_MAX

/** Whether a patch changes something: a patch with nothing in it is a request that means nothing. */
export const changesSomething = (patch: object): boolean => Object.keys(patch).length > 0

/** What an empty patch is told. */
export const SOMETHING_TO_CHANGE = "Give at least one field to change"

/**
 * Each entry of a set names its thing once, as the database's key insists:
 * the one rule behind every distinct-entries check (a set of days, a rule's
 * fractions, a group's containers, a calendar's holidays by day). `key` says
 * what identifies an entry; the entry itself by default.
 */
export const eachOnce = <Entry>(entries: readonly Entry[], key: (entry: Entry) => unknown = (entry) => entry): boolean => new Set(entries.map(key)).size === entries.length

/**
 * What a set with an entry twice is told, one shape for every set: "Name each
 * <subject> once: <reason>". A set spells its subject, and a reason only
 * where the rule has one of its own (a container has one place in a stop
 * order); otherwise the set either holds the thing or it does not.
 */
export const eachOnceSentence = (subject: string, reason = "the set holds it or it does not"): string => `Name each ${subject} once: ${reason}`

/**
 * The most entries a set body may carry: a form's list, not an import. A
 * resource carries the same entries unbounded, since a set already stored has
 * to parse however long it grew.
 */
export const SET_MAX = 200

/** How many items a page answers when the request names no limit, and the most it may name. */
export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 200

/** A whole number as a query string spells it: decimal digits and nothing else — no sign, no hex, no exponent, no blank. */
export const WHOLE_NUMBER_PATTERN = "^\\d+$"

/** A decimal number as a query string spells it: `12.5683` or `-0.5`, and nothing looser. */
export const DECIMAL_PATTERN = "^-?\\d+(\\.\\d+)?$"

/** What a query's number of another spelling is told. */
export const DECIMAL_SHAPE = "a decimal number"

/** What every refusal is (RFC 9457): its body's media type, the `type` of one that is nothing more than its status, and the statuses one may carry. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json"
export const BLANK_PROBLEM_TYPE = "about:blank"
export const PROBLEM_STATUS = { min: 400, max: 599 } as const
