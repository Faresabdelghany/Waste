// The Sorting Guide's closed lists (Issue #293, M1), spelled once for the
// database's CHECK and the contracts' `z.enum`, as the Registry's are
// (registry/vocabulary.ts says why one tuple serves both).

/**
 * Where a Sorting Guide Item stands. A draft is the office's alone; a
 * published item is what the public door answers with; a withdrawn one is
 * kept, since there is no delete, and answers nobody.
 */
export const SORTING_GUIDE_ITEM_STATUSES = ["draft", "published", "withdrawn"] as const

export type SortingGuideItemStatus = (typeof SORTING_GUIDE_ITEM_STATUSES)[number]

/** The status the public door reads, and the only one. */
export const PUBLISHED_ITEM: SortingGuideItemStatus = "published"
