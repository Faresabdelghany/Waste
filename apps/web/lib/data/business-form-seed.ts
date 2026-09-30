/**
 * When an open record form is filled from its initial values — the one rule
 * `business-record-form-dialog.tsx` applies. A form is filled as it opens and
 * when it becomes a form of another kind (`schema.key`), and never otherwise:
 * the workspace rebuilds the seed on every change of the record store — a
 * switched module landing from the API, an optimistic write — and a form
 * re-filled then would drop what the person typed, where a refusal keeps the
 * dialog open over it (whenSaved). Initial values are initial.
 */
export type FormSeedEdge = { open: boolean; schemaKey: string }

export function formReseeds(previous: FormSeedEdge | undefined, next: FormSeedEdge): boolean {
  if (!next.open) return false
  return previous === undefined || !previous.open || previous.schemaKey !== next.schemaKey
}
