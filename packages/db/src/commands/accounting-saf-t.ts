// An accounting export as Danish SAF-T 2.1 (#291 slice 7, #292 C7b): the
// export's frozen lines, by voucher, with what SAF-T asks beside them —
// each account's number in the standard chart and its type, read off the
// project's mapping as it stands; the VAT codes the lines name, with their
// rates and standard codes; and the company's identity, its registration,
// address and bank — rendered by @waste/domain/finance/saf-t, which says the
// rules. Unlike the CSV, the file carries the day it was made and the
// mapping's standard numbers as they stand, so it is rendered afresh on each
// download; its lines are the export's own.
import { accountTypesOf, safTXml, type SafTGap, type SafTVoucher } from "@waste/domain/finance/saf-t"
import { and, asc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { accountingAccount, accountingProductAccount, accountingSettings, accountingVatCode } from "../schema/finance"
import { company, project } from "../schema/organisation"
import { exportedLines } from "./accounting-exports"
import type { Scope } from "./project-clock"

/** Who wrote the file, as its header says. */
export const SAF_T_SOFTWARE = { companyName: "Waste", id: "Waste accounting export", version: "1" }

/** An export's SAF-T file made on `createdOn`, the project's day, and the vouchers it left out; or the gap in its way. */
export async function safTFileOf(tx: Tx, scope: Scope, exported: { id: string; periodFrom: string; periodTo: string }, createdOn: string): Promise<{ xml: string; excluded: readonly SafTVoucher[] } | { gap: SafTGap }> {
  const [owner] = await tx
    .select({ legalName: company.legalName, registrationNumber: company.registrationNumber, vatNumber: company.vatNumber, postalAddress: company.postalAddress, country: company.country, bankIban: company.bankIban, bankBic: company.bankBic })
    .from(company)
    .where(eq(company.id, scope.companyId))
    .limit(1)
  const [held] = await tx.select({ name: project.name, currency: project.currency }).from(project).where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId))).limit(1)
  if (owner === undefined || held === undefined) throw new Error(`safTFileOf: no company ${scope.companyId} or project ${scope.projectId}`)

  const accounts = await tx
    .select({ id: accountingAccount.id, number: accountingAccount.number, name: accountingAccount.name, standardAccount: accountingAccount.standardAccount })
    .from(accountingAccount)
    .where(and(eq(accountingAccount.companyId, scope.companyId), eq(accountingAccount.projectId, scope.projectId)))
    .orderBy(asc(accountingAccount.number))
  const numberOf = new Map(accounts.map((row) => [row.id, row.number]))
  const of = (id: string | null): string | null => (id === null ? null : (numberOf.get(id) ?? null))
  const [settings] = await tx.select().from(accountingSettings).where(and(eq(accountingSettings.companyId, scope.companyId), eq(accountingSettings.projectId, scope.projectId))).limit(1)
  const vatCodes = await tx
    .select({ vatPercent: accountingVatCode.vatPercent, code: accountingVatCode.code, accountId: accountingVatCode.accountId, standardTaxCode: accountingVatCode.standardTaxCode })
    .from(accountingVatCode)
    .where(and(eq(accountingVatCode.companyId, scope.companyId), eq(accountingVatCode.projectId, scope.projectId)))
    .orderBy(asc(accountingVatCode.vatPercent))
  const products = await tx
    .select({ accountId: accountingProductAccount.accountId })
    .from(accountingProductAccount)
    .where(and(eq(accountingProductAccount.companyId, scope.companyId), eq(accountingProductAccount.projectId, scope.projectId)))
  const { types, clashes } = accountTypesOf({
    assets: [of(settings?.receivableAccountId ?? null), of(settings?.bankAccountId ?? null), of(settings?.suspenseAccountId ?? null)],
    sales: [of(settings?.revenueAccountId ?? null), ...products.map((row) => of(row.accountId))],
    liabilities: vatCodes.map((row) => of(row.accountId)),
  })

  const lines = await exportedLines(tx, scope, exported.id)
  const vouchers: SafTVoucher[] = [...Map.groupBy(lines, (line) => line.voucher).values()].map((group) => ({
    voucher: group[0].voucher,
    bookedOn: group[0].bookedOn,
    document: group[0].document,
    customerName: group[0].customerName,
    currency: group[0].currency,
    lines: group.map((line) => ({ accountNumber: line.accountNumber, text: line.text, amountMinor: line.amountMinor })),
  }))
  // A clash matters only where the file names the account: a voucher in another currency is left out of it.
  const inFile = lines.filter((line) => line.currency === held.currency)
  const clash = clashes.find((number) => inFile.some((line) => line.accountNumber === number))
  if (clash !== undefined) return { gap: { account: clash, why: "two-types" } }
  const codesNamed = new Set(inFile.flatMap((line) => (line.vatCode === null ? [] : [line.vatCode])))

  return safTXml({
    createdOn,
    software: SAF_T_SOFTWARE,
    company: { registrationNumber: owner.registrationNumber, name: owner.legalName, vatNumber: owner.vatNumber, postalAddress: owner.postalAddress, country: owner.country, bankIban: owner.bankIban, bankBic: owner.bankBic },
    currency: held.currency,
    periodFrom: exported.periodFrom,
    periodTo: exported.periodTo,
    entity: held.name,
    // An account no role names now is typed Other: it is still the office's, and a line names it.
    accounts: accounts.map((row) => ({ number: row.number, name: row.name, standardAccount: row.standardAccount ?? "", type: types.get(row.number) ?? "Other" })),
    taxCodes: vatCodes.filter((row) => codesNamed.has(row.code)).map((row) => ({ code: row.code, standardTaxCode: row.standardTaxCode, percent: row.vatPercent })),
    vouchers,
  })
}
