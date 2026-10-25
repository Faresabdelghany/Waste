// The accounting export (#291 slice 7, #292 C7): a project's mapping onto
// the office's chart, read and replaced whole under Settings › Finance &
// invoicing (`configure.finance`), and the exports themselves under Commercial
// (`commercial.accounting`) — a preview, the export, the list, one export, and
// its file. An export books every invoice, credit note and payment of the
// project, and every allocation of a payment that named no customer, that no
// export took yet, on or before its period's last day — which is the
// project's today at the latest — from the mapping's first day of exports:
// one balanced voucher per row on its own day, a row dated before the period
// back-dated (@waste/db/commands/accounting-exports, @waste/domain/finance/
// accounting). The file is rendered from the export's frozen lines on each
// download, so it is the same bytes whatever the mapping becomes.
//
// The mapping names accounts by number. The PUT replaces the whole: an
// account kept by its number keeps its row, one left out is deleted once
// nothing of the mapping names it, and the four defaults, the VAT codes and
// the products' accounts follow the body; a product it names is the
// project's (400 at its path). Under the project's row lock, so two
// replacements, or one and an export, take turns.
import { AccountingExport, AccountingExportCreate, AccountingExportListQuery, AccountingExportPreview, AccountingFileQuery, AccountingSettings, AccountingSettingsQuery, AccountingSettingsSet, type AccountingSourceKind } from "@waste/contracts/accounting"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { ACCOUNTING_EXPORT_MAX_VOUCHERS, exportedLines, NOTHING_TO_EXPORT, planExport, runExport, tooManyVouchers } from "@waste/db/commands/accounting-exports"
import { safTFileOf } from "@waste/db/commands/accounting-saf-t"
import { product } from "@waste/db/schema/catalogue"
import { accountingAccount, accountingExport, accountingExportLine, accountingExportVoucher, accountingProductAccount, accountingSettings, accountingVatCode } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { accountingCsv } from "@waste/domain/finance/accounting"
import { safTGapSentence, STANDARD_CHART_VERSION } from "@waste/domain/finance/saf-t"
import { ACCOUNTING_SOURCE_KINDS } from "@waste/domain/finance/vocabulary"
import { and, asc, count, eq, gt, inArray, notInArray, sql, sum, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import { NOT_A_PRODUCT, type Scope } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow } from "./shared"

const SETTINGS_MODULE = "configure.finance"
const EXPORT_MODULE = "commercial.accounting"

/** An export is for a closed period, as a billing run is (M14 of #293): its last day is the project's today at the latest. */
export const EXPORT_PERIOD_ENDS_BY_TODAY = "An export's period ends by today"

const problems = (module: string, action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${module}\`.`),
})

/** The project's mapping as the wire spells it: accounts by number in number order, the codes by rate, the products' accounts by product. */
async function settingsOf(tx: Tx, scope: Scope): Promise<AccountingSettings> {
  const fence = <T extends { companyId: PgColumn; projectId: PgColumn }>(table: T) => and(eq(table.companyId, scope.companyId), eq(table.projectId, scope.projectId))
  const accounts = await tx.select().from(accountingAccount).where(fence(accountingAccount)).orderBy(asc(accountingAccount.number))
  const numberOf = new Map(accounts.map((row) => [row.id, row.number]))
  const named = (id: string | null): string | null => (id === null ? null : (numberOf.get(id) ?? null))
  const [settings] = await tx.select().from(accountingSettings).where(fence(accountingSettings)).limit(1)
  const vatCodes = await tx.select().from(accountingVatCode).where(fence(accountingVatCode)).orderBy(asc(accountingVatCode.vatPercent))
  const products = await tx.select().from(accountingProductAccount).where(fence(accountingProductAccount)).orderBy(asc(accountingProductAccount.productId))
  return {
    projectId: scope.projectId,
    accounts: accounts.map((row) => ({ number: row.number, name: row.name, standardAccount: row.standardAccount })),
    receivable: named(settings?.receivableAccountId ?? null),
    bank: named(settings?.bankAccountId ?? null),
    suspense: named(settings?.suspenseAccountId ?? null),
    revenue: named(settings?.revenueAccountId ?? null),
    exportsFrom: settings?.exportsFrom ?? null,
    vatCodes: vatCodes.map((row) => ({ vatPercent: row.vatPercent, code: row.code, account: numberOf.get(row.accountId)!, standardTaxCode: row.standardTaxCode })),
    productAccounts: products.map((row) => ({ productId: row.productId, account: numberOf.get(row.accountId)! })),
  }
}

/** Replaces the project's mapping with the body's, row by row where a row stays, under the caller's lock. */
async function replaceSettings(tx: Tx, scope: Scope, body: AccountingSettingsSet): Promise<void> {
  const fenced = <T extends { companyId: PgColumn; projectId: PgColumn }>(table: T, ...more: (SQL | undefined)[]) => and(eq(table.companyId, scope.companyId), eq(table.projectId, scope.projectId), ...more)
  // The products first: each one the project's.
  const productIds = [...new Set(body.productAccounts.map((entry) => entry.productId))]
  const ofProject = new Set(
    productIds.length === 0
      ? []
      : (await tx.select({ id: product.id }).from(product).where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), inArray(product.id, productIds)))).map((row) => row.id),
  )
  const strays = body.productAccounts.flatMap((entry, index) => (ofProject.has(entry.productId) ? [] : [{ path: `productAccounts.${index}.productId`, message: NOT_A_PRODUCT }]))
  if (strays.length > 0) throw invalidRequest("body", strays)

  // The accounts by number: a kept one keeps its row, a new one is written; the ones left out go last, once nothing names them.
  const standing = new Map((await tx.select().from(accountingAccount).where(fenced(accountingAccount))).map((row) => [row.number, row]))
  const idOf = new Map<string, string>()
  for (const account of body.accounts) {
    const before = standing.get(account.number)
    if (before === undefined) {
      const id = newId()
      await tx.insert(accountingAccount).values({ id, ...scope, ...account })
      idOf.set(account.number, id)
      continue
    }
    idOf.set(account.number, before.id)
    if (before.name !== account.name || before.standardAccount !== account.standardAccount) await tx.update(accountingAccount).set({ name: account.name, standardAccount: account.standardAccount }).where(fenced(accountingAccount, eq(accountingAccount.id, before.id)))
  }
  const id = (number: string | null): string | null => (number === null ? null : idOf.get(number)!)

  const defaults = { receivableAccountId: id(body.receivable), bankAccountId: id(body.bank), suspenseAccountId: id(body.suspense), revenueAccountId: id(body.revenue), exportsFrom: body.exportsFrom }
  const [settings] = await tx.select().from(accountingSettings).where(fenced(accountingSettings)).limit(1)
  if (settings === undefined) await tx.insert(accountingSettings).values({ id: newId(), ...scope, ...defaults })
  else if (Object.entries(defaults).some(([key, value]) => settings[key as keyof typeof defaults] !== value)) await tx.update(accountingSettings).set(defaults).where(fenced(accountingSettings, eq(accountingSettings.id, settings.id)))

  const codes = new Map((await tx.select().from(accountingVatCode).where(fenced(accountingVatCode))).map((row) => [row.vatPercent, row]))
  const rates = new Set(body.vatCodes.map((code) => code.vatPercent))
  const goneRates = [...codes.keys()].filter((rate) => !rates.has(rate))
  if (goneRates.length > 0) await tx.delete(accountingVatCode).where(fenced(accountingVatCode, inArray(accountingVatCode.vatPercent, goneRates)))
  for (const code of body.vatCodes) {
    const before = codes.get(code.vatPercent)
    const accountId = idOf.get(code.account)!
    if (before === undefined) await tx.insert(accountingVatCode).values({ id: newId(), ...scope, vatPercent: code.vatPercent, code: code.code, accountId, standardTaxCode: code.standardTaxCode })
    else if (before.code !== code.code || before.accountId !== accountId || before.standardTaxCode !== code.standardTaxCode) await tx.update(accountingVatCode).set({ code: code.code, accountId, standardTaxCode: code.standardTaxCode }).where(fenced(accountingVatCode, eq(accountingVatCode.id, before.id)))
  }

  const entries = new Map((await tx.select().from(accountingProductAccount).where(fenced(accountingProductAccount))).map((row) => [row.productId, row]))
  const goneProducts = [...entries.keys()].filter((productId) => !ofProject.has(productId))
  if (goneProducts.length > 0) await tx.delete(accountingProductAccount).where(fenced(accountingProductAccount, inArray(accountingProductAccount.productId, goneProducts)))
  for (const entry of body.productAccounts) {
    const before = entries.get(entry.productId)
    const accountId = idOf.get(entry.account)!
    if (before === undefined) await tx.insert(accountingProductAccount).values({ id: newId(), ...scope, productId: entry.productId, accountId })
    else if (before.accountId !== accountId) await tx.update(accountingProductAccount).set({ accountId }).where(fenced(accountingProductAccount, eq(accountingProductAccount.id, before.id)))
  }

  const kept = body.accounts.map((account) => account.number)
  await tx.delete(accountingAccount).where(fenced(accountingAccount, kept.length === 0 ? undefined : notInArray(accountingAccount.number, kept)))
}

/** A day after the project's today, as a period's last: refused. */
async function requireClosedPeriod(tx: Tx, scope: Scope, periodTo: string, now: () => Date): Promise<void> {
  if (periodTo > (await projectToday(tx, scope, now)())) throw invalidRequest("body", [{ path: "periodTo", message: EXPORT_PERIOD_ENDS_BY_TODAY }])
}

const zeroKinds = (): Record<AccountingSourceKind, number> => Object.fromEntries(ACCOUNTING_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AccountingSourceKind, number>

/** Exports as the wire spells them, with what their vouchers count and move, in the order given. */
async function exportsOf(tx: Tx, companyId: string, rows: readonly (typeof accountingExport.$inferSelect)[]): Promise<AccountingExport[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const kinds = await tx
    .select({ exportId: accountingExportVoucher.exportId, kind: accountingExportVoucher.sourceKind, vouchers: count(), backDated: sql<number>`count(*) filter (where ${accountingExportVoucher.backDated})::int` })
    .from(accountingExportVoucher)
    .where(and(eq(accountingExportVoucher.companyId, companyId), inArray(accountingExportVoucher.exportId, ids)))
    .groupBy(accountingExportVoucher.exportId, accountingExportVoucher.sourceKind)
  const totals = await tx
    .select({ exportId: accountingExportVoucher.exportId, currency: accountingExportVoucher.currency, debitMinor: sum(accountingExportLine.amountMinor).mapWith(Number) })
    .from(accountingExportLine)
    .innerJoin(accountingExportVoucher, and(eq(accountingExportVoucher.companyId, accountingExportLine.companyId), eq(accountingExportVoucher.id, accountingExportLine.voucherId)))
    .where(and(eq(accountingExportLine.companyId, companyId), inArray(accountingExportVoucher.exportId, ids), gt(accountingExportLine.amountMinor, 0)))
    .groupBy(accountingExportVoucher.exportId, accountingExportVoucher.currency)
    .orderBy(asc(accountingExportVoucher.currency))
  return rows.map((row) => {
    const byKind = zeroKinds()
    let backDatedCount = 0
    for (const entry of kinds.filter((candidate) => candidate.exportId === row.id)) {
      byKind[entry.kind as AccountingSourceKind] = entry.vouchers
      backDatedCount += entry.backDated
    }
    return {
      id: row.id,
      recordedAt: row.recordedAt.toISOString(),
      projectId: row.projectId,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      voucherFrom: row.voucherFrom,
      voucherTo: row.voucherTo,
      voucherCount: row.voucherTo - row.voucherFrom + 1,
      lineCount: row.lineCount,
      backDatedCount,
      byKind,
      totals: totals.filter((entry) => entry.exportId === row.id).map(({ currency, debitMinor }) => ({ currency, debitMinor })),
      createdBy: row.createdBy,
      note: row.note,
    }
  })
}

const exportScope = (principal: Principal): SQL | undefined => and(eq(accountingExport.companyId, principal.companyId), inProjects(accountingExport.projectId, principal))

async function findExport(tx: Tx, principal: Principal, id: string) {
  const [row] = await tx.select().from(accountingExport).where(and(exportScope(principal), eq(accountingExport.id, id))).limit(1)
  return row
}

const noSuchExport = (id: string) => problem(404, { detail: `No accounting export ${id} in the projects this account works in` })

const ExportPage = Page(AccountingExport)

const EXPORT_RULES =
  "An export books every row of the project no export took yet, dated on or before `periodTo` — the project's today at the latest (400 at `periodTo`, `An export's period ends by today`) — and on or after the mapping's `exportsFrom` where it names one: each issued invoice and credit note on its `issuedOn`, each payment on its `paidOn`, and each allocation of a payment that named no customer on the day it was recorded, which moves the money from the unmatched payments account to receivables. One balanced voucher per row on its own day, numbered on from the project's last: an invoice debits receivables its gross and credits revenue per account and VAT rate — a product's own account, else the mapping's `revenue` — and the VAT per rate to its code's account; a credit note the same with its negative amounts; a payment debits the bank and credits receivables, or the unmatched payments account when it names no customer. A row dated before `periodFrom` is back-dated: it arrived after an earlier export took its period. A row is exported once, ever."

export function accountingRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/accounting-settings",
      describeRoute({
        operationId: "getAccountingSettings",
        summary: "A project's accounting mapping",
        description:
          "The accounts of the office's chart the project's exports book to (#291 C7), each with its number in Erhvervsstyrelsen's standard chart where it is mapped, in number order; the four defaults by account number — `receivable`, `bank`, `suspense` (where a payment that names no customer waits) and `revenue` (where a line's revenue goes when its product names no account); `exportsFrom`, the first day an export books; a code per VAT rate and the account its VAT goes to; and the products' own revenue accounts. A project never set up reads empty. `projectId` is a project the caller works in (400 on the query otherwise).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's mapping.", AccountingSettings),
          400: describeProblem("`projectId` is missing, malformed, or not a project this account works in."),
          ...problems(SETTINGS_MODULE, "view"),
        },
      }),
      guard,
      requireGrant(SETTINGS_MODULE, "view"),
      validate("query", AccountingSettingsQuery),
      async (c) => {
        const { projectId } = c.req.valid("query")
        const principal = c.get("principal")
        requireProject(principal, projectId, "projectId", "query")
        return c.json(await settingsOf(c.get("tx"), { companyId: principal.companyId, projectId }))
      },
    )
    .put(
      "/accounting-settings",
      describeRoute({
        operationId: "putAccountingSettings",
        summary: "Replace a project's accounting mapping",
        description:
          "Replaces the project's whole mapping with the body's. An account is named by its number, each once (400 on `accounts`); every number the defaults, the VAT codes and the product accounts name is one the body lists (400 at its path, `Not an account of this mapping: list it under accounts`); a VAT rate has one code (400 on `vatCodes`) and a product one account (400 on `productAccounts`), each product the project's (400 at `productAccounts.N.productId`, `Not a product of this project`). An account kept by its number keeps its row; one left out is deleted. Exports already made keep their lines as frozen. Under the project's row lock. Every row written is audited under the request's principal, a set of its project.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's mapping as it now stands.", AccountingSettings),
          400: describeProblem("The body names a member the command does not take, a number twice or of the wrong shape, an account it does not list, a rate or a product twice, a product that is not the project's, or a project this account does not work in."),
          ...problems(SETTINGS_MODULE, "edit"),
        },
      }),
      guard,
      requireGrant(SETTINGS_MODULE, "edit"),
      validate("json", AccountingSettingsSet),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
        await replaceSettings(tx, scope, body)
        return c.json(await settingsOf(tx, scope))
      },
    )
    .get(
      "/accounting-exports",
      describeRoute({
        operationId: "listAccountingExports",
        summary: "The accounting exports of the caller's projects",
        description:
          "One page of exports, oldest first, from the projects the caller works in, each with its period, the voucher numbers it took, its counts per kind of row, how many of its vouchers are back-dated, and the debits it books per currency. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of exports.", ExportPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          ...problems(EXPORT_MODULE, "view"),
        },
      }),
      guard,
      requireGrant(EXPORT_MODULE, "view"),
      validate("query", AccountingExportListQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select()
          .from(accountingExport)
          .where(and(exportScope(principal), projectId === undefined ? undefined : eq(accountingExport.projectId, projectId), after === undefined ? undefined : gt(accountingExport.id, after)))
          .orderBy(asc(accountingExport.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: await exportsOf(tx, principal.companyId, page.items) })
      },
    )
    .post(
      "/accounting-exports/preview",
      describeRoute({
        operationId: "previewAccountingExport",
        summary: "What an accounting export of a period would book",
        description: `What \`POST /accounting-exports\` would book now, written nowhere: its vouchers and lines, counted per kind of row, the back-dated ones, the debits per currency, and every row the mapping cannot book yet with the sentence saying what to set up. ${EXPORT_RULES}`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("What the export would book.", AccountingExportPreview),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards or past the project's today, or names a project this account does not work in."),
          ...problems(EXPORT_MODULE, "view"),
        },
      }),
      guard,
      requireGrant(EXPORT_MODULE, "view"),
      validate("json", AccountingExportCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        await requireClosedPeriod(tx, scope, body.periodTo, now)
        const plan = await planExport(tx, scope, body)
        const byKind = zeroKinds()
        const debits = new Map<string, number>()
        for (const voucher of plan.vouchers) {
          byKind[voucher.source.kind] += 1
          for (const line of voucher.lines) if (line.amountMinor > 0) debits.set(voucher.currency, (debits.get(voucher.currency) ?? 0) + line.amountMinor)
        }
        const preview: AccountingExportPreview = {
          voucherCount: plan.vouchers.length,
          lineCount: plan.vouchers.reduce((total, voucher) => total + voucher.lines.length, 0),
          backDatedCount: plan.backDated,
          byKind,
          totals: [...debits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, debitMinor]) => ({ currency, debitMinor })),
          gaps: plan.gaps.map((gap) => ({ kind: gap.source.kind, sourceId: gap.source.id, document: gap.source.document, sentence: gap.sentence })),
        }
        return c.json(preview)
      },
    )
    .post(
      "/accounting-exports",
      describeRoute({
        operationId: "createAccountingExport",
        summary: "Export a period for the office's bookkeeping",
        description: `Books the period in the request's transaction, under the project's row lock — a billing run's too, so a run and an export take turns. ${EXPORT_RULES} Refused while the mapping cannot book a row (409, the gap's sentence and the document), with nothing left to book (409, \`${NOTHING_TO_EXPORT}\`), or over more than ${ACCOUNTING_EXPORT_MAX_VOUCHERS} rows (409, \`${tooManyVouchers(ACCOUNTING_EXPORT_MAX_VOUCHERS + 1)}\`). The file is \`GET /accounting-exports/{id}/file\`.`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The export as written.", AccountingExport),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards or past the project's today, or names a project this account does not work in."),
          ...problems(EXPORT_MODULE, "create"),
          409: describeProblem("The mapping cannot book a row of the period, nothing is left to book, or too many rows fall in the period."),
        },
      }),
      guard,
      requireGrant(EXPORT_MODULE, "create"),
      validate("json", AccountingExportCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        await requireClosedPeriod(tx, scope, body.periodTo, now)
        const written = await runExport(tx, { ...scope, periodFrom: body.periodFrom, periodTo: body.periodTo, note: body.note ?? null, createdBy: principal.user.id, newId })
        const row = await findExport(tx, principal, written.id)
        const [answer] = await exportsOf(tx, principal.companyId, [row!])
        return created(c, "/accounting-exports", answer)
      },
    )
    .get(
      "/accounting-exports/:id",
      describeRoute({
        operationId: "getAccountingExport",
        summary: "One accounting export",
        description: "One export of a project the caller works in: its period, the voucher numbers it took, its counts per kind of row, its back-dated vouchers and the debits it books per currency. An export of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The export.", AccountingExport),
          400: describeProblem("The path does not hold an id."),
          ...problems(EXPORT_MODULE, "view"),
          404: describeProblem("No accounting export with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(EXPORT_MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findExport(tx, principal, id)
        if (row === undefined) throw noSuchExport(id)
        const [answer] = await exportsOf(tx, principal.companyId, [row])
        return c.json(answer)
      },
    )
    .get(
      "/accounting-exports/:id/file",
      describeRoute({
        operationId: "getAccountingExportFile",
        summary: "An accounting export's file",
        description:
          "The export's lines as a file, rendered from the lines it froze, so a download is the same bytes every time. `format` is `csv`, our own: UTF-8 with a byte-order mark; semicolon-separated, as e-conomic's journal import and a Danish spreadsheet expect; CRLF line ends; a header row, then one row per line in voucher order. The columns: `voucher` (the voucher number), `date` (the row's own day, `YYYY-MM-DD`), `account` and `account_name` (the account of the office's chart, as it was named), `text`, `amount` (signed — a debit positive, a credit negative — in the currency's digits with a decimal comma and no grouping; always the line's own: a revenue line's net, a VAT line's VAT), `vat_code` (the rate's code on a revenue line and its VAT line; a system that books VAT from a code on a gross amount imports the file with this column unmapped), `currency`, `customer`, `document` (the invoice's or credit note's label, a payment's reference, an allocation's invoice), `source` (`invoice`, `credit-note`, `payment` or `allocation`) and `source_id`. A voucher's lines sum to zero. `format` is `saf-t`, Danish SAF-T 2.1 (`urn:StandardAuditFile-Taxation-Financial:DK`, Erhvervsstyrelsen's Danish_SAF-T_Financial_Schema_v_2_1.xsd), made on the project's today: the company's identity in its header — its CVR where its registration number is one, else the number — with its postal address read as the street on the first line and the postal code and city on the last, and its IBAN; each account a line names, with its standard-chart number (`StandardAccountID`, chart version `" + STANDARD_CHART_VERSION + "`) and its type by its role in the mapping as it now stands — receivables, the bank and unmatched payments an `Asset`, a revenue account a `Sale`, a VAT code's account a `Liability`, any other `Other` — opening at 0 and closing at the net of the file's lines, since the file is the export's and holds no balances; each VAT code a line names, with its standard code where it has one; and one journal, `ACCOUNTING`, of one transaction per voucher. SAF-T's amounts are in the company's currency, so a voucher in another is left out and named in the header comment. Refused while the file cannot be made (409, the sentence saying what to set): no postal address in that shape, no IBAN, an account a line names that the mapping no longer lists or that has no standard-chart number, or one mapped in roles of different types.",
        security: BEARER_SECURITY,
        responses: {
          200: { description: "The file.", content: { "text/csv": { schema: { type: "string" as const } }, "application/xml": { schema: { type: "string" as const } } } },
          400: describeProblem("The path does not hold an id, or `format` is not one."),
          ...problems(EXPORT_MODULE, "view"),
          404: describeProblem("No accounting export with that id in the projects this account works in."),
          409: describeProblem("A SAF-T file cannot be made yet: the sentence says what to set up."),
        },
      }),
      guard,
      requireGrant(EXPORT_MODULE, "view"),
      validate("param", IdParam),
      validate("query", AccountingFileQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findExport(tx, principal, id)
        if (row === undefined) throw noSuchExport(id)
        const scope: Scope = { companyId: principal.companyId, projectId: row.projectId }
        const name = `accounting-${row.periodFrom}-${row.periodTo}-${row.voucherFrom}-${row.voucherTo}`
        if (c.req.valid("query").format === "saf-t") {
          const file = await safTFileOf(tx, scope, row, await projectToday(tx, scope, now)())
          if ("gap" in file) throw problem(409, { detail: safTGapSentence(file.gap) })
          return c.body(file.xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${name}-saf-t.xml"` })
        }
        const lines = await exportedLines(tx, scope, row.id)
        return c.body(accountingCsv(lines), 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${name}.csv"`,
        })
      },
    )
}
