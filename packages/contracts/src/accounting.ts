// The accounting export on the wire (#291 slice 7, #292 C7). A project's
// mapping is read and replaced whole, as Settings › Finance & invoicing sets
// it: the accounts of the office's chart, each with its number in
// Erhvervsstyrelsen's standard chart where it is mapped; the four the export
// books to by default — receivables, bank, unmatched payments and revenue —
// named by account number; the first day exports book; a code per VAT rate
// and the account its VAT goes to; and a product's own revenue account. An
// export is a period's vouchers, each source row once ever, whose file is
// rendered from its frozen lines (@waste/domain/finance/accounting).
import { ACCOUNT_NUMBER_PATTERN, ACCOUNTING_CSV_COLUMNS, VAT_CODE_PATTERN } from "@waste/domain/finance/accounting"
import { ACCOUNTING_FORMATS, ACCOUNTING_SOURCE_KINDS } from "@waste/domain/finance/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { periodIsOrdered, periodOrdered } from "./billing"
import { ProjectScopedListQuery } from "./queries"
import { Minor, NonNegativeInt, PositiveInt, recorded } from "./resource"
import { Label, Paragraph } from "./text"

export const AccountingSourceKind = z.enum(ACCOUNTING_SOURCE_KINDS)
export type AccountingSourceKind = z.infer<typeof AccountingSourceKind>

export const AccountingFormat = z.enum(ACCOUNTING_FORMATS)
export type AccountingFormat = z.infer<typeof AccountingFormat>

/** What an account number that is not one is told. */
export const ACCOUNT_NUMBER_SHAPE = "An account number is a letter or digit, then up to nineteen letters, digits, points or hyphens"

/** An account's number, in the office's chart or the standard chart. */
export const AccountNumber = z.string().regex(new RegExp(ACCOUNT_NUMBER_PATTERN), ACCOUNT_NUMBER_SHAPE)

/** A VAT code as the office's system spells it: `U25`. */
export const VatCodeText = z.string().regex(new RegExp(VAT_CODE_PATTERN), "A VAT code is a letter or digit, then up to eight letters, digits, underscores or hyphens")

/** A VAT rate in whole percent, as a line carries it. */
export const VatPercent = z.int().min(0).max(100)

export const AccountingAccount = z.object({
  number: AccountNumber,
  name: Label,
  /** Its number in Erhvervsstyrelsen's standard chart, which Danish SAF-T maps every account to; null until the office maps it. */
  standardAccount: AccountNumber.nullable(),
})
export type AccountingAccount = z.infer<typeof AccountingAccount>

export const AccountingVatCode = z.object({ vatPercent: VatPercent, code: VatCodeText, account: AccountNumber })
export type AccountingVatCode = z.infer<typeof AccountingVatCode>

export const AccountingProductAccount = z.object({ productId: Id, account: AccountNumber })
export type AccountingProductAccount = z.infer<typeof AccountingProductAccount>

/** The most accounts, VAT codes or product accounts one mapping holds. */
export const ACCOUNTING_SET_MAX = 500

/** A project's mapping, as read: the accounts in number order, the codes by rate, the products' accounts by product. */
export const AccountingSettings = z.object({
  projectId: Id,
  accounts: z.array(AccountingAccount),
  receivable: AccountNumber.nullable(),
  bank: AccountNumber.nullable(),
  /** Where a payment that names no customer waits until it is matched. */
  suspense: AccountNumber.nullable(),
  /** Where a line's revenue goes when its product names no account of its own. */
  revenue: AccountNumber.nullable(),
  /** The first day an export books; rows before it were booked by other means. Null books from the first. */
  exportsFrom: IsoDate.nullable(),
  vatCodes: z.array(AccountingVatCode),
  productAccounts: z.array(AccountingProductAccount),
})
export type AccountingSettings = z.infer<typeof AccountingSettings>

/** What a mapping naming an account it does not list is told, at the field. */
export const NOT_AN_ACCOUNT = "Not an account of this mapping: list it under accounts"

/** What a mapping listing an account number twice is told. */
export const ACCOUNT_ONCE = "Each account number once"

/** What a mapping giving a VAT rate two codes is told. */
export const RATE_ONCE = "Each VAT rate once"

/** What a mapping giving a product two accounts is told. */
export const PRODUCT_ONCE = "Each product once"

const once = <T>(values: readonly T[]): boolean => new Set(values).size === values.length

/** `PUT /accounting-settings`: the project's whole mapping, replacing what stands; every account the body names is one it lists. */
export const AccountingSettingsSet = z
  .strictObject({
    projectId: Id,
    accounts: z.array(AccountingAccount.strict()).max(ACCOUNTING_SET_MAX),
    receivable: AccountNumber.nullable(),
    bank: AccountNumber.nullable(),
    suspense: AccountNumber.nullable(),
    revenue: AccountNumber.nullable(),
    exportsFrom: IsoDate.nullable(),
    vatCodes: z.array(AccountingVatCode.strict()).max(ACCOUNTING_SET_MAX),
    productAccounts: z.array(AccountingProductAccount.strict()).max(ACCOUNTING_SET_MAX),
  })
  .superRefine((body, context) => {
    if (!once(body.accounts.map((account) => account.number))) context.addIssue({ code: "custom", message: ACCOUNT_ONCE, path: ["accounts"] })
    if (!once(body.vatCodes.map((code) => code.vatPercent))) context.addIssue({ code: "custom", message: RATE_ONCE, path: ["vatCodes"] })
    if (!once(body.productAccounts.map((entry) => entry.productId))) context.addIssue({ code: "custom", message: PRODUCT_ONCE, path: ["productAccounts"] })
    const listed = new Set(body.accounts.map((account) => account.number))
    for (const field of ["receivable", "bank", "suspense", "revenue"] as const) {
      const named = body[field]
      if (named !== null && !listed.has(named)) context.addIssue({ code: "custom", message: NOT_AN_ACCOUNT, path: [field] })
    }
    for (const [index, code] of body.vatCodes.entries()) if (!listed.has(code.account)) context.addIssue({ code: "custom", message: NOT_AN_ACCOUNT, path: ["vatCodes", index, "account"] })
    for (const [index, entry] of body.productAccounts.entries()) if (!listed.has(entry.account)) context.addIssue({ code: "custom", message: NOT_AN_ACCOUNT, path: ["productAccounts", index, "account"] })
  })
export type AccountingSettingsSet = z.infer<typeof AccountingSettingsSet>

/** `GET /accounting-settings`: the project the mapping is read for. */
export const AccountingSettingsQuery = z.object({ projectId: Id })
export type AccountingSettingsQuery = z.infer<typeof AccountingSettingsQuery>

/** `POST /accounting-exports` and its preview: the project and the booking period, its last day the project's today at the latest. */
export const AccountingExportCreate = z
  .strictObject({
    projectId: Id,
    periodFrom: IsoDate,
    periodTo: IsoDate,
    note: Paragraph.optional(),
  })
  .refine(periodOrdered, periodIsOrdered)
export type AccountingExportCreate = z.infer<typeof AccountingExportCreate>

/** A count of vouchers per kind of row booked. */
export const AccountingKindCounts = z.object({ invoice: NonNegativeInt, "credit-note": NonNegativeInt, payment: NonNegativeInt, allocation: NonNegativeInt })

/** What the vouchers move in a currency: the debits, which the credits equal. */
export const AccountingCurrencyTotal = z.object({ currency: Currency, debitMinor: Minor })

/** A row an export cannot book while the mapping lacks an account or a code. */
export const AccountingGap = z.object({ kind: AccountingSourceKind, sourceId: Id, document: z.string().nullable(), sentence: z.string() })

/** What a preview answers: what a run would book now, and every gap in its way; nothing written. */
export const AccountingExportPreview = z.object({
  voucherCount: NonNegativeInt,
  lineCount: NonNegativeInt,
  /** Vouchers dated before the period: they arrived after an earlier export took it. */
  backDatedCount: NonNegativeInt,
  byKind: AccountingKindCounts,
  totals: z.array(AccountingCurrencyTotal),
  gaps: z.array(AccountingGap),
})
export type AccountingExportPreview = z.infer<typeof AccountingExportPreview>

/** An export, as it was written: its period, the vouchers it took and what they book. */
export const AccountingExport = z.object({
  ...recorded,
  projectId: Id,
  periodFrom: IsoDate,
  periodTo: IsoDate,
  voucherFrom: PositiveInt,
  voucherTo: PositiveInt,
  voucherCount: PositiveInt,
  lineCount: PositiveInt,
  backDatedCount: NonNegativeInt,
  byKind: AccountingKindCounts,
  totals: z.array(AccountingCurrencyTotal),
  createdBy: Id.nullable(),
  note: z.string().nullable(),
})
export type AccountingExport = z.infer<typeof AccountingExport>

export const AccountingExportListQuery = ProjectScopedListQuery
export type AccountingExportListQuery = z.infer<typeof AccountingExportListQuery>

/** `GET /accounting-exports/:id/file`: the format to render; our CSV unless asked. */
export const AccountingFileQuery = z.object({ format: AccountingFormat.default("csv") })
export type AccountingFileQuery = z.infer<typeof AccountingFileQuery>

/** Our CSV's columns, in order: the file's documentation. */
export const ACCOUNTING_CSV_HEADER = ACCOUNTING_CSV_COLUMNS
