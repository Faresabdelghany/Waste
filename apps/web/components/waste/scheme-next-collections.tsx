"use client"

// The scheme page's next collections on the Pilot (slice 3 of #81): the
// dates `GET /route-schemes/:id/occurrences` says the scheme plans over the
// coming eight weeks, holidays applied by its policy. The read runs the one
// `generateOccurrences` the generation job runs, so a row here and a route
// the job writes for it agree by construction. It stands in the Routes tab
// until the routes themselves are read from the API (slice 6); the wizard's
// preview, before a scheme exists, stays the domain's own call.
import { useEffect, useState } from "react"

import type { Occurrence } from "@waste/contracts/route-schemes"
import { addDays, formatServiceDate, todayIso } from "@waste/domain/route-schemes/recurrence"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { problemSentence } from "@/lib/api/problem"
import { schemeOccurrences } from "@/lib/api/records/route-schemes"
import { problemOfError } from "@/lib/api/records/server-records"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"

import { useApiClient } from "./api-session-store"
import { useServerModuleState } from "./business-record-store"

/** How far ahead the tab looks: eight weeks, the fortnightly scheme's four collections. */
const WINDOW_DAYS = 56

const STATUS_LABELS: Record<Occurrence["status"], string> = {
  planned: "Planned",
  shifted: "Shifted",
  skipped: "Skipped",
  holiday: "On a holiday",
}

type Loaded = { key: string; rows: Occurrence[] } | { key: string; problem: string }

const NO_ROWS: Occurrence[] = []

export function SchemeNextCollections({ recordId }: { recordId: string }) {
  const client = useApiClient()
  const serverId = useServerModuleState(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId)?.serverIds.get(recordId)
  const from = todayIso()
  const to = addDays(from, WINDOW_DAYS - 1)
  const key = `${serverId ?? ""}:${from}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (client === null || serverId === undefined) return
    const controller = new AbortController()
    schemeOccurrences({ ...client, signal: controller.signal }, serverId, { from, to }).then(
      (rows) => setLoaded({ key, rows }),
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key, problem: problemSentence(problemOfError(error)) })
      },
    )
    return () => controller.abort()
  }, [client, from, key, serverId, to])

  const current = loaded?.key === key ? loaded : null
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(current !== null && "rows" in current ? current.rows : NO_ROWS)

  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="scheme-next-collections">
      <div>
        <h3 id="scheme-next-collections" className="text-sm font-semibold">
          Next collections
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The dates the scheme plans from {formatServiceDate(from)} to {formatServiceDate(to)}, as generation plans them. Its generated routes are listed here once routes are read from the API.
        </p>
      </div>
      {serverId === undefined ? (
        <p className="text-sm text-muted-foreground">This scheme is not on the API yet.</p>
      ) : current === null ? (
        <p className="text-sm text-muted-foreground">Reading the next collections…</p>
      ) : "problem" in current ? (
        <p role="alert" className="text-sm text-destructive">
          The next collections could not be read: {current.problem}
        </p>
      ) : current.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No collection falls in these eight weeks.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Week</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => (
                <TableRow key={`${row.plannedDate}:${row.date}`}>
                  <TableCell className="tabular-nums text-muted-foreground">{row.n ?? "—"}</TableCell>
                  <TableCell>{formatServiceDate(row.date)}</TableCell>
                  <TableCell className="tabular-nums">{row.week}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === "planned" ? "secondary" : "outline"}>{STATUS_LABELS[row.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {[row.status === "shifted" ? `from ${formatServiceDate(row.plannedDate)}` : null, row.note ?? null].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}
