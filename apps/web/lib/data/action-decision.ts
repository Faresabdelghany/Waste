// The workspace's status dialog (ActionDecisionDialog): what it asks and
// what it promises, by where the record lives (Issue #251). In fixture mode
// it is the prototype's governed action — a reason, an effective date, and an
// audit row the browser keeps beside the record. On a module the API holds,
// the status is all the wire takes: no patch carries a reason or a date for a
// status, and the API keeps no audit row of it, so the dialog asks neither,
// promises neither, and the browser invents no row.

export type ActionDecisionShape = {
  /** Whether the dialog asks a reason, and holds its confirm until one is typed. */
  asksReason: boolean
  /** Whether it offers an effective date. */
  asksEffectiveDate: boolean
  /** What it says the action does, under its fields. */
  promise: string
  /** Whether the browser keeps an audit row and the record's action facts. */
  keepsBrowserAudit: boolean
}

const GOVERNED =
  "Company, project, capability, lifecycle, and effective-date checks run before the action is recorded. Actor, reason, before/after state, and evidence are appended to audit history."
const COMPANION =
  "The source record remains unchanged. A linked correction, immutable plan, promotion, child record, or ledger entry will be created."
const ON_API = "The status changes now, as the API holds it."

/** The dialog's shape: `onApi` when the record's module is one the API holds. */
export function actionDecisionShape({ onApi, createsCompanion }: { onApi: boolean; createsCompanion: boolean }): ActionDecisionShape {
  if (onApi) return { asksReason: false, asksEffectiveDate: false, promise: ON_API, keepsBrowserAudit: false }
  return { asksReason: true, asksEffectiveDate: true, promise: createsCompanion ? COMPANION : GOVERNED, keepsBrowserAudit: true }
}

/** What the toast says once the action has landed: the move, and the audit row only where one was kept. */
export function actionRecordedSentence({ onApi, before, after }: { onApi: boolean; before: string; after: string }): string {
  if (onApi) return `${before} → ${after}`
  return before === after ? "The action and evidence were appended without bypassing the lifecycle." : `${before} → ${after} · audit history updated`
}
