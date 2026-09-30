import type { ReactNode } from "react"

/**
 * A row's own read beside its commands — a container's ledger, an
 * allocation's history, a route's stops — told as the read stands: its
 * problem in the API's words, still reading, nothing to show, or the rows,
 * one line each (`useRowHistory` in use-command-support.ts answers the read).
 */
export function ReadRows<T>({ read, empty, label, testId, line }: { read: { rows: T[] | null; problem: string | null }; empty: string; label: string; testId: string; line: (row: T, index: number) => ReactNode }) {
  if (read.problem !== null) return <p className="text-sm text-destructive">{read.problem}</p>
  if (read.rows === null) return <p className="text-sm text-muted-foreground">{label}</p>
  if (read.rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid={testId}>
      {read.rows.map((row, index) => (
        <li key={index} className="py-2">
          {line(row, index)}
        </li>
      ))}
    </ol>
  )
}
