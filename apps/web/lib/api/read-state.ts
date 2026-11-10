// What a pane or a record's section says in place of what the API has not
// given it: the rows being read, not shown to the person's role, or not read,
// and why. Every surface names what it reads in its own noun ("the planning
// areas", "the master data"), and says once it has the rows what they hold.
import type { Problem } from "./problem"

/** How a sentence names what it reads: `is` for a mass noun ("the master data is"), `notShown` where the role is told of it by another name. */
export type ReadNoun = { readonly is?: boolean; readonly notShown?: string }

export const notShownSentence = (noun: string, { is = false }: Pick<ReadNoun, "is"> = {}): string => `The ${noun} ${is ? "is" : "are"} not shown to your role.`

const readingSentence = (noun: string): string => `Reading the ${noun} from the API…`

const unreadSentence = (noun: string, why: string): string => `The ${noun} could not be read from the API: ${why}`

export const waitingSentence = (noun: string, follows: string, { is = false }: Pick<ReadNoun, "is"> = {}): string => `The ${noun} ${is ? "is" : "are"} being read from the API; ${follows}.`

/**
 * A module's records as a pane reads them (`useModuleRecords`): being read,
 * not the role's, or refused, in the API's own words; null once they are read,
 * when the pane says what they hold.
 */
export function moduleReadSentence(answer: { pending: boolean; notGranted: boolean; problem: Problem | null }, noun: string, { is = false, notShown = noun }: ReadNoun = {}): string | null {
  if (answer.pending) return readingSentence(noun)
  if (answer.notGranted) return notShownSentence(notShown, { is })
  if (answer.problem) return unreadSentence(noun, answer.problem.detail ?? answer.problem.title)
  return null
}

/**
 * A read the surface asks itself (a project's setting, a record's section):
 * not the role's where `viewed` is false, not read with `problem` saying why,
 * or still on its way; null once `answered`.
 */
export function readSentence(read: { viewed?: boolean; problem: string | null; answered: false }, noun: string, words?: ReadNoun): string
export function readSentence(read: { viewed?: boolean; problem: string | null; answered: boolean }, noun: string, words?: ReadNoun): string | null
export function readSentence(read: { viewed?: boolean; problem: string | null; answered: boolean }, noun: string, { is = false, notShown = noun }: ReadNoun = {}): string | null {
  if (read.viewed === false) return notShownSentence(notShown, { is })
  if (read.problem !== null) return unreadSentence(noun, read.problem)
  if (!read.answered) return readingSentence(noun)
  return null
}
