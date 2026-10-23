// What the Price Engine's pickers offer (#185): every row of the module a
// field names, its status beside its name — but only the project's, once the
// dialog names the project through its list or its agreement, since each
// project has a catalogue of its own under the same names.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { commercialRowsFor } from "../commercial-pickers"

const row = (id: string, name: string, projectId: string, extra: Partial<BusinessRecord> = {}): BusinessRecord =>
  ({ id, name, status: "Active", projectIds: [projectId], facts: {}, submittedValues: {}, ...extra }) as BusinessRecord

const rows = {
  products: [row("product-1", "Residual waste · 240L bin", "project-copenhagen"), row("product-2", "Residual waste · 240L bin", "project-harbor"), row("product-3", "Christmas tree collection", "project-copenhagen", { status: "Draft" })],
  priceRows: [row("price-list-1", "PL-Copenhagen-2026", "project-copenhagen", { recordKind: "Price list" }), row("price-list-2", "PL-Harbor-2026", "project-harbor", { recordKind: "Price list" }), row("price-row-1", "Everyone", "project-copenhagen", { recordKind: "Price row" })],
  areas: [row("area-1", "Østerbro", "project-copenhagen"), row("area-2", "Nordhavn", "project-harbor")],
  agreements: [row("agreement-2408", "AGR-2408 · Østerbro Housing", "project-copenhagen", { recordKind: "Agreement" }), row("subscription-1", "AGR-2408 · Residual", "project-copenhagen", { recordKind: "Subscription" })],
}
const ids = (records: readonly BusinessRecord[] | undefined) => records?.map((record) => record.id)

describe("the Price Engine's pickers", () => {
  test("offer the lists of the price rows module and the agreements of the agreements module, never their other kind", () => {
    assert.deepEqual(ids(commercialRowsFor("priceListId", {}, rows)), ["price-list-1", "price-list-2"])
    assert.deepEqual(ids(commercialRowsFor("agreementId", {}, rows)), ["agreement-2408"])
  })

  test("offer every product and area while the dialog names no project, a draft product among them", () => {
    assert.deepEqual(ids(commercialRowsFor("productId", {}, rows)), ["product-1", "product-2", "product-3"])
    assert.deepEqual(ids(commercialRowsFor("planningAreaId", {}, rows)), ["area-1", "area-2"])
  })

  test("offer the project's products and areas once the dialog names its list, its agreement or its project", () => {
    assert.deepEqual(ids(commercialRowsFor("productId", { priceListId: "price-list-2" }, rows)), ["product-2"])
    assert.deepEqual(ids(commercialRowsFor("planningAreaId", { priceListId: "price-list-1" }, rows)), ["area-1"])
    assert.deepEqual(ids(commercialRowsFor("productId", { agreementId: "agreement-2408" }, rows)), ["product-1", "product-3"])
    assert.deepEqual(ids(commercialRowsFor("productId", { projectId: "project-harbor" }, rows)), ["product-2"])
    assert.deepEqual(ids(commercialRowsFor("productId", {}, rows, "project-harbor")), ["product-2"], "the surface's own project, a row's")
  })

  test("leave every other field to the command surfaces' own pickers", () => {
    assert.equal(commercialRowsFor("customerId", {}, rows), undefined)
    assert.equal(commercialRowsFor("projectId", {}, rows), undefined)
  })
})
