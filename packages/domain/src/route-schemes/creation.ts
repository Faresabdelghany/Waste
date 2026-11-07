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
/** What each choice does, for the review step and the quick form's field description. The stored choice is the rule for the next edit; changing it is itself an edit that lands for the time after. */
export const SCHEME_EDIT_POLICY_DESCRIPTIONS: Record<SchemeEditPolicy, string> = {
  ask: "Every edit that shapes a collection asks whether it applies to every future collection or to the next one only.",
  future: "Every edit is saved on the scheme and every future planned route follows it.",
  single: "Every edit that shapes a collection applies to the next collection only; the scheme keeps its configuration. A new choice here takes effect from the following edit.",
}
export const isSchemeEditPolicy = (value: unknown): value is SchemeEditPolicy =>
  typeof value === "string" && (SCHEME_EDIT_POLICIES as readonly string[]).includes(value)
