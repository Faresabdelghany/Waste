// The accounting export on the adapter (#291 slice 7, #292 C7w): Commercial ›
// Accounting export over `/accounting-exports`, an export read as its
// period, its vouchers and what they book, made through Export period's
// body and never edited; and the reads a surface asks — the preview, the
// file's bytes as they came, a project's mapping and its replacement. The
// bodies are held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AccountingExportCreate, type AccountingExport, type AccountingSettings } from "@waste/contracts/accounting"
import type { Project } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createAccountingExportRecord, EXPORT_PERIOD_FORM } from "../../data/commercial-forms"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { accountingExportAdapter, accountingExportBody, accountingExportFile, accountingModule, bookedSentence, EXPORT_NEVER_CHANGES, previewAccountingExport, readAccountingSettings, replaceAccountingSettings } from "../records/accounting"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, loadModule, resolverOver, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-11-02T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const fixturesOf = (workspaceId: Parameters<typeof getModuleDefinition>[0]["workspaceId"], moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const exportFixtures = fixturesOf("commercial", "accounting")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "fik-71", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const ADMIN = "01a0d2a4-a280-7003-8000-000000000001"
const NO_CONTEXT = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const copenhagenRecord = projectAdapter.toRecord(copenhagen, NO_CONTEXT(fixturesOf("configure", "organization")))
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([copenhagenRecord], [copenhagen.id])],
  ["configure.access", moduleOf([{ ...copenhagenRecord, id: `user-${ADMIN}`, name: "Fares Abdelghany", recordKind: "User" }], [ADMIN])],
])
const context = (): MappingContext => ({ fixtures: exportFixtures, resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const october: AccountingExport = {
  id: "01a0d2a4-a280-70a0-8000-000000000001",
  recordedAt: "2026-11-01T08:00:00.000Z",
  projectId: copenhagen.id,
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  voucherFrom: 213,
  voucherTo: 250,
  voucherCount: 38,
  lineCount: 131,
  backDatedCount: 2,
  byKind: { invoice: 30, "credit-note": 1, payment: 6, allocation: 1 },
  totals: [{ currency: "DKK", debitMinor: 128_455_000 }, { currency: "EUR", debitMinor: 32_000 }],
  createdBy: ADMIN,
  note: "October",
}
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

describe("the accounting export module", () => {
  test("is switched after the payments it books", () => {
    assert.ok(isServerBacked("commercial", "accounting"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.accounting") > SERVER_MODULE_KEYS.indexOf("commercial.payments"))
    assert.deepEqual(accountingModule.resources, [accountingExportAdapter])
  })

  test("lists the exports, each by its vouchers and period, what it booked per kind, the back-dated ones and the debits per currency", async () => {
    const { fetch, calls } = scripted([() => pageOf([october])])
    const result = await loadModule(clientOver(fetch), accountingModule, { fixtures: exportFixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/accounting-exports?limit=200"])
    const [record] = result.records
    assert.equal(record.id, `accounting-export-${october.id}`)
    assert.equal(record.name, "Vouchers 213–250 · 2026-10-01 – 2026-10-31")
    assert.equal(record.status, "Exported")
    assert.equal(record.value, "DKK 1,284,550.00 · €320.00")
    assert.deepEqual(
      [record.facts.Invoices, record.facts["Credit notes"], record.facts.Payments, record.facts["Matches of unmatched payments"], record.facts["Back-dated"], record.facts["Exported by"], record.facts.Note],
      ["30", "1", "6", "1", "2", "Fares Abdelghany", "October"],
    )
    assert.match(record.description ?? "", /^38 vouchers: 30 invoices, 1 credit note, 6 payments, 1 match of an unmatched payment, booked to Copenhagen Central's chart; 2 back-dated/)
    assert.equal(bookedSentence({ byKind: { invoice: 1, "credit-note": 0, payment: 0, allocation: 0 } }), "1 voucher: 1 invoice")
  })

  test("exports a period through Export period's body, held to the contracts, and refuses what the API would", () => {
    const values = { projectId: copenhagenRecord.id, periodFrom: "2026-10-01", periodTo: "2026-10-31", note: "" }
    const body = accountingExportAdapter.toCreateBody!(createAccountingExportRecord(values, 1), context())
    assert.deepEqual(body, { projectId: copenhagen.id, periodFrom: "2026-10-01", periodTo: "2026-10-31" })
    assert.ok(AccountingExportCreate.safeParse(body).success)
    const fieldIds = EXPORT_PERIOD_FORM.sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(fieldIds.filter((id) => !(id in values)), [], "every field of the form is a key the body reads")
    assert.deepEqual(accountingExportBody({ ...values, periodTo: "2026-09-30" }, resolverOver(state)), { path: "periodTo", message: "periodTo is the last day of the period, so it comes on or after periodFrom" })
    assert.deepEqual(accountingExportBody({ ...values, projectId: "" }, resolverOver(state)), { path: "projectId", message: "Pick a project" })
  })

  test("is never edited: what arrived since goes into the next export", () => {
    const record = accountingExportAdapter.toRecord({ ...october, createdAt: october.recordedAt, updatedAt: october.recordedAt }, context())
    assert.deepEqual(accountingExportAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, periodTo: "2026-10-30" } }, context()), { path: "periodTo", message: EXPORT_NEVER_CHANGES })
  })

  test("asks the preview, the file's bytes as they came, and a project's mapping and its replacement through the client", async () => {
    const preview = { voucherCount: 3, lineCount: 8, backDatedCount: 0, byKind: { invoice: 2, "credit-note": 0, payment: 1, allocation: 0 }, totals: [], gaps: [] }
    const mapping: AccountingSettings = { projectId: copenhagen.id, accounts: [{ number: "5600", name: "Debitorer", standardAccount: null }], receivable: "5600", bank: null, suspense: null, revenue: null, exportsFrom: null, vatCodes: [], productAccounts: [] }
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x76])
    const { fetch, calls } = scripted([
      () => json(preview),
      () => new Response(bytes, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="accounting-2026-10-01-2026-10-31-213-250.csv"' } }),
      () => new Response("<AuditFile/>", { status: 200, headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": 'attachment; filename="accounting-2026-10-01-2026-10-31-213-250-saf-t.xml"' } }),
      () => json(mapping),
      () => json(mapping),
    ])
    const client = clientOver(fetch)
    assert.deepEqual(await previewAccountingExport(client, { projectId: copenhagen.id, periodFrom: "2026-10-01", periodTo: "2026-10-31" }), preview)
    const file = await accountingExportFile(client, october.id)
    assert.deepEqual([...new Uint8Array(file.bytes)], [...bytes], "the byte-order mark kept")
    assert.equal(file.fileName, "accounting-2026-10-01-2026-10-31-213-250.csv")
    assert.equal((await accountingExportFile(client, october.id, "saf-t")).fileName, "accounting-2026-10-01-2026-10-31-213-250-saf-t.xml")
    assert.deepEqual(await readAccountingSettings(client, copenhagen.id), mapping)
    const { projectId, ...rest } = mapping
    await replaceAccountingSettings(client, { projectId, ...rest })
    assert.deepEqual(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
      ["POST http://api.test/accounting-exports/preview", `GET http://api.test/accounting-exports/${october.id}/file`, `GET http://api.test/accounting-exports/${october.id}/file?format=saf-t`, `GET http://api.test/accounting-settings?projectId=${copenhagen.id}`, "PUT http://api.test/accounting-settings"],
    )
    assert.equal(new Headers(calls[2].init.headers).get("accept"), "application/xml")
    assert.deepEqual(bodyOf(calls[4]), mapping)
  })
})
