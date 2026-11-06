import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TicketChargesSet } from "@waste/contracts/tickets"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import type { BusinessRecord } from "../business-modules"
import { NO_ONE } from "../properties"
import { chargeRowsOf, picksOf, TICKET_KIND_ROWS, ticketChargesBody, ticketWorkProductOptions, typesPicked } from "../ticket-charges"

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
    const picks = picksOf({ projectId: PROJECT, charges: [{ kind: "overflow", ticketTypeId: null, productId: BULKY }, { kind: "complaint", ticketTypeId: null, productId: UNLOADED }] }, (serverId) => webOf[serverId])
    assert.deepEqual(picks, { "kind:overflow": "product-bulky", "kind:complaint": UNLOADED }, "a product the store has not loaded is kept by its server id")
    const body = ticketChargesBody(PROJECT, { ...picks, "kind:missed-collection": "product-residual", "kind:container-request": NO_ONE }, (webId) => serverOf[webId] ?? (webId === UNLOADED ? UNLOADED : undefined))
    assert.deepEqual(body, {
      projectId: PROJECT,
      charges: [
        { kind: "missed-collection", ticketTypeId: null, productId: RESIDUAL },
        { kind: "overflow", ticketTypeId: null, productId: BULKY },
        { kind: "complaint", ticketTypeId: null, productId: UNLOADED },
      ],
    })
    assert.ok(TicketChargesSet.safeParse(body).success)
    assert.deepEqual(ticketChargesBody(PROJECT, { "kind:overflow": "product-unknown" }, () => undefined), { path: "kind:overflow", message: "Pick a product the API holds" })
  })

  test("lists each active type beneath the kinds, and a retired one the set names, a type at As its kind charged at its kind's (#548 of #544)", () => {
    const CRANE = "01a0d3a5-e5e0-7000-8000-0000000000c1"
    const OLD = "01a0d3a5-e5e0-7000-8000-0000000000c2"
    const types = [
      { id: CRANE, name: "Crane lift", kind: "container-request" as const, status: "active" as const },
      { id: OLD, name: "Old lift", kind: "container-request" as const, status: "inactive" as const },
    ]
    assert.deepEqual(chargeRowsOf(types).slice(TICKET_KINDS.length).map((row) => [row.ticketTypeId, row.label]), [[CRANE, "Crane lift (Container request)"]])
    const picks = picksOf({ projectId: PROJECT, charges: [{ kind: null, ticketTypeId: OLD, productId: BULKY }] }, () => "product-bulky")
    assert.deepEqual(picks, { [`type:${OLD}`]: "product-bulky" })
    const rows = chargeRowsOf(types, typesPicked(picks))
    assert.deepEqual(rows.slice(TICKET_KINDS.length).map((row) => row.ticketTypeId), [CRANE, OLD])
    const body = ticketChargesBody(PROJECT, { ...picks, [`type:${CRANE}`]: NO_ONE }, () => BULKY, rows)
    assert.deepEqual(body, { projectId: PROJECT, charges: [{ kind: null, ticketTypeId: OLD, productId: BULKY }] })
    assert.ok(TicketChargesSet.safeParse(body).success)
  })
})
