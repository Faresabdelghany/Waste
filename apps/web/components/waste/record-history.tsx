"use client"

// A record's History in its details sheet, on the Pilot (#291): the API's
// audit log of the row and its sets, one entry per request — who, when on the
// project's clock, why where a reason was given, and what moved
// (`historyEntriesOf`). It is read when the sheet opens and again whenever
// the store's row is replaced — a write's answer, a module read again — so a
// change made from the sheet shows once the API has kept it. A kind whose
// table keeps no history shows no section at all.

import type { AuditEvent } from "@waste/contracts/audit"

import { useServerModuleState, useServerResolver } from "@/components/waste/business-record-store"
import { useReport } from "@/components/insight/use-report"
import { problemSentence } from "@/lib/api/problem"
import { typed } from "@/lib/api/records/adapter"
import { historyPage, historySubjectOf } from "@/lib/api/records/audit"
import { shownOn } from "@/lib/api/records/clock"
import { serverModuleOf } from "@/lib/api/records/modules"
import { historyEntriesOf } from "@/lib/data/audit-history"
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

/** Each row object the store hands out, numbered the first time it is seen: a replaced row is a new number, and its history is read again. */
const revisions = new WeakMap<BusinessRecord, number>()
let lastRevision = 0
function revisionOf(row: BusinessRecord): number {
  const known = revisions.get(row)
  if (known !== undefined) return known
  lastRevision += 1
  revisions.set(row, lastRevision)
  return lastRevision
}

export function RecordHistory({ workspaceId, moduleId, record }: { workspaceId: WorkspaceId; moduleId: string; record: BusinessRecord }) {
  const module = serverModuleOf(workspaceId, moduleId)
  const state = useServerModuleState(workspaceId, moduleId)
  const resolve = useServerResolver()
  const row = state?.records.find((candidate) => candidate.id === record.id) ?? record
  const subject = module === undefined || state === null ? null : historySubjectOf(module, record, state.serverIds)
  // Asked only under a key, and a key only with a subject; mounted per record (the sheet's key), so what is shown greyed is this row's.
  const read = useReport(subject === null ? null : `${subject.table}:${subject.rowId}:${revisionOf(row)}`, (client) =>
    subject === null ? Promise.resolve({ items: [], nextCursor: null }) : historyPage(client, subject),
  )
  if (subject === null) return null

  const timezoneOf = (event: AuditEvent) => {
    const project = event.projectId === null ? undefined : resolve.byServerId(event.projectId)
    return project === undefined ? undefined : typed(project, "timezone")
  }
  const entries =
    read.shown === null
      ? []
      : historyEntriesOf(read.shown.items, subject, {
          nameOf: (serverId) => resolve.byServerId(serverId)?.name,
          when: (recordedAt, event) => shownOn(recordedAt, timezoneOf(event)),
        })

  return (
    <section className="space-y-4" aria-labelledby="record-history">
      <h3 id="record-history" className="text-sm font-semibold">
        History
      </h3>
      {read.problem !== null && <p className="text-sm text-muted-foreground">The history could not be read: {problemSentence(read.problem)}</p>}
      {read.problem === null && read.shown === null && <p className="text-sm text-muted-foreground">Reading the history…</p>}
      {read.shown !== null && entries.length === 0 && <p className="text-sm text-muted-foreground">No change has been recorded.</p>}
      {entries.length > 0 && (
        <ol className={read.loading ? "divide-y divide-border/60 border-y border-border/60 opacity-60" : "divide-y divide-border/60 border-y border-border/60"}>
          {entries.map((entry) => (
            <li key={entry.key} className="space-y-1.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{entry.who}</span>
                <span>{entry.when}</span>
              </div>
              {entry.lines.map((line, index) => (
                <div key={index} className="space-y-1">
                  <p className="text-sm">{line.what}</p>
                  {line.changes.length > 0 && (
                    <dl className="space-y-0.5 text-xs">
                      {line.changes.map((change) => (
                        <div key={change.label} className="flex flex-wrap gap-x-2">
                          <dt className="text-muted-foreground">{change.label}</dt>
                          <dd>
                            {change.before ?? "—"} → {change.after ?? "—"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ))}
              {entry.reason !== null && <p className="text-xs text-muted-foreground">Reason: {entry.reason}</p>}
            </li>
          ))}
        </ol>
      )}
      {read.shown?.nextCursor != null && <p className="text-xs text-muted-foreground">Older changes are not shown.</p>}
    </section>
  )
}
