// A row's history as the details sheet reads it (#291). The API's audit log
// answers one event per row a request touched, newest first; a person reads
// one entry per request — who, when, why — with a line for each row it
// touched: the row itself created, changed or deleted, or a row of one of its
// sets (a role's grant, an agreement's subscription) added, changed or
// removed. A line of the row's own create or delete says so alone; any other
// lists the columns that moved, in words, a reference named by the row it
// points at where the store holds that row, and the column naming the row
// itself — a set row's parent — left out, since the whole history is the
// row's.
import type { AuditEvent } from "@waste/contracts/audit"

/** A column that moved: its label, and its value before and after in words, null where it had none. */
export type HistoryChange = { label: string; before: string | null; after: string | null }
/** What happened to one row in a request. */
export type HistoryLine = { what: string; changes: HistoryChange[] }
/** One request's changes. */
export type HistoryEntry = { key: string; when: string; who: string; reason: string | null; lines: HistoryLine[] }

export type HistoryReading = {
  /** A row's name by its server id, where the store holds it. */
  nameOf: (serverId: string) => string | undefined
  /** An event's instant as a person reads it: on its project's clock. */
  when: (recordedAt: string, event: AuditEvent) => string
}

/** `role_grant` → "role grant": a table's name in words. */
const tableWords = (table: string): string => table.replaceAll("_", " ")

/** `payer_customer_id` → "Payer customer": the database's spelling in words, a reference by what it names. */
function labelOf(column: string): string {
  const words = column.replace(/_id$/, "").replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `in-progress` → "In progress": a status token as the lifecycle reads it. */
function statusOf(token: string): string {
  const words = token.replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function valueOf(column: string, value: unknown, nameOf: HistoryReading["nameOf"]): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") {
    if (column.endsWith("_id")) return nameOf(value) ?? value
    return column === "status" ? statusOf(value) : value
  }
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") return String(value)
  return JSON.stringify(value)
}

const OWN: Record<AuditEvent["action"], string> = { insert: "Created", update: "Changed", delete: "Deleted" }
const OF_A_SET: Record<AuditEvent["action"], string> = { insert: "Added", update: "Changed", delete: "Removed" }

function lineOf(event: AuditEvent, subject: { table: string; rowId: string }, nameOf: HistoryReading["nameOf"]): HistoryLine {
  const own = event.table === subject.table && event.rowId === subject.rowId
  if (own && event.action !== "update") return { what: OWN[event.action], changes: [] }
  const changes = Object.entries(event.changed)
    // A set row's column naming its parent says only whose row it is.
    .filter(([column, [before, after]]) => own || !(column.endsWith("_id") && (before === event.parentId || after === event.parentId) && event.parentId !== null))
    .map(([column, [before, after]]) => ({ label: labelOf(column), before: valueOf(column, before, nameOf), after: valueOf(column, after, nameOf) }))
  return { what: own ? OWN.update : `${OF_A_SET[event.action]} ${tableWords(event.table)}`, changes }
}

/** Who made a change: the account's name, the system's where no person did, and a word for an account no longer here. */
function whoOf(actor: AuditEvent["actor"]): string {
  if (actor === null) return "System"
  return actor.fullName === "" ? "A removed account" : actor.fullName
}

/** The history of `subject`, one entry per request, newest first as the log answered it. */
export function historyEntriesOf(events: readonly AuditEvent[], subject: { table: string; rowId: string }, reading: HistoryReading): HistoryEntry[] {
  return entriesOf(events, reading, (event) => lineOf(event, subject, reading.nameOf))
}

/**
 * A line of the company's whole history (Settings › Privacy, audit &
 * retention): no row is the subject, so each line names the row it is about —
 * by its name where the store holds it — and a set's row the row it belongs
 * to. A create or a delete says so alone, as a row's own history does; a
 * change lists the columns that moved.
 */
function companyLineOf(event: AuditEvent, nameOf: HistoryReading["nameOf"]): HistoryLine {
  const changes = event.action === "update" ? Object.entries(event.changed).map(([column, [before, after]]) => ({ label: labelOf(column), before: valueOf(column, before, nameOf), after: valueOf(column, after, nameOf) })) : []
  const own = nameOf(event.rowId)
  if (event.parentTable !== null && event.parentId !== null && own === undefined) {
    const parent = nameOf(event.parentId)
    return { what: `${OF_A_SET[event.action]} ${tableWords(event.table)} of ${tableWords(event.parentTable)}${parent === undefined ? "" : ` ${parent}`}`, changes }
  }
  return { what: `${OWN[event.action]} ${tableWords(event.table)}${own === undefined ? "" : ` ${own}`}`, changes }
}

/** The company's whole history, one entry per request, newest first as the log answered it: every row's lines named by their row. */
export function companyHistoryEntriesOf(events: readonly AuditEvent[], reading: HistoryReading): HistoryEntry[] {
  return entriesOf(events, reading, (event) => companyLineOf(event, reading.nameOf))
}

function entriesOf(events: readonly AuditEvent[], reading: HistoryReading, lineFor: (event: AuditEvent) => HistoryLine): HistoryEntry[] {
  const entries = new Map<string, HistoryEntry>()
  for (const event of events) {
    const entry = entries.get(event.transactionId)
    const line = lineFor(event)
    if (entry === undefined) {
      entries.set(event.transactionId, { key: event.transactionId, when: reading.when(event.recordedAt, event), who: whoOf(event.actor), reason: event.reason, lines: [line] })
    } else {
      entry.lines.push(line)
    }
  }
  return [...entries.values()]
}
