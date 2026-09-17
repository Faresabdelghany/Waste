// Cursor pagination for every list endpoint. The cursor is opaque to clients:
// the server encodes where the page ended, the client hands it back unread.
// Offsets are not offered; they drift as rows are inserted.
import { z } from "zod"

export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 200

/** Query parameters of a list request. `limit` is coerced from the query string. */
export const PageRequest = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
})
export type PageRequest = z.infer<typeof PageRequest>

/** One page of items and the cursor of the next page, `null` on the last one. */
export function Page<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).nullable(),
  })
}
export type Page<Item> = { items: Item[]; nextCursor: string | null }
