import { problemSentence } from "./api/problem"
import type { ModuleState } from "./api/records/server-records"

/** "1 record", "12 records", or "3 of 12 records": a table's count line, the noun agreeing with the total. */
export function recordCountLabel(shown: number, total: number = shown): string {
  const noun = total === 1 ? "record" : "records"
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
}

/**
 * What an empty table says beneath its message when its search or filters hide every row it has, and only then:
 * a table with no rows at all is not helped by another search.
 */
export const NARROWED_HINT = "Try a different search or filter."

/**
 * What an empty table says in place of "No records yet" while a module on the API has not answered:
 * its rows loading, or its read failed and why. Null once they are here, for a module the role does not
 * view, and for one on the browser's own path (null).
 */
export function awaitedRowsSentence(state: Pick<ModuleState, "status" | "problem"> | null): string | null {
  if (state === null) return null
  if (state.status === "idle" || state.status === "loading") return "Loading records…"
  if (state.status === "failed") return state.problem === null ? "The records could not be read. Reload the page to try again." : `The records could not be read (${problemSentence(state.problem)}). Reload the page to try again.`
  return null
}
