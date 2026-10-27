// A row's history on the wire (#291): every switched kind whose table the
// audit trail keeps names that table, the kinds that keep none are the
// ledgers, execution and the money the work makes, and a history is one
// page of `GET /audit-events` for the row's table and server id.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AUDITED_TABLES } from "@waste/contracts/audit"

import { PAGE_LIMIT_MAX } from "../client"
import { historyPage, historySubjectOf } from "../records/audit"
import { serverModuleOf, SERVER_MODULES } from "../records/modules"
import { json, scripted } from "./scripted-fetch"

const kinds = SERVER_MODULES.flatMap((module) => module.resources.map((resource) => ({ key: `${module.workspaceId}.${module.moduleId}`, prefix: resource.prefix as string, table: resource.auditTable as string | undefined })))

describe("which kinds keep a history", () => {
  test("a kind's table is one the audit trail keeps, and no two kinds name one table", () => {
    const named = kinds.flatMap((kind) => (kind.table === undefined ? [] : [kind.table]))
    for (const table of named) assert.ok((AUDITED_TABLES as readonly string[]).includes(table), table)
    assert.equal(new Set(named).size, named.length)
  })

  test("the kinds that keep none are the ledgers, execution and the money the work makes", () => {
    assert.deepEqual(
      kinds.filter((kind) => kind.table === undefined).map((kind) => `${kind.key} ${kind.prefix}`).sort(),
      [
        "commercial.accounting accounting-export",
        "commercial.billing billing-run",
        "commercial.events event",
        "commercial.invoices invoice",
        "commercial.payments payment",
        "fleet.vehicle-planning allocation",
        "operate.exceptions alert",
        "operate.tickets ticket",
        "resources.inventory movement",
        "route-studio.live route",
        "route-studio.pickups pickup",
        "route-studio.routes route",
        "route-studio.weights unload",
        // A provider's team (#291 C24): the accounts' and the roles' history is Settings › Users & roles', under `configure.access`.
        "service-providers.service-provider-workspace role",
        "service-providers.service-provider-workspace user",
      ].sort(),
    )
  })
})

describe("a record's history", () => {
  const agreements = serverModuleOf("customers", "agreements")
  assert.ok(agreements)
  const agreement = { id: "agreement-0199a000-0000-7000-8000-000000000001", recordKind: "agreement" } as Parameters<typeof historySubjectOf>[1]

  test("is read by its kind's table and its server id", () => {
    const serverIds = new Map([[agreement.id, "0199a000-0000-7000-8000-000000000001"]])
    assert.deepEqual(historySubjectOf(agreements, agreement, serverIds), { table: "agreement", rowId: "0199a000-0000-7000-8000-000000000001" })
  })

  test("has none to read before the API has answered the row", () => {
    assert.equal(historySubjectOf(agreements, agreement, new Map()), null)
  })

  test("is one page of the audit log for the row, newest first as the API answers it", async () => {
    const page = { items: [], nextCursor: null }
    const { fetch, calls } = scripted([() => json(page)])
    assert.deepEqual(await historyPage({ baseUrl: "http://api.test", token: "t", fetch }, { table: "agreement", rowId: "r1" }), page)
    assert.equal(calls[0].url, `http://api.test/audit-events?limit=${PAGE_LIMIT_MAX}&table=agreement&rowId=r1`)
  })
})
