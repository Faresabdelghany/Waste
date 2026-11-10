// How a count reads: its thousands separated, and with its noun, plural but
// for one. The domain's `count` spells a count bare ("3 routes"); these
// separate its thousands, as a report's figures read ("1,204 pickups").
const counts = new Intl.NumberFormat("en")

export const countOf = (value: number): string => counts.format(value)

export const countedOf = (value: number, noun: string): string => `${countOf(value)} ${value === 1 ? noun : `${noun}s`}`
