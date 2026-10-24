// The workspace's status dialog (ActionDecisionDialog): what it asks and
// what it promises, by where the record lives (Issue #251). In fixture mode
// it is the prototype's governed action — a reason, an effective date, and an
// audit row the browser keeps beside the record. On a module the API holds,
// a patch carries the status and no date, and the API's audit log keeps the
// change and who made it (#291): the dialog asks a reason, which the write
// gives in the change-reason header and which it does not require, offers no
// date, and the browser invents no row.

export type ActionDecisionShape = {
  /** Whether the dialog asks a reason. */
  asksReason: boolean
  /** Whether it holds its confirm until a reason is typed. */
  requiresReason: boolean
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
const ON_API = "The status changes now, as the API holds it, and its audit log keeps who changed it and the reason given."

/** How long a reason may be: the contracts' paragraph, the bound the API holds the change-reason header to, re-spelled since no zod reaches the bundle and held equal by a test. */
export const REASON_MAX = 2000

/** The dialog's shape: `onApi` when the record's module is one the API holds. */
export function actionDecisionShape({ onApi, createsCompanion }: { onApi: boolean; createsCompanion: boolean }): ActionDecisionShape {
  if (onApi) return { asksReason: true, requiresReason: false, asksEffectiveDate: false, promise: ON_API, keepsBrowserAudit: false }
  return { asksReason: true, requiresReason: true, asksEffectiveDate: true, promise: createsCompanion ? COMPANION : GOVERNED, keepsBrowserAudit: true }
}

/** What the toast says once the action has landed: the move, and the audit row only where one was kept. */
export function actionRecordedSentence({ onApi, before, after }: { onApi: boolean; before: string; after: string }): string {
  if (onApi) return `${before} → ${after}`
  return before === after ? "The action and evidence were appended without bypassing the lifecycle." : `${before} → ${after} · audit history updated`
}
