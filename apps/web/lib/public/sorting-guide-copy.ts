// What the public Sorting Guide page says (Issue #293, M1), in one place, so
// the UI translation (M21) moves it into its messages whole. English until
// then; the page marks itself with the project's own language for the
// content the office wrote, which is the project's.

export const SORTING_GUIDE_COPY = {
  title: "Sorting guide",
  intro: "Search for something you want to throw away to see which bin it goes in and how to hand it in.",
  label: "What do you want to throw away?",
  placeholder: "For example: pizza box, batteries, glass jar",
  search: "Search",
  results: (count: number, query: string) => (count === 1 ? `1 result for “${query}”` : `${count} results for “${query}”`),
  nothing: (query: string) => `Nothing in the guide matches “${query}”. Try a shorter or a different word.`,
  matchedAs: (matched: string) => `Matched “${matched}”`,
  alsoCalled: "Also called",
  noFraction: "Not for a bin at home",
  tooMany: (seconds: number) => `Too many searches from your connection just now. Try again in ${seconds} seconds.`,
  unavailable: "The sorting guide can't be reached right now. Please try again in a moment.",
} as const
