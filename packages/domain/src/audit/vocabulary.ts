// The audit log's closed list (#291, slice 9; ADR-0005: "the history of edits
// is the audit log"): what a row of an audited table underwent. The database
// reads it into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and
// the contracts into a `z.enum`, so the trigger's word and the wire's cannot
// drift. A value is a kebab-case token: a SQL literal and an enum member, the
// same string — the trigger writes `lower(TG_OP)`.

/** What happened to the row: written, changed, or removed. */
export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_VOCABULARIES = { AUDIT_ACTIONS } as const
