// What the public Drop-off Points map says (Issue #293, M3b), in one place,
// so the UI translation (M21) moves it into its messages whole. English until
// then; what the office wrote — the project's name, a point's name, address,
// fractions and note — is marked with the project's language.

export const DROP_OFF_COPY = {
  title: "Drop-off points",
  intro: "Recycling centres and bring banks where you can hand in what your bins at home don't take.",
  mapLabel: "Map of the drop-off points",
  takes: "Points that take",
  showAll: "Show every point",
  nothingFor: (fraction: string) => `No drop-off point takes ${fraction} yet.`,
  nothing: "No drop-off points are on the map yet.",
  unknownFraction: "The sorting guide's link names no fraction this project knows. Here is every point.",
  openAllDay: "Open all day",
  closed: "Closed",
  /** Between two of a day's windows: `08:00–11:00 and 13:00–17:00`. */
  windowsJoin: " and ",
  truncated: (count: number) => `Showing the first ${count} points by name. Look up an item in the sorting guide to see the points that take it.`,
  kinds: { "recycling-centre": "Recycling centre", "bring-bank": "Bring bank" },
  today: "Today",
  thisWeek: "Opening this week",
  accepts: "Takes",
  tooMany: (seconds: number) => `Too many requests from your connection just now. Try again in ${seconds} seconds.`,
  unavailable: "The drop-off points can't be shown right now. Please try again in a moment.",
  whereToHandIn: "Where to hand it in",
  findDropOff: "Find a drop-off point",
} as const
