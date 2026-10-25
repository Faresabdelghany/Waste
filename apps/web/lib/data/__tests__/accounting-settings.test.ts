// Settings › Commercial › Accounting's rules (#291 C7w): a mapping read into
// the pane's draft and back into the body the API takes, held to the
// contracts' schema, and each refusal at the row and field it names before
// the API is asked.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AccountingSettingsSet, type AccountingSettings } from "@waste/contracts/accounting"

import { ACCOUNT_NUMBER_SHAPE, accountingSettingsBody, draftOf, EMPTY_DRAFT, type AccountingDraft } from "../accounting-settings"
import { NO_ONE } from "../properties"

const PROJECT = "01a0d2a4-a280-7002-8000-000000000001"
const PRODUCT = "01a0d2a4-a280-7030-8000-000000000001"
const read: AccountingSettings = {
  projectId: PROJECT,
  accounts: [
    { number: "1010", name: "Salg af tømning", standardAccount: "1010" },
    { number: "5600", name: "Debitorer", standardAccount: null },
    { number: "6800", name: "Salgsmoms", standardAccount: "6800" },
  ],
  receivable: "5600",
  bank: null,
  suspense: null,
  revenue: "1010",
  exportsFrom: "2026-10-01",
  vatCodes: [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: "S1" }],
  productAccounts: [{ productId: PRODUCT, account: "1010" }],
}

describe("the accounting mapping's draft", () => {
  test("reads a mapping as typed text, a default left unset as None, and goes back as the same body, which the contracts take", () => {
    const draft = draftOf(read)
    assert.deepEqual(draft.defaults, { receivable: "5600", bank: NO_ONE, suspense: NO_ONE, revenue: "1010" })
    assert.deepEqual(draft.accounts[1], { number: "5600", name: "Debitorer", standardAccount: "" })
    assert.deepEqual(draft.vatCodes, [{ vatPercent: "25", code: "U25", account: "6800", standardTaxCode: "S1" }])
    const body = accountingSettingsBody(PROJECT, draft)
    assert.deepEqual(body, read)
    assert.ok(AccountingSettingsSet.safeParse(body).success)
    assert.deepEqual(accountingSettingsBody(PROJECT, EMPTY_DRAFT), { projectId: PROJECT, accounts: [], receivable: null, bank: null, suspense: null, revenue: null, exportsFrom: null, vatCodes: [], productAccounts: [] })
  })

  test("trims what is typed: a number, a name, a code and a day", () => {
    const draft = draftOf(read)
    const typed: AccountingDraft = { ...draft, accounts: [{ number: " 1010 ", name: " Salg af tømning ", standardAccount: " 1010 " }, ...draft.accounts.slice(1)], vatCodes: [{ vatPercent: " 25 ", code: " U25 ", account: "6800", standardTaxCode: " S1 " }], exportsFrom: " 2026-10-01 " }
    assert.deepEqual(accountingSettingsBody(PROJECT, typed), read)
  })

  test("refuses at the row and field it names: a number of the wrong shape or twice, a nameless account, an unlisted account, a rate out of range or twice, a code of the wrong shape, a product twice", () => {
    const draft = draftOf(read)
    const refuse = (change: Partial<AccountingDraft>) => accountingSettingsBody(PROJECT, { ...draft, ...change })
    assert.deepEqual(refuse({ accounts: [{ number: "10 10", name: "Spaced", standardAccount: "" }] }), { path: "accounts.0.number", message: ACCOUNT_NUMBER_SHAPE })
    assert.deepEqual(refuse({ accounts: [...draft.accounts, { number: "5600", name: "Again", standardAccount: "" }] }), { path: "accounts.3.number", message: "Account 5600 is listed twice" })
    assert.deepEqual(refuse({ accounts: [{ number: "5600", name: " ", standardAccount: "" }] }), { path: "accounts.0.name", message: "Name account 5600" })
    assert.deepEqual(refuse({ defaults: { ...draft.defaults, bank: "5820" } }), { path: "bank", message: "Account 5820 is not listed under the accounts" })
    assert.deepEqual(refuse({ vatCodes: [{ vatPercent: "101", code: "U101", account: "6800", standardTaxCode: "" }] }), { path: "vatCodes.0.vatPercent", message: "A VAT rate is a whole percent from 0 to 100" })
    assert.deepEqual(refuse({ vatCodes: [...draft.vatCodes, { vatPercent: "25", code: "U26", account: "6800", standardTaxCode: "" }] }), { path: "vatCodes.1.vatPercent", message: "25 % has a code already" })
    assert.equal((refuse({ vatCodes: [{ vatPercent: "25", code: "U 25", account: "6800", standardTaxCode: "" }] }) as { path: string }).path, "vatCodes.0.code")
    assert.deepEqual(refuse({ vatCodes: [{ vatPercent: "25", code: "U25", account: NO_ONE, standardTaxCode: "" }] }), { path: "vatCodes.0.account", message: "Pick the account 25 % VAT goes to" })
    assert.equal((refuse({ vatCodes: [{ vatPercent: "25", code: "U25", account: "6800", standardTaxCode: "S 1" }] }) as { path: string }).path, "vatCodes.0.standardTaxCode")
    assert.deepEqual(refuse({ productAccounts: [...draft.productAccounts, { productId: PRODUCT, account: "1010" }] }), { path: "productAccounts.1.productId", message: "A product books to one account" })
    assert.deepEqual(refuse({ productAccounts: [{ productId: NO_ONE, account: "1010" }] }), { path: "productAccounts.0.productId", message: "Pick a product" })
  })
})
