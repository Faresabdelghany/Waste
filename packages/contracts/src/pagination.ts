// Cursor pagination for every list endpoint. The cursor is opaque to clients:
// the server encodes where the page ended, the client hands it back unread.
// Offsets are not offered; they drift as rows are inserted.
import * as z from "zod"

export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 200

/** Present or absent, never empty: absent means the first page. */
const Cursor = z.string().min(1)

/**
 * A page size from a query string or a JSON body: a whole number, or a string
 * of decimal digits. An empty string or null means "not given" and takes the
 * default. Nothing else is coerced: `true`, `["25"]`, `"0x19"` and `"1e1"`
 * are refused rather than read as 1, 25, 25 and 10.
 */
const Limit = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z
    .union([z.int(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.int().min(1).max(PAGE_LIMIT_MAX))
    .default(PAGE_LIMIT_DEFAULT),
)

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
