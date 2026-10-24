// The search a public page's URL asks for (Issue #293): the Sorting Guide's
// and the address search's, one rule.

/** The first `q`, trimmed and cut to the door's `max`; null for none or blank. */
export function searchQueryOf(q: string | string[] | undefined, max: number): string | null {
  const first = Array.isArray(q) ? q[0] : q
  const trimmed = first?.trim().slice(0, max).trim() ?? ""
  return trimmed === "" ? null : trimmed
}
