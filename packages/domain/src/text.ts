// Shared wording helpers: one place to spell a count, so toasts, panels and
// seeds never drift ("3 routes", "2 properties"). No linguistics: the
// default plural is a plain s and the caller spells anything else.

/** "1 route" / "3 routes" / "2 properties" — the count and the noun it counts. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`
}
