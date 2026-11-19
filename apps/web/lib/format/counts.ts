// How a count reads: its thousands separated, and with its noun, plural but
// for one. The domain's `count` spells a count bare ("3 routes"); these
// separate its thousands, as a report's figures read ("1,204 pickups").
const counts = new Intl.NumberFormat("en")

export const countOf = (value: number): string => counts.format(value)

const pluralWord = (word: string): string => {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  return `${word}s`
}

/**
 * The plural of a noun as the UI names its records: the last word of each side
 * of an "or" made plural ("area or zone" → "areas or zones", "property" →
 * "properties"), never a bare "s" appended (#653).
 */
export const pluralOf = (noun: string): string =>
  noun
    .split(" or ")
    .map((part) => part.replace(/[A-Za-z]+$/, pluralWord))
    .join(" or ")

export const countedOf = (value: number, noun: string): string => `${countOf(value)} ${value === 1 ? noun : pluralOf(noun)}`
