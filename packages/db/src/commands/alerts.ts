// Raising an alert, written once for both doors that raise one: the office's
// `POST /alerts` (apps/api's routes/alerts.ts), one row by hand, and the
// worker's rules (apps/worker's alert-rules.ts), a tick's occurrences of a
// company at once. Each row is written `new` and its `alert-raised` follows
// it, carrying the alert as the API answers it and dated when the condition
// was seen. A rule's occurrence is raised once while its alert stands: a
// tick that overlapped another meets the rule key's index and writes nothing,
// the key being its word; a person's alert carries no key.
import type { AlertKind, AlertRule, AlertSeverity, AlertSource } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"

import type { Tx } from "../client"
import { alert, holdsItsRuleKey } from "../schema/resolution"
import { emit } from "./outbox"
import { alertColumns, alertOf, type AlertRow } from "../shapes/alerts"

/** An alert as its door raises it: what it is about, when it was seen, and who raised it — a person, or a rule with its occurrence's key. */
export type AlertDraft = {
  /** The office mints its rows' ids; a rule's take the table's own. */
  id?: string
  projectId: string
  kind: AlertKind
  severity: AlertSeverity
  source: AlertSource
  title: string
  details: string
  detectedAt: Date
  routeId: string | null
  vehicleId: string | null
  driverId: string | null
  containerId: string | null
  ticketId: string | null
  outboundLoadId?: string | null
  raisedBy: string | null
  rule?: AlertRule | null
  ruleKey?: string | null
}

/** Raises the drafts of one company, `new`, each followed by its `alert-raised`; answers the rows written, without an occurrence whose alert stands already. */
export async function raiseAlerts(tx: Tx, companyId: string, drafts: readonly AlertDraft[]): Promise<AlertRow[]> {
  if (drafts.length === 0) return []
  const written = await tx
    .insert(alert)
    .values(drafts.map((draft) => ({ ...draft, companyId, status: "new" as const })))
    .onConflictDoNothing({ target: [alert.companyId, alert.ruleKey], where: sql`${alert.ruleKey} is not null and ${holdsItsRuleKey(alert)}` })
    .returning(alertColumns)
  for (const row of written) await emit(tx, { companyId }, { aggregateId: row.id, kind: "alert-raised", payload: alertOf(row), projectId: row.projectId, occurredAt: row.detectedAt })
  return written
}
