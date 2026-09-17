// Shared wording helpers for the scheme planners' consequence lines
// (creation.ts, edit.ts, deletion.ts) — one plural rule so toasts never drift.

/** "1 route" / "3 routes" — naive English plural, enough for the planner nouns. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
