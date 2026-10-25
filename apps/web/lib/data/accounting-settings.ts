// Settings › Commercial › Accounting's rules (#291 C7w): a project's mapping
// onto the office's chart as the pane edits it — every value typed text, the
// accounts in the order the office lists them — and the body the API takes,
// judged here first by the contracts' shapes and references in their
// sentences (`AccountingSettingsSet`), so a refusal names its row before the
// API is asked. The four defaults and each VAT code and product account name
// an account by its number; "None" is a default left unset.
import type { AccountingSettings, AccountingSettingsSet } from "@waste/contracts/accounting"
import { ACCOUNT_NUMBER_PATTERN, VAT_CODE_PATTERN } from "@waste/domain/finance/accounting"

import type { LocalRefusal } from "@/lib/api/records/adapter"
import { NO_ONE } from "@/lib/data/properties"

/** The four accounts an export books to by default, as Settings names them. */
export const ACCOUNTING_DEFAULTS = [
  { key: "receivable", label: "Receivables", hint: "The control account every invoice and credit note debits or credits its gross to." },
  { key: "bank", label: "Bank", hint: "Where a payment arrives." },
  { key: "suspense", label: "Unmatched payments", hint: "Where a payment that names no customer waits until it is matched to an invoice." },
  { key: "revenue", label: "Revenue", hint: "Where a line's revenue goes when its product names no account of its own." },
] as const

export type AccountingDefault = (typeof ACCOUNTING_DEFAULTS)[number]["key"]

/** A mapping as the pane edits it: every value as typed. */
export type AccountingDraft = {
  accounts: { number: string; name: string; standardAccount: string }[]
  defaults: Record<AccountingDefault, string>
  exportsFrom: string
  vatCodes: { vatPercent: string; code: string; account: string }[]
  productAccounts: { productId: string; account: string }[]
}

/** The mapping as read, as the pane edits it; a default left unset is "None". */
export function draftOf(settings: AccountingSettings): AccountingDraft {
  return {
    accounts: settings.accounts.map((account) => ({ number: account.number, name: account.name, standardAccount: account.standardAccount ?? "" })),
    defaults: { receivable: settings.receivable ?? NO_ONE, bank: settings.bank ?? NO_ONE, suspense: settings.suspense ?? NO_ONE, revenue: settings.revenue ?? NO_ONE },
    exportsFrom: settings.exportsFrom ?? "",
    vatCodes: settings.vatCodes.map((code) => ({ vatPercent: String(code.vatPercent), code: code.code, account: code.account })),
    productAccounts: settings.productAccounts.map((entry) => ({ productId: entry.productId, account: entry.account })),
  }
}

/** A draft of nothing: what a project never set up reads as. */
export const EMPTY_DRAFT: AccountingDraft = { accounts: [], defaults: { receivable: NO_ONE, bank: NO_ONE, suspense: NO_ONE, revenue: NO_ONE }, exportsFrom: "", vatCodes: [], productAccounts: [] }

const NUMBER = new RegExp(ACCOUNT_NUMBER_PATTERN)
const CODE = new RegExp(VAT_CODE_PATTERN)

/** What an account number of the wrong shape is told: the contracts' sentence. */
export const ACCOUNT_NUMBER_SHAPE = "An account number is a letter or digit, then up to nineteen letters, digits, points or hyphens"

/**
 * The body of the project's mapping, or the first refusal at the row and
 * field it names: an account by a number of its shape, once, with a name; a
 * standard-chart number of the same shape or none; every number a default, a
 * code or a product names one the accounts list; a rate in whole percent
 * once; a code of its shape; a product once.
 */
export function accountingSettingsBody(projectId: string, draft: AccountingDraft): AccountingSettingsSet | LocalRefusal {
  const accounts: AccountingSettingsSet["accounts"] = []
  for (const [index, account] of draft.accounts.entries()) {
    const number = account.number.trim()
    if (!NUMBER.test(number)) return { path: `accounts.${index}.number`, message: ACCOUNT_NUMBER_SHAPE }
    if (accounts.some((listed) => listed.number === number)) return { path: `accounts.${index}.number`, message: `Account ${number} is listed twice` }
    const name = account.name.trim()
    if (name === "") return { path: `accounts.${index}.name`, message: `Name account ${number}` }
    const standard = account.standardAccount.trim()
    if (standard !== "" && !NUMBER.test(standard)) return { path: `accounts.${index}.standardAccount`, message: `Account ${number}'s standard-chart number: ${ACCOUNT_NUMBER_SHAPE.toLowerCase()}` }
    accounts.push({ number, name, standardAccount: standard === "" ? null : standard })
  }
  const listed = new Set(accounts.map((account) => account.number))
  const named = (value: string, path: string): string | null | LocalRefusal => {
    if (value === NO_ONE || value === "") return null
    return listed.has(value) ? value : { path, message: `Account ${value} is not listed under the accounts` }
  }
  const defaults: Partial<Record<AccountingDefault, string | null>> = {}
  for (const { key } of ACCOUNTING_DEFAULTS) {
    const value = named(draft.defaults[key], key)
    if (typeof value === "object" && value !== null) return value
    defaults[key] = value
  }
  const vatCodes: AccountingSettingsSet["vatCodes"] = []
  for (const [index, row] of draft.vatCodes.entries()) {
    const percent = Number(row.vatPercent.trim())
    if (row.vatPercent.trim() === "" || !Number.isInteger(percent) || percent < 0 || percent > 100) return { path: `vatCodes.${index}.vatPercent`, message: "A VAT rate is a whole percent from 0 to 100" }
    if (vatCodes.some((code) => code.vatPercent === percent)) return { path: `vatCodes.${index}.vatPercent`, message: `${percent} % has a code already` }
    const code = row.code.trim()
    if (!CODE.test(code)) return { path: `vatCodes.${index}.code`, message: "A VAT code is a letter or digit, then up to eight letters, digits, underscores or hyphens" }
    const account = named(row.account, `vatCodes.${index}.account`)
    if (account === null) return { path: `vatCodes.${index}.account`, message: `Pick the account ${percent} % VAT goes to` }
    if (typeof account === "object") return account
    vatCodes.push({ vatPercent: percent, code, account })
  }
  const productAccounts: AccountingSettingsSet["productAccounts"] = []
  for (const [index, row] of draft.productAccounts.entries()) {
    if (row.productId === "" || row.productId === NO_ONE) return { path: `productAccounts.${index}.productId`, message: "Pick a product" }
    if (productAccounts.some((entry) => entry.productId === row.productId)) return { path: `productAccounts.${index}.productId`, message: "A product books to one account" }
    const account = named(row.account, `productAccounts.${index}.account`)
    if (account === null) return { path: `productAccounts.${index}.account`, message: "Pick the account the product's revenue goes to" }
    if (typeof account === "object") return account
    productAccounts.push({ productId: row.productId, account })
  }
  return {
    projectId,
    accounts,
    receivable: defaults.receivable ?? null,
    bank: defaults.bank ?? null,
    suspense: defaults.suspense ?? null,
    revenue: defaults.revenue ?? null,
    exportsFrom: draft.exportsFrom.trim() === "" ? null : draft.exportsFrom.trim(),
    vatCodes,
    productAccounts,
  }
}
