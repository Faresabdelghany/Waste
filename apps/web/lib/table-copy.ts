import { problemSentence, type Problem } from "./api/problem"

export function recordCountLabel(shown: number, total: number = shown): string {
  const noun = total === 1 ? "record" : "records"
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
}

/** A list's count above its table, none while its read has not answered: a zero is an answer (#655). */
export function listCountLabel(shown: number, total: number, answered: boolean): string | null {
  return answered ? recordCountLabel(shown, total) : null
}

/** The range a paged table shows beneath it; its empty label once it has answered with no rows, nothing before (#655). */
export function pageRangeLabel({ page, pageSize, totalCount, emptyLabel, answered }: { page: number; pageSize: number; totalCount: number; emptyLabel: string; answered: boolean }): string | null {
  if (!answered) return null
  if (totalCount === 0) return emptyLabel
  return `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalCount)} of ${totalCount}`
}

/**
 * What an empty table says beneath its message when its search or filters hide every row it has, and only then:
 * a table with no rows at all is not helped by another search.
 */
export const NARROWED_HINT = "Try a different search or filter."

type ModuleRead = { readonly status: string; readonly problem: Problem | null }

/**
 * What an empty table says in place of "No records yet" while a module on the API has not answered:
 * its rows loading, its read failed and why, or no API configured to keep them. Null once they are
 * here, for a module the role does not view, and for one on the browser's own path (null).
 */
export function awaitedRowsSentence(state: ModuleRead | null): string | null {
  if (state === null) return null
  if (state.status === "kept-on-api") return state.problem === null ? null : problemSentence(state.problem)
  if (state.status === "idle" || state.status === "loading") return "Loading records…"
  if (state.status === "failed") return state.problem === null ? "The records could not be read. Reload the page to try again." : `The records could not be read (${problemSentence(state.problem)}). Reload the page to try again.`
  return null
}
