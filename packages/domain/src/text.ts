// Shared wording helpers: one plural rule so toasts, panels and seeds never
// drift ("3 routes", "2 properties"). English only, enough for the planner
// nouns; anything irregular is spelled out by the caller.

/** "1 route" / "3 routes" / "2 properties" — the count and the noun it counts. */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : pluralOf(noun)}`
}

/** A consonant followed by y becomes -ies ("property"); everything else takes an s ("day", "route"). */
function pluralOf(noun: string): string {
  return /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`
}
