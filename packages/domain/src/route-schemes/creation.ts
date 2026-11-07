// The edit policy a scheme is created with (issue #38): "Changes to a running
// scheme", which the guided setup's review step and the quick form pick and
// a later edit is judged by (edit.ts).

import { SCHEME_EDIT_POLICIES } from "../planning/vocabulary"

/**
 * "Changes to a running scheme": how a later edit of a scheme with
 * generated routes applies — ask each time, apply to future collections, or
 * this collection only. Creation stamps what the wizard's review step or the
 * quick form picked, the default being "ask each time". The list lives in
 * ../planning/vocabulary since Issue #97, where the database and the
 * contracts read it too; re-exported so its importers did not move.
 */
export { SCHEME_EDIT_POLICIES }
export type SchemeEditPolicy = (typeof SCHEME_EDIT_POLICIES)[number]
export const DEFAULT_SCHEME_EDIT_POLICY: SchemeEditPolicy = "ask"
export const SCHEME_EDIT_POLICY_LABELS: Record<SchemeEditPolicy, string> = {
  ask: "Ask each time",
  future: "Apply to future collections",
  single: "This collection only",
}
export const isSchemeEditPolicy = (value: unknown): value is SchemeEditPolicy =>
  typeof value === "string" && (SCHEME_EDIT_POLICIES as readonly string[]).includes(value)
