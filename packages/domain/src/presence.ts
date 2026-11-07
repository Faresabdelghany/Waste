// Whether a row's column is given for a kind of it, the cell a shape table is
// written in: a proof's (execution/proof-shapes), a ticket event's
// (resolution/event-shapes).

/** Whether a column is given, absent, or either, for a kind. */
export type Presence = "required" | "none" | "any"
