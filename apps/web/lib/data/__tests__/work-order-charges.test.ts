import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WorkOrderChargesSet } from "@waste/contracts/work-order-charges"
import { WORK_ORDER_SERVICES } from "@waste/domain/execution/vocabulary"

import type { BusinessRecord } from "../business-modules"
import { NO_ONE } from "../properties"
import { jobProductOptions, WORK_ORDER_ROWS, workOrderPicksOf, workOrderChargesBody } from "../work-order-charges"

const PROJECT = "01a0d2a4-a280-7001-8000-000000000001"
const DELIVERY = "01a0d2a4-a280-700a-8000-000000000011"
const WASH = "01a0d2a4-a280-700a-8000-000000000012"
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

describe("a project's work order charges on the web (M14 of #293)", () => {
  const products = [
    product("product-delivery", { name: "Container delivery" }),
    product("product-residual", { name: "Residual collection", unit: "pickup" }),
    product("product-hire", { name: "Skip hire", unit: "day" }),
    product("product-retired", { name: "Old wash", status: "Inactive" }),
    product("product-harbor", { name: "Harbor delivery", project: "project-harbor" }),
  ]

  test("offers the project's products sold by the job alone, a retired one by its status, the API's 409 saying why", () => {
    assert.deepEqual(jobProductOptions(products, "project-copenhagen"), [
      { value: "product-delivery", label: "Container delivery" },
      { value: "product-retired", label: "Old wash · Inactive" },
    ])
    assert.deepEqual(jobProductOptions(products, "project-harbor"), [{ value: "product-harbor", label: "Harbor delivery" }])
  })

  test("lists every work order once, in the vocabulary's order, by the stop's label for it", () => {
    assert.deepEqual(
      WORK_ORDER_ROWS.map((row) => row.service),
      [...WORK_ORDER_SERVICES],
    )
    assert.deepEqual(
      WORK_ORDER_ROWS.map((row) => row.label),
      ["Delivery", "Removal", "Swap", "Repair", "Wash"],
    )
  })

  test("reads the set into a pick per service by the store's ids, and writes the picks back by the server's, a service at None charged at nothing", () => {
    const serverOf: Record<string, string> = { "product-delivery": DELIVERY, "product-wash": WASH }
    const webOf = Object.fromEntries(Object.entries(serverOf).map(([web, server]) => [server, web]))
    const picks = workOrderPicksOf({ projectId: PROJECT, charges: [{ service: "wash", productId: WASH }, { service: "repair", productId: UNLOADED }] }, (serverId) => webOf[serverId])
    assert.deepEqual(picks, { wash: "product-wash", repair: UNLOADED }, "a product the store has not loaded is kept by its server id")
    const body = workOrderChargesBody(PROJECT, { ...picks, deliver: "product-delivery", swap: NO_ONE }, (webId) => serverOf[webId] ?? (webId === UNLOADED ? UNLOADED : undefined))
    assert.deepEqual(body, {
      projectId: PROJECT,
      charges: [
        { service: "deliver", productId: DELIVERY },
        { service: "repair", productId: UNLOADED },
        { service: "wash", productId: WASH },
      ],
    })
    assert.ok(WorkOrderChargesSet.safeParse(body).success)
    assert.deepEqual(workOrderChargesBody(PROJECT, { remove: "product-unknown" }, () => undefined), { path: "remove", message: "Pick a product the API holds" })
  })
})
