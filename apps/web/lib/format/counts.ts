// How a count reads: its thousands separated, and with its noun, plural but
// for one. The domain's `count` spells a count bare ("3 routes"); these
// separate its thousands, as a report's figures read ("1,204 pickups").
const counts = new Intl.NumberFormat("en")

/** A count with its thousands separated. */
export const countOf = (value: number): string => counts.format(value)

/** A count and its noun, the noun plural but for one: "1 unload", "3 unloads", "1,204 pickups". */
export const countedOf = (value: number, noun: string): string => `${countOf(value)} ${value === 1 ? noun : `${noun}s`}`
