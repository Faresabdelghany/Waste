// Danish SAF-T 2.1 (#291 slice 7, #292 C7b): an accounting export as the
// standard file Erhvervsstyrelsen says every registered bookkeeping system
// must generate, import and export from 1 January 2027 (erhvervsstyrelsen.dk,
// "Standardkontoplan og SAF-T"); its schema is
// Danish_SAF-T_Financial_Schema_v_2_1.xsd at git.erst.dk/standard-filformater.
// Pure: the API reads the export's frozen lines, the project's mapping and
// the company's identity, and this renders them, or names what stands in the
// way.
//
// The file is the export's, not a ledger's: we are no bookkeeping system and
// hold no balances, so each account's opening balance is 0 and its closing
// balance the net of the file's own lines — what the header comment says.
// Each account's type is its role in the mapping: receivables, the bank and
// the unmatched payments account an Asset, a revenue account (the default
// or a product's) a Sale, a VAT code's account a Liability; an account in two
// roles of different types is a gap. Every account carries its number in the
// standard chart, which SAF-T maps to (StandardAccountID); an unmapped one is
// a gap. SAF-T's amounts are in the company's currency and we keep no
// exchange rates, so a voucher in another currency is left out of the file
// and named in its header comment, as the CSV carries it in its own.
//
// One journal of the export's vouchers: each voucher a transaction on its own
// day — its number the transaction's id and its system id — and each line a
// line of it, debit or credit by its sign, its amount in the company's
// currency with the currency, the same amount and a rate of 1.0, the triple
// the Danish schema requires of every amount. A text longer than its element
// takes is cut, a document's label never, since it is short.
import { roundHalfAwayFromZero } from "./money"
import { minorDigitsOf } from "./payments"

/** The standard chart's version the file names (VersionOfStandardAccount): Erhvervsstyrelsen's chart as updated for 2026, in the form its own SAF-T example spells it. */
export const STANDARD_CHART_VERSION = "20260101"

/** SAF-T's account types, the XSD's enumeration. */
export const SAF_T_ACCOUNT_TYPES = ["Asset", "Liability", "Sale", "Expense", "Other"] as const
export type SafTAccountType = (typeof SAF_T_ACCOUNT_TYPES)[number]

/** The company as the header names it: its registration (a Danish CVR where it is one), its legal name, its address and its bank. */
export type SafTCompany = {
  registrationNumber: string
  name: string
  vatNumber: string | null
  /** The postal address as Settings holds it: lines, the street first and the postal code with the city last. */
  postalAddress: string | null
  country: string
  bankIban: string | null
  bankBic: string | null
}

/** An account of the file: its number, name and standard-chart number, and its type by its role. */
export type SafTAccount = { number: string; name: string; standardAccount: string; type: SafTAccountType }

/** A VAT code of the file. */
export type SafTTaxCode = { code: string; standardTaxCode: string | null; percent: number }

/** A voucher of the export as frozen: its number, day, document, customer, currency and lines. */
export type SafTVoucher = { voucher: number; bookedOn: string; document: string | null; customerName: string | null; currency: string; lines: { accountNumber: string; text: string; amountMinor: number }[] }

export type SafTInput = {
  createdOn: string
  software: { companyName: string; id: string; version: string }
  company: SafTCompany
  /** The company's currency, the file's: a voucher in another is left out. */
  currency: string
  /** The export's period, the file's selection. */
  periodFrom: string
  periodTo: string
  /** What the file is of: the project the export booked. */
  entity: string
  accounts: readonly SafTAccount[]
  taxCodes: readonly SafTTaxCode[]
  vouchers: readonly SafTVoucher[]
}

/** What stands in the way of a file: the company's identity, or an account. */
export type SafTGap = { company: "address" | "bank" | "registration" } | { account: string; why: "unmapped" | "no-standard-account" | "two-types" }

/** The sentence a gap is refused with. */
export function safTGapSentence(gap: SafTGap): string {
  if ("company" in gap) {
    return {
      address: "SAF-T needs the company's postal address as its street on the first line and its postal code and city on the last: set it in Settings › Finance & invoicing",
      bank: "SAF-T needs the company's bank account: set its IBAN in Settings › Finance & invoicing",
      registration: "SAF-T needs the company's registration number",
    }[gap.company]
  }
  return {
    unmapped: `Account ${gap.account} of the export is no longer in the project's mapping: list it again under Settings › Commercial › Accounting`,
    "no-standard-account": `Account ${gap.account} has no number in the standard chart: set it in Settings › Commercial › Accounting`,
    "two-types": `Account ${gap.account} is mapped in roles of different kinds — an asset, a sale or a liability — which SAF-T cannot type`,
  }[gap.why]
}

/** An address of the file: the street and number, the postal code and the city; undefined where the lines do not read as one. */
export function addressOf(postalAddress: string | null): { street: string; number: string | null; postalCode: string; city: string } | undefined {
  const lines = (postalAddress ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "")
  if (lines.length < 2) return undefined
  const place = /^(\S+)\s+(.+)$/.exec(lines.at(-1)!)
  if (place === null) return undefined
  const street = /^(.*?)\s+(\d+\S*)$/.exec(lines[0])
  return { street: street?.[1] ?? lines[0], number: street?.[2] ?? null, postalCode: place[1], city: place[2] }
}

/** An amount in the file's notation, which carries two decimals: a point, no sign (a debit or a credit says it), no grouping; a currency of three digits rounded half away from zero to two. */
export function safTAmount(minor: number, currency: string): string {
  const digits = minorDigitsOf(currency)
  const cents = digits === 2 ? Math.abs(minor) : digits === 0 ? Math.abs(minor) * 100 : roundHalfAwayFromZero(Math.abs(minor) / 10 ** (digits - 2))
  const text = String(cents).padStart(3, "0")
  return `${text.slice(0, -2)}.${text.slice(-2)}`
}

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

/** A text cut to what its element takes. */
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** One element on its own line at its depth, its text escaped. */
const element = (depth: number, name: string, text: string): string => `${"\t".repeat(depth)}<${name}>${escape(text)}</${name}>`

/** The file, or the gap in its way. */
export function safTXml(input: SafTInput): { xml: string; excluded: readonly SafTVoucher[] } | { gap: SafTGap } {
  const address = addressOf(input.company.postalAddress)
  if (address === undefined) return { gap: { company: "address" } }
  if (input.company.bankIban === null || input.company.bankIban.trim() === "") return { gap: { company: "bank" } }
  if (input.company.registrationNumber.trim() === "") return { gap: { company: "registration" } }
  const included = input.vouchers.filter((voucher) => voucher.currency === input.currency)
  const excluded = input.vouchers.filter((voucher) => voucher.currency !== input.currency)
  const accounts = new Map(input.accounts.map((account) => [account.number, account]))
  const used = [...new Set(included.flatMap((voucher) => voucher.lines.map((line) => line.accountNumber)))]
  for (const number of used) {
    const account = accounts.get(number)
    if (account === undefined) return { gap: { account: number, why: "unmapped" } }
    if (account.standardAccount.trim() === "") return { gap: { account: number, why: "no-standard-account" } }
  }
  const net = new Map<string, number>()
  for (const voucher of included) for (const line of voucher.lines) net.set(line.accountNumber, (net.get(line.accountNumber) ?? 0) + line.amountMinor)
  const debit = included.reduce((sum, voucher) => sum + voucher.lines.reduce((lines, line) => lines + Math.max(line.amountMinor, 0), 0), 0)
  const money = (minor: number) => safTAmount(minor, input.currency)
  const cvr = /^\d{8}$/.test(input.company.registrationNumber.trim()) ? input.company.registrationNumber.trim() : null

  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:DK">', "\t<Header>"]
  out.push(element(2, "AuditFileVersion", "2.1"), element(2, "AuditFileCountry", input.company.country), element(2, "AuditFileDateCreated", input.createdOn))
  out.push(element(2, "SoftwareCompanyName", cut(input.software.companyName, 70)), element(2, "SoftwareID", cut(input.software.id, 256)), element(2, "SoftwareVersion", cut(input.software.version, 18)))
  out.push("\t\t<Company>", cvr === null ? element(3, "RegistrationNumber", cut(input.company.registrationNumber.trim(), 35)) : element(3, "CVR", cvr), element(3, "Name", cut(input.company.name, 70)))
  out.push("\t\t\t<Address>", element(4, "StreetName", cut(address.street, 70)), ...(address.number === null ? [] : [element(4, "Number", cut(address.number, 18))]), element(4, "City", cut(address.city, 35)), element(4, "PostalCode", cut(address.postalCode, 18)), element(4, "Country", input.company.country), "\t\t\t</Address>")
  if (input.company.vatNumber !== null && input.company.vatNumber.trim() !== "") out.push("\t\t\t<TaxRegistration>", element(4, "TaxRegistrationNumber", cut(input.company.vatNumber.trim(), 35)), element(4, "TaxType", "VAT"), element(4, "Country", input.company.country), "\t\t\t</TaxRegistration>")
  out.push("\t\t\t<BankAccount>", element(4, "IBANNumber", cut(input.company.bankIban.replaceAll(" ", ""), 35)), ...(input.company.bankBic === null || input.company.bankBic.trim() === "" ? [] : [element(4, "BIC", cut(input.company.bankBic.trim(), 18))]), element(4, "CurrencyCode", input.currency), "\t\t\t</BankAccount>")
  out.push("\t\t</Company>", element(2, "DefaultCurrencyCode", input.currency), "\t\t<SelectionCriteria>", element(3, "SelectionStartDate", input.periodFrom), element(3, "SelectionEndDate", input.periodTo), "\t\t</SelectionCriteria>")
  const comment = `An accounting export of ${input.entity}, ${input.periodFrom} – ${input.periodTo}: the export's own vouchers, so each account opens at 0 and closes at the net of this file's lines.${excluded.length === 0 ? "" : ` Left out, in another currency than ${input.currency}: voucher${excluded.length === 1 ? "" : "s"} ${excluded.map((voucher) => `${voucher.voucher} (${voucher.currency})`).join(", ")}.`}`
  out.push(element(2, "HeaderComment", cut(comment, 256)), element(2, "TaxEntity", cut(input.entity, 70)), "\t</Header>")

  out.push("\t<MasterFiles>", "\t\t<GeneralLedgerAccounts>", element(3, "NameOfStandardAccount", "Standardkontoplanen"), element(3, "VersionOfStandardAccount", STANDARD_CHART_VERSION))
  for (const number of [...used].sort()) {
    const account = accounts.get(number)!
    const closing = net.get(number) ?? 0
    out.push("\t\t\t<Account>", element(4, "AccountID", account.number), element(4, "AccountDescription", cut(account.name, 256)), element(4, "StandardAccountID", cut(account.standardAccount, 70)), element(4, "AccountType", account.type))
    out.push(element(4, "OpeningDebitBalance", money(0)), element(4, closing < 0 ? "ClosingCreditBalance" : "ClosingDebitBalance", money(closing)), "\t\t\t</Account>")
  }
  out.push("\t\t</GeneralLedgerAccounts>")
  // A code is in force from the file's first day: the period's, or a back-dated voucher's before it.
  const effectiveFrom = included.reduce((first, voucher) => (voucher.bookedOn < first ? voucher.bookedOn : first), input.periodFrom)
  if (input.taxCodes.length > 0) {
    out.push("\t\t<TaxTable>", "\t\t\t<TaxTableEntry>", element(4, "TaxType", "VAT"), element(4, "Description", "VAT"))
    for (const code of input.taxCodes) {
      out.push("\t\t\t\t<TaxCodeDetails>", element(5, "TaxCode", code.code), ...(code.standardTaxCode === null ? [] : [element(5, "StandardTaxCode", code.standardTaxCode)]), element(5, "EffectiveDate", effectiveFrom), element(5, "Description", `VAT ${code.percent} %`), element(5, "TaxPercentage", String(code.percent)), element(5, "Country", input.company.country), "\t\t\t\t</TaxCodeDetails>")
    }
    out.push("\t\t\t</TaxTableEntry>", "\t\t</TaxTable>")
  }
  out.push("\t</MasterFiles>")

  out.push("\t<GeneralLedgerEntries>", element(2, "NumberOfEntries", String(included.length)), element(2, "TotalDebit", money(debit)), element(2, "TotalCredit", money(debit)))
  out.push("\t\t<Journal>", element(3, "JournalID", "ACCOUNTING"), element(3, "Description", cut(`Accounting export of ${input.entity}`, 256)), element(3, "Type", "GL"))
  for (const voucher of included) {
    const [year, month] = voucher.bookedOn.split("-")
    const description = [voucher.document, voucher.customerName].filter((part) => part !== null && part !== "").join(" ") || `Voucher ${voucher.voucher}`
    out.push("\t\t\t<Transaction>", element(4, "TransactionID", String(voucher.voucher)), element(4, "Period", String(Number(month))), element(4, "PeriodYear", year), element(4, "TransactionDate", voucher.bookedOn))
    out.push(element(4, "Description", cut(description, 256)), element(4, "SystemEntryDate", voucher.bookedOn), element(4, "GLPostingDate", voucher.bookedOn), element(4, "SystemID", cut(String(voucher.voucher), 18)))
    for (const [position, line] of voucher.lines.entries()) {
      out.push("\t\t\t\t<Line>", element(5, "RecordID", cut(`${voucher.voucher}-${position + 1}`, 18)), element(5, "AccountID", line.accountNumber), ...(voucher.document === null ? [] : [element(5, "SourceDocumentID", cut(voucher.document, 35))]), element(5, "Description", cut(line.text, 256)))
      out.push(`\t\t\t\t\t<${line.amountMinor < 0 ? "CreditAmount" : "DebitAmount"}>`, element(6, "Amount", money(line.amountMinor)), element(6, "CurrencyCode", input.currency), element(6, "CurrencyAmount", money(line.amountMinor)), element(6, "ExchangeRate", "1.0"), `\t\t\t\t\t</${line.amountMinor < 0 ? "CreditAmount" : "DebitAmount"}>`, "\t\t\t\t</Line>")
    }
    out.push("\t\t\t</Transaction>")
  }
  out.push("\t\t</Journal>", "\t</GeneralLedgerEntries>", "</AuditFile>", "")
  return { xml: out.join("\n"), excluded }
}

/** Each account's SAF-T type by its role in the mapping; a number in two roles of different types is named. */
export function accountTypesOf(roles: { assets: readonly (string | null)[]; sales: readonly (string | null)[]; liabilities: readonly (string | null)[] }): { types: Map<string, SafTAccountType>; clashes: string[] } {
  const types = new Map<string, SafTAccountType>()
  const clashes = new Set<string>()
  const put = (number: string | null, type: SafTAccountType) => {
    if (number === null) return
    const held = types.get(number)
    if (held !== undefined && held !== type) clashes.add(number)
    else types.set(number, type)
  }
  for (const number of roles.assets) put(number, "Asset")
  for (const number of roles.sales) put(number, "Sale")
  for (const number of roles.liabilities) put(number, "Liability")
  return { types, clashes: [...clashes].sort() }
}
