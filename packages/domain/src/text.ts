// Text a person types, and the words the system answers with.
//
// A label is present, not blank, and bounded. Blank is refused rather than
// trimmed away: the value the caller sent is the value the database stores.
// The bound is 200 characters — longer than any name, registration number or
// scope a person types, short enough that a body cannot carry a megabyte into
// a `text` column that has no length of its own. A paragraph is the same rule
// with the bound prose needs: an address, a condition, a note. A key is a
// slug the rest of the system quotes (`residual`, `hard-plastic`,
// `rear-loader`): lowercase letters and digits in words joined by single
// hyphens, so two keys cannot differ by case or spacing alone.
//
// `count` spells a count once, so toasts, panels and seeds never drift ("3
// routes", "2 properties"). No linguistics: the default plural is a plain s
// and the caller spells anything else.

/** The longest a label may be. Generous for a name, far short of an essay. */
export const LABEL_MAX = 200

/** The longest a paragraph may be. Room for an address, a condition or a note; still not a document. */
export const PARAGRAPH_MAX = 2000

/** The longest a key may be: a slug the rest of the system quotes, not a sentence. */
export const KEY_MAX = 50

/** Whether a text says something: anything but whitespace. */
export const saysSomething = (text: string): boolean => text.trim().length > 0

/** What a blank text is told, a name and a note alike. */
export const SOMETHING_OTHER_THAN_WHITESPACE = "Give something other than whitespace"

/** A key's shape, as a regular expression's source: lowercase words of letters and digits joined by single hyphens. */
export const SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$"

/** What a key of another shape is told. */
export const SLUG_SHAPE = "a lowercase slug of letters, digits and single hyphens, such as food, hard-plastic or rear-loader"

/** "1 route" / "3 routes" / "2 properties" — the count and the noun it counts. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`
}
