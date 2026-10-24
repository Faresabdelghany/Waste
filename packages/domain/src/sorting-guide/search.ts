// What a resident's search of the Sorting Guide finds (Issue #293, M1): the
// items whose name or a synonym matches what was typed, best first. The
// public door runs it over a project's published items, which number in the
// hundreds, so it ranks in memory rather than in the database: one rule,
// tested here, with no extension to install and no index to keep.
//
// Text is compared normalised: lowercase, the Danish letters folded onto the
// two-letter spellings people type without them (æ → ae, ø → oe, å → aa, so
// "aal" finds "Ål"), other diacritics dropped, punctuation and runs of space
// collapsed. A term — the name or one synonym — then matches in the first of
// these ways that holds, each worth less than the one before:
//
//   the whole term                                  100
//   the term with its spaces taken out (compounds)   95  "pizza bakke" → "Pizzabakke"
//   the start of the term                            80
//   the start of a later word                        70
//   anywhere inside it, from three letters           60
//   every word of the query at a word of the term    55  less 5 per typo
//   one word, near the start of a word               40  less 10 per typo
//
// A typo is an edit (a letter changed, added, dropped, or two neighbours
// swapped): none in a word shorter than four letters, one up to seven, two
// from eight. A synonym's match is worth 5 less than the name's, so an item
// named for the query outranks one that only lists it. Ties are in the
// names' order.

/** One entry the search ranks: an item's id, its name and the other words it is known by. */
export type GuideEntry = { id: string; name: string; synonyms: readonly string[] }

/** An entry the query found, its score, and the name or synonym that matched as it was written. */
export type GuideMatch<T extends GuideEntry> = { entry: T; score: number; matched: string }

/** How many matches a search answers with when the caller names no limit. */
export const DEFAULT_GUIDE_LIMIT = 10

const SYNONYM_PENALTY = 5
const FOLDED: Record<string, string> = { æ: "ae", ø: "oe", å: "aa", ä: "ae", ö: "oe", ü: "ue", ß: "ss" }

/** The text as the search compares it: lowercase, Danish letters folded, other marks dropped, punctuation as space. */
export function normalise(text: string): string {
  // Composed first, so an "å" typed as "a" and a combining ring folds like the one character.
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[æøåäöüß]/g, (letter) => FOLDED[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** The typos a word of this length may carry and still match. */
export function allowedDistance(length: number): number {
  if (length < 4) return 0
  return length < 8 ? 1 : 2
}

/**
 * The edits between two words (optimal string alignment: a letter changed,
 * added or dropped, or two neighbours swapped). Past `bound` it answers
 * `bound + 1` without finishing, since no caller wants the exact count then.
 */
export function editDistance(a: string, b: string, bound = Math.max(a.length, b.length)): number {
  if (Math.abs(a.length - b.length) > bound) return bound + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMinimum = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] ?? 0) + 1)
      }
      current.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > bound) return bound + 1
    before = previous
    previous = current
  }
  return Math.min(previous[b.length] ?? 0, bound + 1)
}

/** The fewest typos between a query word and a term word, comparing the query with the whole word and with as much of its start as the query is long; past the allowance, Infinity. */
function typos(queryWord: string, termWord: string): number {
  const allowed = allowedDistance(queryWord.length)
  if (termWord.startsWith(queryWord)) return 0
  const best = Math.min(editDistance(queryWord, termWord, allowed), editDistance(queryWord, termWord.slice(0, queryWord.length), allowed))
  return best <= allowed ? best : Number.POSITIVE_INFINITY
}

/** What one normalised term scores against the normalised query; 0 is no match. */
function termScore(term: string, query: string): number {
  if (term === "") return 0
  if (term === query) return 100
  const compactTerm = term.replaceAll(" ", "")
  const compactQuery = query.replaceAll(" ", "")
  if (compactTerm === compactQuery) return 95
  if (term.startsWith(query) || (compactQuery !== query && compactTerm.startsWith(compactQuery))) return 80
  const termWords = term.split(" ")
  if (termWords.slice(1).some((word) => word.startsWith(query))) return 70
  if (query.length >= 3 && term.includes(query)) return 60

  const queryWords = query.split(" ")
  if (queryWords.length > 1) {
    let total = 0
    for (const queryWord of queryWords) {
      const fewest = Math.min(...termWords.map((word) => typos(queryWord, word)))
      if (!Number.isFinite(fewest)) return 0
      total += fewest
    }
    // A query of many words with typos in each is no longer a match, however many words it adds.
    return Math.max(0, 55 - 5 * total)
  }
  const fewest = Math.min(...termWords.map((word) => typos(query, word)))
  return Number.isFinite(fewest) ? 40 - 10 * fewest : 0
}

/** The entries the query finds, best first and names in order on a tie, at most `limit` of them. */
export function searchGuide<T extends GuideEntry>(entries: readonly T[], query: string, limit = DEFAULT_GUIDE_LIMIT): GuideMatch<T>[] {
  const normalised = normalise(query)
  if (normalised === "") return []
  const matches: (GuideMatch<T> & { sortKey: string })[] = []
  for (const entry of entries) {
    let best: GuideMatch<T> | undefined
    const name = normalise(entry.name)
    const terms = [{ text: entry.name, normalised: name, penalty: 0 }, ...entry.synonyms.map((text) => ({ text, normalised: normalise(text), penalty: SYNONYM_PENALTY }))]
    for (const term of terms) {
      const score = termScore(term.normalised, normalised) - term.penalty
      if (score <= 0) continue
      if (best === undefined || score > best.score) best = { entry, score, matched: term.text }
    }
    if (best !== undefined) matches.push({ ...best, sortKey: name })
  }
  matches.sort((a, b) => b.score - a.score || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0) || (a.entry.id < b.entry.id ? -1 : 1))
  return matches.slice(0, limit).map(({ entry, score, matched }) => ({ entry, score, matched }))
}
