/** "1 record", "12 records", or "3 of 12 records": a table's count line, the noun agreeing with the total. */
export function recordCountLabel(shown: number, total: number = shown): string {
  const noun = total === 1 ? "record" : "records"
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
}

/**
 * What an empty table says beneath its message when its search or filters hide every row it has, and only then:
 * a table with no rows at all is not helped by another search.
 */
export const NARROWED_HINT = "Try a different search or filter."
