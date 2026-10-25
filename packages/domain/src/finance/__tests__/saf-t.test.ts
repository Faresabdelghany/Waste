// Danish SAF-T 2.1 (#291 slice 7, #292 C7b): an export's vouchers as the
// standard file — the company's identity in its header, the accounts its
// lines name with their standard numbers and types, opening at 0 and closing
// at the file's net, the VAT codes in force from the file's first day, one journal
// with an amount's currency triple on every line — a voucher in another
// currency left out and named, and the gap in the way of a file named
// instead of a file. The API's test validates a file against ERST's XSD.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { accountTypesOf, addressOf, safTAmount, safTGapSentence, safTXml, STANDARD_CHART_VERSION, type SafTInput, type SafTVoucher } from "../saf-t"

const voucher = (overrides: Partial<SafTVoucher> = {}): SafTVoucher => ({
  voucher: 1,
  bookedOn: "2026-10-05",
  document: "INV-1012",
  customerName: "Boligforeningen Kystbyen",
  currency: "DKK",
  lines: [
    { accountNumber: "5600", text: "INV-1012 Boligforeningen Kystbyen", amountMinor: 250_000 },
    { accountNumber: "1010", text: "INV-1012 revenue 25 %", amountMinor: -200_000 },
    { accountNumber: "6800", text: "INV-1012 VAT 25 %", amountMinor: -50_000 },
  ],
  ...overrides,
})

const PAYMENT = voucher({
  voucher: 2,
  bookedOn: "2026-10-20",
  document: "REF-88",
  lines: [
    { accountNumber: "5820", text: "REF-88 Boligforeningen Kystbyen", amountMinor: 250_000 },
    { accountNumber: "5600", text: "REF-88 Boligforeningen Kystbyen", amountMinor: -250_000 },
  ],
})

const input = (overrides: Partial<SafTInput> = {}): SafTInput => ({
  createdOn: "2026-11-02",
  software: { companyName: "Waste", id: "Waste accounting export", version: "1" },
  company: {
    registrationNumber: "12345678",
    name: "Kystbyen Renovation A/S",
    vatNumber: "DK12345678",
    postalAddress: "Havnegade 12\n5000 Odense C",
    country: "DK",
    bankIban: "DK50 0040 0440 1162 43",
    bankBic: "NDEADKKK",
  },
  currency: "DKK",
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  entity: "Odense Kommune",
  accounts: [
    { number: "1010", name: "Salg af tømning", standardAccount: "1010", type: "Sale" },
    { number: "5600", name: "Debitorer", standardAccount: "5600", type: "Asset" },
    { number: "5820", name: "Bank", standardAccount: "5820", type: "Asset" },
    { number: "6800", name: "Salgsmoms", standardAccount: "7740", type: "Liability" },
    { number: "9999", name: "Not on any line", standardAccount: "", type: "Other" },
  ],
  taxCodes: [{ code: "U25", standardTaxCode: "S1", percent: 25 }],
  vouchers: [voucher(), PAYMENT],
  ...overrides,
})

/** The file's text, failing the test on a gap. */
const fileOf = (overrides: Partial<SafTInput> = {}): string => {
  const file = safTXml(input(overrides))
  assert.ok("xml" in file, `a gap: ${JSON.stringify(file)}`)
  return file.xml
}

/** Every element's text by its name, in order. */
const texts = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((match) => match[1])

describe("SAF-T's amounts", () => {
  test("carry two decimals, a point and no sign, whatever digits the currency keeps", () => {
    assert.equal(safTAmount(250_000, "DKK"), "2500.00")
    assert.equal(safTAmount(-5, "DKK"), "0.05")
    assert.equal(safTAmount(0, "DKK"), "0.00")
    assert.equal(safTAmount(1200, "JPY"), "1200.00")
    // Three digits are rounded half away from zero to two.
    assert.equal(safTAmount(1235, "KWD"), "1.24")
    assert.equal(safTAmount(-1235, "KWD"), "1.24")
    assert.equal(safTAmount(1234, "KWD"), "1.23")
  })
})

describe("SAF-T's address", () => {
  test("is the street and number on the first line and the postal code and city on the last", () => {
    assert.deepEqual(addressOf("Havnegade 12\n5000 Odense C"), { street: "Havnegade", number: "12", postalCode: "5000", city: "Odense C" })
    assert.deepEqual(addressOf(" Østergade 4B \n c/o Kontoret \n 8000 Aarhus "), { street: "Østergade", number: "4B", postalCode: "8000", city: "Aarhus" })
    assert.deepEqual(addressOf("Havnen\n5000 Odense C"), { street: "Havnen", number: null, postalCode: "5000", city: "Odense C" })
  })

  test("is none for one line, or a last line that is not a postal code and a city", () => {
    assert.equal(addressOf("Havnegade 12, 5000 Odense C"), undefined)
    assert.equal(addressOf("Havnegade 12\nOdense"), undefined)
    assert.equal(addressOf(null), undefined)
  })
})

describe("SAF-T's account types", () => {
  test("are each account's role: receivables, bank and suspense an asset, revenue a sale, a VAT code's account a liability; two kinds clash", () => {
    const { types, clashes } = accountTypesOf({ assets: ["5600", "5820", null], sales: ["1010", "1020", "1010"], liabilities: ["6800", "1020"] })
    assert.deepEqual(Object.fromEntries(types), { 5600: "Asset", 5820: "Asset", 1010: "Sale", 1020: "Sale", 6800: "Liability" })
    assert.deepEqual(clashes, ["1020"])
  })
})

describe("a SAF-T file", () => {
  test("heads with the company: its CVR, name, address, VAT registration and bank, and the export's period", () => {
    const xml = fileOf()
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:DK">\n\t<Header>\n'))
    assert.deepEqual(texts(xml, "AuditFileVersion"), ["2.1"])
    assert.deepEqual(texts(xml, "AuditFileDateCreated"), ["2026-11-02"])
    assert.deepEqual(texts(xml, "CVR"), ["12345678"])
    assert.deepEqual(texts(xml, "RegistrationNumber"), [])
    assert.deepEqual([texts(xml, "StreetName"), texts(xml, "Number"), texts(xml, "PostalCode"), texts(xml, "City")], [["Havnegade"], ["12"], ["5000"], ["Odense C"]])
    assert.deepEqual(texts(xml, "TaxRegistrationNumber"), ["DK12345678"])
    assert.deepEqual(texts(xml, "IBANNumber"), ["DK5000400440116243"])
    assert.deepEqual(texts(xml, "BIC"), ["NDEADKKK"])
    assert.deepEqual([texts(xml, "SelectionStartDate"), texts(xml, "SelectionEndDate")], [["2026-10-01"], ["2026-10-31"]])
    assert.deepEqual(texts(xml, "TaxEntity"), ["Odense Kommune"])
  })

  test("names a registration that is no CVR as the registration number, and leaves out what the company does not hold", () => {
    const xml = fileOf({ company: { ...input().company, registrationNumber: "556677-8899", vatNumber: null, bankBic: null } })
    assert.deepEqual(texts(xml, "CVR"), [])
    assert.deepEqual(texts(xml, "RegistrationNumber"), ["556677-8899"])
    assert.deepEqual([texts(xml, "TaxRegistrationNumber"), texts(xml, "BIC")], [[], []])
  })

  test("lists each account a line names, by number, with its standard number and type, opening at 0 and closing at the file's net", () => {
    const xml = fileOf()
    assert.deepEqual(texts(xml, "VersionOfStandardAccount"), [STANDARD_CHART_VERSION])
    assert.deepEqual(texts(xml, "AccountID").slice(0, 4), ["1010", "5600", "5820", "6800"])
    assert.ok(!xml.includes("<AccountID>9999</AccountID>"), "an account no line names is not listed")
    assert.deepEqual(texts(xml, "StandardAccountID"), ["1010", "5600", "5820", "7740"])
    assert.deepEqual(texts(xml, "AccountType"), ["Sale", "Asset", "Asset", "Liability"])
    assert.deepEqual(texts(xml, "OpeningDebitBalance"), ["0.00", "0.00", "0.00", "0.00"])
    // Receivables close at 0: invoiced and paid.
    assert.deepEqual(texts(xml, "ClosingCreditBalance"), ["2000.00", "500.00"])
    assert.deepEqual(texts(xml, "ClosingDebitBalance"), ["0.00", "2500.00"])
  })

  test("names the VAT codes in force from its first day, the period's or a back-dated voucher's, with their standard codes", () => {
    const xml = fileOf()
    assert.deepEqual([texts(xml, "TaxCode"), texts(xml, "StandardTaxCode"), texts(xml, "EffectiveDate"), texts(xml, "TaxPercentage")], [["U25"], ["S1"], ["2026-10-01"], ["25"]])
    assert.deepEqual(texts(fileOf({ vouchers: [voucher({ bookedOn: "2026-09-28" }), PAYMENT] }), "EffectiveDate"), ["2026-09-28"])
    const unmapped = fileOf({ taxCodes: [{ code: "U25", standardTaxCode: null, percent: 25 }] })
    assert.deepEqual(texts(unmapped, "StandardTaxCode"), [])
    assert.ok(!fileOf({ taxCodes: [] }).includes("<TaxTable>"))
  })

  test("journals each voucher as a transaction on its day, each line debit or credit by its sign with its currency triple", () => {
    const xml = fileOf()
    assert.deepEqual([texts(xml, "NumberOfEntries"), texts(xml, "TotalDebit"), texts(xml, "TotalCredit")], [["2"], ["5000.00"], ["5000.00"]])
    assert.deepEqual(texts(xml, "TransactionID"), ["1", "2"])
    assert.deepEqual([texts(xml, "Period"), texts(xml, "PeriodYear"), texts(xml, "TransactionDate")], [["10", "10"], ["2026", "2026"], ["2026-10-05", "2026-10-20"]])
    assert.deepEqual(texts(xml, "RecordID"), ["1-1", "1-2", "1-3", "2-1", "2-2"])
    assert.deepEqual(texts(xml, "SourceDocumentID"), ["INV-1012", "INV-1012", "INV-1012", "REF-88", "REF-88"])
    const first = xml.slice(xml.indexOf("<RecordID>1-1</RecordID>"), xml.indexOf("<RecordID>1-2</RecordID>"))
    assert.match(first, /<DebitAmount>\s*<Amount>2500\.00<\/Amount>\s*<CurrencyCode>DKK<\/CurrencyCode>\s*<CurrencyAmount>2500\.00<\/CurrencyAmount>\s*<ExchangeRate>1\.0<\/ExchangeRate>\s*<\/DebitAmount>/)
    const second = xml.slice(xml.indexOf("<RecordID>1-2</RecordID>"), xml.indexOf("<RecordID>1-3</RecordID>"))
    assert.match(second, /<CreditAmount>\s*<Amount>2000\.00<\/Amount>/)
  })

  test("escapes its texts", () => {
    const xml = fileOf({ vouchers: [voucher({ customerName: "Hansen & Søn <ApS>", document: null })] })
    assert.ok(xml.includes("<Description>Hansen &amp; Søn &lt;ApS&gt;</Description>"))
    assert.deepEqual(texts(xml, "SourceDocumentID"), [])
  })

  test("leaves a voucher in another currency out and names it in its header comment", () => {
    const file = safTXml(input({ vouchers: [voucher(), PAYMENT, voucher({ voucher: 3, currency: "EUR", lines: [{ accountNumber: "5600", text: "EUR", amountMinor: 100 }, { accountNumber: "1010", text: "EUR", amountMinor: -100 }] })] }))
    assert.ok("xml" in file)
    assert.deepEqual(file.excluded.map((left) => left.voucher), [3])
    assert.deepEqual(texts(file.xml, "TransactionID"), ["1", "2"])
    assert.match(texts(file.xml, "HeaderComment")[0], /Left out, in another currency than DKK: voucher 3 \(EUR\)\.$/)
  })

  test("is refused while the company has no address, bank or registration, or a line's account is unmapped or has no standard number", () => {
    const gap = (overrides: Partial<SafTInput>) => safTXml(input(overrides))
    const company = input().company
    assert.deepEqual(gap({ company: { ...company, postalAddress: "Havnegade 12" } }), { gap: { company: "address" } })
    assert.deepEqual(gap({ company: { ...company, bankIban: null } }), { gap: { company: "bank" } })
    assert.deepEqual(gap({ company: { ...company, registrationNumber: " " } }), { gap: { company: "registration" } })
    assert.deepEqual(gap({ accounts: input().accounts.filter((account) => account.number !== "5820") }), { gap: { account: "5820", why: "unmapped" } })
    assert.deepEqual(gap({ accounts: input().accounts.map((account) => (account.number === "6800" ? { ...account, standardAccount: "" } : account)) }), { gap: { account: "6800", why: "no-standard-account" } })
    assert.match(safTGapSentence({ account: "6800", why: "no-standard-account" }), /^Account 6800 has no number in the standard chart/)
    assert.match(safTGapSentence({ company: "bank" }), /IBAN/)
  })
})
