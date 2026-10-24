// What the public Collection Days pages say (Issue #293, M2b), in one place, so
// the UI translation (M21) moves it into its messages whole. English until
// then; the page marks itself with the project's own language for the
// addresses and fractions the office wrote, which are the project's.

export const COLLECTION_DAYS_COPY = {
  title: "Collection days",
  intro: "Find your address to see when your bins are collected, holidays included.",
  label: "Your address",
  placeholder: "Street name and number",
  search: "Find",
  tooShort: (min: number) => `Type at least ${min} letters of your address.`,
  results: (count: number, query: string) => (count === 1 ? `1 address matches “${query}”` : `${count} addresses match “${query}”`),
  nothing: (query: string) => `No address with collections matches “${query}”. Try the street name and house number.`,
  weeksLabel: "Show",
  weeks: (weeks: number) => `${weeks} weeks`,
  shown: (weeks: number) => `The next ${weeks} weeks`,
  noDays: "Nothing is planned for collection at this address in these weeks.",
  skipped: "No collection",
  subscribe: "Subscribe in your calendar",
  download: "Download (.ics)",
  print: "Print",
  feedAddress: "Calendar address",
  feedHint: "Paste this into a calendar app that adds a calendar from a URL. It stays up to date as days move.",
  anotherAddress: "Another address",
  fullCalendar: "Full calendar",
  pagesLabel: "This project's pages",
  tooMany: (seconds: number) => `Too many requests from your connection just now. Try again in ${seconds} seconds.`,
  unavailable: "Collection days can't be shown right now. Please try again in a moment.",
} as const
