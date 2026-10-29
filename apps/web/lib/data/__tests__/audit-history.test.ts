// A row's history as the details sheet reads it (#291): the API's audit log
// grouped by the request that made each change, newest first, each entry
// saying who, when and why, and what moved — the row's own columns, and the
// rows of its sets added, changed or removed — in words, a reference named by
// the row it points at.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { AuditEvent } from "@waste/contracts/audit"

import { companyHistoryEntriesOf, historyEntriesOf } from "../audit-history"

const AGREEMENT = "0199a000-0000-7000-8000-000000000001"
const CUSTOMER = "0199a000-0000-7000-8000-000000000002"
const OTHER_CUSTOMER = "0199a000-0000-7000-8000-000000000003"
const SUBSCRIPTION = "0199a000-0000-7000-8000-000000000004"
const PRODUCT = "0199a000-0000-7000-8000-000000000005"
const TESTER = { id: "0199a000-0000-7000-8000-0000000000aa", fullName: "Mette Holm" }

let sequence = 0
function event(overrides: Partial<AuditEvent>): AuditEvent {
  sequence += 1
  return {
    id: `0199a000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    recordedAt: "2026-10-24T08:30:00.000Z",
    projectId: null,
    table: "agreement",
    rowId: AGREEMENT,
    parentTable: null,
    parentId: null,
    action: "update",
    changed: {},
    actor: TESTER,
    reason: null,
    transactionId: "1",
    ...overrides,
  }
}

const names = new Map([
  [CUSTOMER, "Østerbro Boligselskab"],
  [OTHER_CUSTOMER, "Nordhavn Ejendomme"],
  [PRODUCT, "240 L bin emptying"],
])
const subject = { table: "agreement", rowId: AGREEMENT } as const
const read = (events: AuditEvent[]) => historyEntriesOf(events, subject, { nameOf: (id) => names.get(id), when: (at) => `at ${at.slice(11, 16)}` })

describe("a row's history", () => {
  test("the row's own change says the columns that moved, before and after, by whom, when and why", () => {
    const [entry] = read([event({ changed: { status: ["draft", "active"], billing_cadence: ["monthly", "quarterly"] }, reason: "Signed by the board", transactionId: "7" })])
    assert.deepEqual(entry, {
      key: "7",
      when: "at 08:30",
      who: "Mette Holm",
      reason: "Signed by the board",
      lines: [
        {
          what: "Changed",
          changes: [
            { label: "Status", before: "Draft", after: "Active" },
            { label: "Billing cadence", before: "monthly", after: "quarterly" },
          ],
        },
      ],
    })
  })

  test("a reference is named by the row it points at, an unknown one by its id, and a cleared value is null", () => {
    const [entry] = read([
      event({ changed: { payer_customer_id: [CUSTOMER, OTHER_CUSTOMER], price_list_id: ["0199a000-0000-7000-8000-0000000000ff", null], valid_to: ["2027-01-01", null] } }),
    ])
    assert.deepEqual(entry.lines[0].changes, [
      { label: "Payer customer", before: "Østerbro Boligselskab", after: "Nordhavn Ejendomme" },
      { label: "Price list", before: "0199a000-0000-7000-8000-0000000000ff", after: null },
      { label: "Valid to", before: "2027-01-01", after: null },
    ])
  })

  test("the row's create and delete are said alone, without the values they wrote or removed", () => {
    const entries = read([event({ action: "delete", changed: { number: ["AGR-1", null] }, transactionId: "9" }), event({ action: "insert", changed: { number: [null, "AGR-1"] }, transactionId: "2" })])
    assert.deepEqual(
      entries.map((entry) => entry.lines),
      [[{ what: "Deleted", changes: [] }], [{ what: "Created", changes: [] }]],
    )
  })

  test("a set's row is added, changed or removed by its table's name, its values shown and the column naming the row left out", () => {
    const set = { table: "subscription", rowId: SUBSCRIPTION, parentTable: "agreement", parentId: AGREEMENT }
    const [added] = read([event({ ...set, action: "insert", changed: { agreement_id: [null, AGREEMENT], product_id: [null, PRODUCT], quantity: [null, 2] } })])
    assert.deepEqual(added.lines, [
      {
        what: "Added subscription",
        changes: [
          { label: "Product", before: null, after: "240 L bin emptying" },
          { label: "Quantity", before: null, after: "2" },
        ],
      },
    ])
    const [removed] = read([event({ ...set, action: "delete", changed: { agreement_id: [AGREEMENT, null], quantity: [2, null] } })])
    assert.deepEqual(removed.lines, [{ what: "Removed subscription", changes: [{ label: "Quantity", before: "2", after: null }] }])
    const [changed] = read([event({ ...set, table: "role_grant", action: "update", changed: { is_allowed: [false, true] } })])
    assert.deepEqual(changed.lines, [{ what: "Changed role grant", changes: [{ label: "Is allowed", before: "No", after: "Yes" }] }])
  })

  test("one request's changes are one entry, in the order the log answered them; entries stay newest first", () => {
    const entries = read([
      event({ transactionId: "12", changed: { status: ["active", "inactive"] } }),
      event({ transactionId: "11", table: "subscription", rowId: SUBSCRIPTION, parentTable: "agreement", parentId: AGREEMENT, action: "insert", changed: { quantity: [null, 1] } }),
      event({ transactionId: "11", changed: { notes: ["", "Two bins"] } }),
    ])
    assert.deepEqual(
      entries.map((entry) => [entry.key, entry.lines.map((line) => line.what)]),
      [
        ["12", ["Changed"]],
        ["11", ["Added subscription", "Changed"]],
      ],
    )
  })

  test("a change with no person is the system's, and one by an account no longer here says so", () => {
    const entries = read([event({ actor: null, transactionId: "3" }), event({ actor: { id: TESTER.id, fullName: "" }, transactionId: "4" })])
    assert.deepEqual(
      entries.map((entry) => entry.who),
      ["System", "A removed account"],
    )
  })

  test("a value that is not text is shown as the wire's JSON", () => {
    const [entry] = read([event({ changed: { weekdays: [["mon"], ["mon", "thu"]], location: [null, { type: "Point", coordinates: [12.5, 55.7] }] } })])
    assert.deepEqual(entry.lines[0].changes, [
      { label: "Weekdays", before: '["mon"]', after: '["mon","thu"]' },
      { label: "Location", before: null, after: '{"type":"Point","coordinates":[12.5,55.7]}' },
    ])
  })
})

// The company's whole history (Settings › Privacy, audit & retention on the
// Pilot): no row is the subject, so each line names the row it is about, and
// a set's row the row it belongs to where its own name is not held.
describe("the company's history", () => {
  const readCompany = (events: AuditEvent[]) => companyHistoryEntriesOf(events, { nameOf: (id) => names.get(id), when: (at) => `at ${at.slice(11, 16)}` })

  test("a create or a delete names its table and its row, with no columns", () => {
    const entries = readCompany([
      event({ transactionId: "2", table: "customer", rowId: CUSTOMER, action: "insert", changed: { name: [null, "Østerbro Boligselskab"] } }),
      event({ transactionId: "1", table: "customer", rowId: OTHER_CUSTOMER, action: "delete", changed: {} }),
    ])
    assert.deepEqual(
      entries.map((entry) => entry.lines),
      [[{ what: "Created customer Østerbro Boligselskab", changes: [] }], [{ what: "Deleted customer Nordhavn Ejendomme", changes: [] }]],
    )
  })

  test("a change lists the columns that moved, a reference by the row it names, and a row the store does not hold by its table alone", () => {
    const [entry] = readCompany([event({ transactionId: "5", reason: "New payer", changed: { payer_customer_id: [CUSTOMER, OTHER_CUSTOMER] } })])
    assert.deepEqual(entry, {
      key: "5",
      when: "at 08:30",
      who: "Mette Holm",
      reason: "New payer",
      lines: [{ what: "Changed agreement", changes: [{ label: "Payer customer", before: "Østerbro Boligselskab", after: "Nordhavn Ejendomme" }] }],
    })
  })

  test("a set's row is named by the row it belongs to, and one request's rows are one entry", () => {
    const entries = readCompany([
      event({ transactionId: "9", table: "subscription", rowId: SUBSCRIPTION, parentTable: "agreement", parentId: CUSTOMER, action: "insert", changed: { quantity: [null, 1] } }),
      event({ transactionId: "9", table: "product", rowId: PRODUCT, changed: { name: ["Bin", "240 L bin emptying"] } }),
    ])
    assert.equal(entries.length, 1)
    assert.deepEqual(
      entries[0].lines.map((line) => line.what),
      ["Added subscription of agreement Østerbro Boligselskab", "Changed product 240 L bin emptying"],
    )
  })
})
