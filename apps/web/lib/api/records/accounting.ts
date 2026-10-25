// Commercial › Accounting export on the Pilot (#291 slice 7, #292 C7w): a
// period's invoices, credit notes and payments as a file for the office's own
// bookkeeping, read and written through `/accounting-exports`
// (apps/api/src/routes/accounting.ts). An export is `accounting-export-<uuid>`
// from the start, a ledger row stamped with its `recordedAt` as both of a
// resource's stamps, and never edited: every patch is refused. Export period
// is the module's create — a project and the period, its last day today at
// the latest — and the surface previews it first (`previewAccountingExport`),
// a read through the client as Run billing's preview is. The file is a read
// too (`accountingExportFile`), its bytes as the API rendered them from the
// lines the export froze: our CSV, or Danish SAF-T 2.1 (C7b), which the API
// refuses with the sentence saying what to set while the company or the
// mapping lacks what it needs.
//
// The project's mapping onto the office's chart is no row of a workspace's
// table: Settings › Commercial › Accounting reads and replaces it whole
// through the client (`readAccountingSettings`, `replaceAccountingSettings`).
import type { AccountingExport, AccountingExportCreate, AccountingExportPreview, AccountingFormat, AccountingSettings, AccountingSettingsSet } from "@waste/contracts/accounting"

import { formatMinor } from "@/lib/commercial/money"
import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { ACCOUNTING_EXPORT_PREFIX, ACCOUNTING_EXPORT_RECORD_KIND, ACCOUNTING_MODULE, isAccountingExportRecord } from "@/lib/data/commercial"
import type { BusinessFormValues } from "@/lib/data/business-form-types"

import { command, create, get, getFile, listAll, put, withQuery, type ApiFile } from "../client"
import { inheritedPresentation, NOTHING_RESOLVED, stampFacts, typed, webIdOf, type Client, type LocalRefusal, type Resolver, type ResourceAdapter, type ServerModule } from "./adapter"
import { firstMoved, PERIOD_ORDERED, projectOf } from "./billing"
import { refusal } from "./places"
import { nameVia } from "./references"
import { shownOn } from "./clock"
import type { BusinessRecord } from "@/lib/data/business-modules"

/** What an edit of an export is told. */
export const EXPORT_NEVER_CHANGES = "An accounting export is never edited: what arrived since goes into the next one"

/** An export as the module reads it: a ledger row with a resource's stamps. */
export type AccountingExportResource = AccountingExport & { createdAt: string; updatedAt: string }

const stamped = (row: AccountingExport): AccountingExportResource => ({ ...row, createdAt: row.recordedAt, updatedAt: row.recordedAt })

/** The vouchers of an export, counted per kind of row booked, as the details name them. */
const KIND_LABELS = { invoice: "Invoices", "credit-note": "Credit notes", payment: "Payments", allocation: "Matches of unmatched payments" } as const

/** One of a kind and several, as a sentence counts them. */
const KIND_NOUNS = { invoice: ["invoice", "invoices"], "credit-note": ["credit note", "credit notes"], payment: ["payment", "payments"], allocation: ["match of an unmatched payment", "matches of unmatched payments"] } as const

/** The body of an export or its preview, from the form's values: a project, the period in order. */
export function accountingExportBody(values: BusinessFormValues, resolve: Resolver = NOTHING_RESOLVED): AccountingExportCreate | LocalRefusal {
  const record = { submittedValues: values } as BusinessRecord
  const projectWebId = typed(record, "projectId")
  const projectId = projectWebId === undefined ? undefined : resolve.serverIdOf(projectWebId)
  if (projectId === undefined) return refusal("projectId", "Pick a project")
  const periodFrom = typed(record, "periodFrom")
  if (periodFrom === undefined) return refusal("periodFrom", "Pick the first day of the period")
  const periodTo = typed(record, "periodTo")
  if (periodTo === undefined) return refusal("periodTo", "Pick the last day of the period")
  if (periodTo < periodFrom) return refusal("periodTo", PERIOD_ORDERED)
  const note = typed(record, "note")
  return { projectId, periodFrom, periodTo, ...(note === undefined ? {} : { note }) }
}

/** `POST /accounting-exports/preview`: what an export of the period would book now — its vouchers counted, the debits per currency, every row the mapping cannot book — writing nothing. */
export function previewAccountingExport(client: Client, body: AccountingExportCreate): Promise<AccountingExportPreview> {
  return command<AccountingExportPreview>(client, "/accounting-exports/preview", body)
}

/** `GET /accounting-exports/:id/file`: our CSV, its bytes as rendered from the export's frozen lines; or SAF-T, made on the project's today. */
export function accountingExportFile(client: Client, serverId: string, format: AccountingFormat = "csv"): Promise<ApiFile> {
  const path = `/accounting-exports/${serverId}/file`
  return format === "csv" ? getFile(client, path, "text/csv") : getFile(client, withQuery(path, { format }), "application/xml")
}

/** `GET /accounting-settings`: a project's mapping onto the office's chart. */
export function readAccountingSettings(client: Client, projectId: string): Promise<AccountingSettings> {
  return get<AccountingSettings>(client, withQuery("/accounting-settings", { projectId }))
}

/** `PUT /accounting-settings`: the project's mapping replaced whole; answers it as it now stands. */
export function replaceAccountingSettings(client: Client, body: AccountingSettingsSet): Promise<AccountingSettings> {
  return put<AccountingSettings>(client, "/accounting-settings", body)
}

/** A sentence counting what an export booked: `12 vouchers: 8 invoices, 1 credit note, 3 payments`. */
export function bookedSentence(row: Pick<AccountingExport, "byKind">): string {
  const parts = (Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).filter((kind) => row.byKind[kind] > 0).map((kind) => `${row.byKind[kind]} ${KIND_NOUNS[kind][row.byKind[kind] === 1 ? 0 : 1]}`)
  const total = Object.values(row.byKind).reduce((sum, count) => sum + count, 0)
  return `${total} voucher${total === 1 ? "" : "s"}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`
}

export const accountingExportAdapter: ResourceAdapter<AccountingExportResource> = {
  prefix: ACCOUNTING_EXPORT_PREFIX,
  owns: isAccountingExportRecord,
  statuses: undefined,
  list: (client) => listAll<AccountingExport>(client, "/accounting-exports").then((rows) => rows.map(stamped)),
  read: (client, serverId) => get<AccountingExport>(client, `/accounting-exports/${serverId}`).then(stamped),
  toRecord: (row, context) => {
    const project = projectOf(context, row.projectId)
    const period = `${row.periodFrom} – ${row.periodTo}`
    const vouchers = row.voucherFrom === row.voucherTo ? `Voucher ${row.voucherFrom}` : `Vouchers ${row.voucherFrom}–${row.voucherTo}`
    const debits = row.totals.map((total) => formatMinor(total.debitMinor, total.currency)).join(" · ")
    return {
      id: webIdOf(ACCOUNTING_EXPORT_PREFIX, row.id),
      name: `${vouchers} · ${period}`,
      context: `${project.name} · ${period}`,
      status: "Exported",
      ...inheritedPresentation(undefined),
      ...stampFacts(row, context.now),
      value: debits,
      description: `${bookedSentence(row)}, booked to ${project.name}'s chart${row.backDatedCount === 0 ? "" : `; ${row.backDatedCount} back-dated, arrived after an earlier export took their period`}.`,
      facts: {
        Kind: ACCOUNTING_EXPORT_RECORD_KIND,
        Project: project.name,
        Period: period,
        Vouchers: `${row.voucherFrom}–${row.voucherTo}`,
        Lines: String(row.lineCount),
        ...Object.fromEntries((Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).filter((kind) => row.byKind[kind] > 0).map((kind) => [KIND_LABELS[kind], String(row.byKind[kind])])),
        "Back-dated": String(row.backDatedCount),
        Debits: debits,
        ...(row.createdBy === null ? {} : { "Exported by": nameVia(context, "user", row.createdBy) }),
        Exported: shownOn(row.recordedAt, project.timezone),
        ...(row.note === null ? {} : { Note: row.note }),
      },
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: ACCOUNTING_EXPORT_RECORD_KIND,
      submittedValues: { projectId: project.webId, periodFrom: row.periodFrom, periodTo: row.periodTo, ...(row.note === null ? {} : { note: row.note }) },
    }
  },
  toCreateBody: (record, context) => accountingExportBody(record.submittedValues ?? {}, context.resolve),
  toPatchBody: (before, after) => refusal(firstMoved(before, after), EXPORT_NEVER_CHANGES),
  create: (client, body) => create<AccountingExport>(client, "/accounting-exports", body).then((created) => stamped(created.body)),
  update: () => Promise.reject(new Error("An accounting export has no patch route")),
}

/** Commercial › Accounting export: the exports, after the invoices and payments they book. */
export const accountingModule: ServerModule = { workspaceId: ACCOUNTING_MODULE.workspaceId, moduleId: ACCOUNTING_MODULE.moduleId, resources: [accountingExportAdapter] }
