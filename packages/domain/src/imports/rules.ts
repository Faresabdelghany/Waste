// What an import's request is held to (#291 slice 12): a kind's import names
// a project exactly when its records are a project's, a row names its row of
// the file once, and a cell is a paragraph's length at most but the
// boundary's.
import { isCompanyImportKind, IMPORT_KINDS, type ImportKind } from "./vocabulary"

/** The kinds whose records are a project's, and so whose import names a project: every kind but the company's. */
export const PROJECT_IMPORT_KINDS: readonly ImportKind[] = IMPORT_KINDS.filter((kind) => !isCompanyImportKind(kind))

export const PROJECT_REQUIRED = "This kind of record is a project's: name the project the file is imported into"
export const PROJECT_REFUSED = "These records are the company's, not a project's: an import of them names no project"

/** The sentence an import's project is refused with, where the kind and the project do not fit; undefined where they do. */
export function projectIssue(body: { kind: ImportKind; projectId?: string }): string | undefined {
  const fits = PROJECT_IMPORT_KINDS.includes(body.kind) === (body.projectId !== undefined)
  return fits ? undefined : body.projectId === undefined ? PROJECT_REQUIRED : PROJECT_REFUSED
}

/** What a cell longer than its column takes is told. */
export const cellTooLong = (max: number): string => `Too long: a cell holds at most ${max} characters`

/** What a request naming a row of the file twice is told. */
export const EACH_ROW_ONCE = "Give each row once: a row number names one row of the file"
