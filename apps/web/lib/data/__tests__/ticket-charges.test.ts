import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TicketChargesSet } from "@waste/contracts/tickets"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import type { BusinessRecord } from "../business-modules"
import { NO_ONE } from "../properties"
import { picksOf, ticketChargesBody, TICKET_KIND_ROWS, ticketWorkProductOptions } from "../ticket-charges"

const PROJECT = "01a0d2a4-a280-7001-8000-000000000001"
const BULKY = "01a0d2a4-a280-700a-8000-000000000005"
const RESIDUAL = "01a0d2a4-a280-700a-8000-000000000001"
const UNLOADED = "01a0d2a4-a280-700a-8000-0000000000ff"

const product = (id: string, values: { project?: string; unit?: string; status?: string; name?: string } = {}): BusinessRecord =>
  ({
    id,
    name: values.name ?? id,
    status: values.status ?? "Active",
    projectIds: [values.project ?? "project-copenhagen"],
    recordKind: "Product",
    submittedValues: { priceUnit: values.unit ?? "job" },
  }) as unknown as BusinessRecord

describe("a project's ticket charges on the web (#291 C3)", () => {
  const products = [
    product("product-bulky", { name: "Bulky pickup" }),
    product("product-residual", { name: "Residual collection", unit: "pickup" }),
    product("product-rental", { name: "Container rental", unit: "month" }),
    product("product-hire", { name: "Skip hire", unit: "day" }),
    product("product-retired", { name: "Old crane lift", status: "Inactive" }),
    product("product-harbor", { name: "Harbor bulky", project: "project-harbor" }),
  ]

  test("offers the project's products a ticket's work may be charged at: never one sold by the month or the day, a retired one by its status, the API's 409 saying why", () => {
    assert.deepEqual(ticketWorkProductOptions(products, "project-copenhagen"), [
      { value: "product-bulky", label: "Bulky pickup" },
      { value: "product-residual", label: "Residual collection" },
      { value: "product-retired", label: "Old crane lift · Inactive" },
    ])
    assert.deepEqual(ticketWorkProductOptions(products, "project-harbor"), [{ value: "product-harbor", label: "Harbor bulky" }])
  })

  test("lists every ticket kind once, in the vocabulary's order, by its label", () => {
    assert.deepEqual(
      TICKET_KIND_ROWS.map((row) => row.kind),
      [...TICKET_KINDS],
    )
    assert.equal(TICKET_KIND_ROWS.find((row) => row.kind === "missed-collection")?.label, "Missed collection")
  })

  test("reads the set into a pick per kind by the store's web ids, and writes the picks back by the server's, a kind at None charged at nothing", () => {
    const serverOf: Record<string, string> = { "product-bulky": BULKY, "product-residual": RESIDUAL }
    const webOf = Object.fromEntries(Object.entries(serverOf).map(([web, server]) => [server, web]))
    const picks = picksOf({ projectId: PROJECT, charges: [{ kind: "overflow", productId: BULKY }, { kind: "complaint", productId: UNLOADED }] }, (serverId) => webOf[serverId])
    assert.deepEqual(picks, { overflow: "product-bulky", complaint: UNLOADED }, "a product the store has not loaded is kept by its server id")
    const body = ticketChargesBody(PROJECT, { ...picks, "missed-collection": "product-residual", "container-request": NO_ONE }, (webId) => serverOf[webId] ?? (webId === UNLOADED ? UNLOADED : undefined))
    assert.deepEqual(body, {
      projectId: PROJECT,
      charges: [
        { kind: "missed-collection", productId: RESIDUAL },
        { kind: "overflow", productId: BULKY },
        { kind: "complaint", productId: UNLOADED },
      ],
    })
    assert.ok(TicketChargesSet.safeParse(body).success)
    assert.deepEqual(ticketChargesBody(PROJECT, { overflow: "product-unknown" }, () => undefined), { path: "overflow", message: "Pick a product the API holds" })
  })
})
