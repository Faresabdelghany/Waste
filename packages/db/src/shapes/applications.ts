// An Application on the wire (M7 of #293): the columns, the row type, its
// latest Decision and `applicationOf`, which the office's routes answer and
// `application-decided` carries.
import type { Application, Decision } from "@waste/contracts/applications"
import type { ApplicationChannel, ApplicationKind, ApplicationStatus, DecisionOutcome } from "@waste/domain/registry/vocabulary"
import { and, desc, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { application, applicationDecision } from "../schema/applications"
import { stampsOf } from "./times"

export const applicationColumns = {
  id: application.id,
  projectId: application.projectId,
  number: application.number,
  kind: application.kind,
  status: application.status,
  channel: application.channel,
  receivedOn: application.receivedOn,
  customerId: application.customerId,
  propertyId: application.propertyId,
  sharedCollectionPointId: application.sharedCollectionPointId,
  subscriptionId: application.subscriptionId,
  statement: application.statement,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
}
export type ApplicationRow = Pick<typeof application.$inferSelect, keyof typeof applicationColumns>

export const decisionColumns = {
  id: applicationDecision.id,
  applicationId: applicationDecision.applicationId,
  outcome: applicationDecision.outcome,
  conditions: applicationDecision.conditions,
  grantedFrom: applicationDecision.grantedFrom,
  grantedTo: applicationDecision.grantedTo,
  appealText: applicationDecision.appealText,
  decidedBy: applicationDecision.decidedBy,
  recordedAt: applicationDecision.recordedAt,
}
export type DecisionRow = Pick<typeof applicationDecision.$inferSelect, keyof typeof decisionColumns>

export const decisionOf = (row: DecisionRow): Decision => ({
  id: row.id,
  applicationId: row.applicationId,
  outcome: row.outcome as DecisionOutcome,
  conditions: row.conditions,
  validFrom: row.grantedFrom,
  validTo: row.grantedTo,
  appealText: row.appealText,
  decidedBy: row.decidedBy,
  decidedAt: row.recordedAt.toISOString(),
})

export const applicationOf = (row: ApplicationRow, decision: DecisionRow | undefined): Application => ({
  id: row.id,
  projectId: row.projectId,
  number: row.number,
  kind: row.kind as ApplicationKind,
  status: row.status as ApplicationStatus,
  channel: row.channel as ApplicationChannel,
  receivedOn: row.receivedOn,
  customerId: row.customerId,
  propertyId: row.propertyId,
  sharedCollectionPointId: row.sharedCollectionPointId,
  subscriptionId: row.subscriptionId,
  statement: row.statement,
  decision: decision === undefined ? null : decisionOf(decision),
  ...stampsOf(row),
})

/** Each Application's latest Decision, by application id, in one statement. */
export async function latestDecisions(tx: Tx, companyId: string, ids: readonly string[]): Promise<Map<string, DecisionRow>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([applicationDecision.applicationId], decisionColumns)
    .from(applicationDecision)
    .where(and(eq(applicationDecision.companyId, companyId), inArray(applicationDecision.applicationId, [...ids])))
    .orderBy(applicationDecision.applicationId, desc(applicationDecision.id))
  return new Map(rows.map((row) => [row.applicationId, row]))
}

/** How every sentence names an application. */
export const labelOf = (row: Pick<ApplicationRow, "number">) => `Application ${row.number}`
