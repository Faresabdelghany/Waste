// Cursor pagination for every list endpoint. The cursor is opaque to clients:
// the server encodes where the page ended, the client hands it back unread.
// Offsets are not offered; they drift as rows are inserted.
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@waste/domain/requests"
import * as z from "zod"

import { QueryWhole } from "./query-numbers"

/** Present or absent, never empty: absent means the first page. */
const Cursor = z.string().min(1)

/** A page size from a query string or a JSON body, a whole number spelled plainly. An empty string or null means "not given" and takes the default. */
const Limit = z.preprocess((value) => (value === "" || value === null ? undefined : value), QueryWhole.pipe(z.int().min(1).max(PAGE_LIMIT_MAX)).default(PAGE_LIMIT_DEFAULT))

/** Query parameters of a list request. */
export const PageRequest = z.object({
  limit: Limit,
  cursor: Cursor.optional(),
})
export type PageRequest = z.infer<typeof PageRequest>

/** One page of items and the cursor of the next page, `null` on the last one. */
export function Page<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
  })
}
