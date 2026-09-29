// How a list answers: one page of items and an opaque cursor for the next
// one (@waste/contracts/pagination — `PageRequest` in, `Page(item)` out).
//
// The rule, once, for every list in the API. Rows come back ordered by `id`
// ascending, which for a version 7 id is the order they were made in
// (ADR-0004), and the cursor is the last item's id: the next page is "the
// same query, after that id". No offsets — they drift under inserts and make
// the database count rows it will throw away — and no total, which would be a
// second query for a number a list view does not need.
//
// Postgres orders a `uuid` by its bytes and the id is written lowercase, so
// `id > :cursor` in SQL and `b > a` in TypeScript are the same order: a page
// boundary means the same thing on both sides.
//
// The cursor is base64url of the id, which is opaque enough to say "hand it
// back, do not read it" and safe in a query string unescaped. It is validated
// on the way in: a cursor that is not one of ours is a 400 naming `cursor`,
// not an empty page and not a 500 from Postgres refusing a malformed uuid.
//
// A list that reads newest first (a scheme's generation runs, Issue #97 part
// B) orders by `id` descending under the same cursor: the last item's id, the
// next page being the rows below it (`lt` where an ascending list says `gt`).
// The cursor does not carry a direction, since a list has only one.
//
// Whether there is a next page is a question about a row the page does not
// contain, so a route asks the database for `fetchLimit(limit)` rows and
// hands them all to `pageOf`, which keeps the page and turns the surplus into
// the cursor.
import { Id } from "@waste/contracts/ids"

import { invalidRequest } from "./problem"

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** The cursor that points just after this id. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url")
}

/**
 * The id a cursor points after, or undefined when the cursor is not one of
 * ours. Strict on the way back: base64url decoding ignores what it does not
 * understand, so the cursor must re-encode to itself, and what it holds must
 * be an id.
 */
export function decodeCursor(cursor: string): string | undefined {
  if (!BASE64URL.test(cursor)) return undefined
  const decoded = Buffer.from(cursor, "base64url").toString("utf8")
  if (encodeCursor(decoded) !== cursor) return undefined
  const id = Id.safeParse(decoded)
  return id.success ? id.data : undefined
}

/**
 * The id a list should read after, from the request's cursor: undefined for
 * the first page, a 400 naming `cursor` for anything we did not write.
 */
export function afterCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  const id = decodeCursor(cursor)
  if (id === undefined) {
    throw invalidRequest("query", [{ path: "cursor", message: "Hand back the `nextCursor` of the page before this one, unread" }])
  }
  return id
}

/** How many rows to ask the database for: the page, and one to see whether there is another page. */
export function fetchLimit(limit: number): number {
  return limit + 1
}

/** One page of items and where the next one starts. */
export type Paged<Item> = {
  items: Item[]
  /** The cursor to ask for the next page with; null on the last page. */
  nextCursor: string | null
}

/** The page out of what `fetchLimit(limit)` rows came back: the surplus row is the proof there is a next page, never an item. */
export function pageOf<Item extends { id: string }>(rows: readonly Item[], limit: number): Paged<Item> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`a page size is a whole number of rows, at least one, not ${limit}`)
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null }
}
