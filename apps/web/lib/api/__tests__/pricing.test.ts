// The Price Engine's catalogue and prices on the adapter (#185, slice 10 of
// #81, for #148): Products over `/products`, and the Price Lists with their
// rows over `/price-lists` and each list's `/rows` — two kinds of the one
// `commercial.price-rows` module, flattened, the list a relation of the row —
// and Explain price over `GET /price-lists/:id/resolve`. The records the
// workspace writes become the bodies the contracts accept, held here against
// the contracts' own zod schemas; money is minor units on the wire and the
// form's amount in the list's currency; the writes go out through the
// store's seam over a scripted `fetch`, the API's refusals as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ContainerType, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { ProductCreate, ProductPatch, type Product } from "@waste/contracts/catalogue"
import type { Customer } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"
import { PriceListCreate, PriceListPatch, PriceListRowCreate, PriceListRowPatch, PriceResolveQuery, type PriceList, type PriceListRow, type PriceResolution } from "@waste/contracts/price-lists"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { PRICE_ROWS_MODULE, PRODUCTS_MODULE } from "../../data/commercial"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { containerTypeAdapter, serviceFrequencyAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { explainPrice, explainQuery, priceListAdapter, priceRowAdapter, priceRowsModule, productAdapter, productsModule, FREE_DAYS_REFUSAL, PRODUCT_TRANSITIONS, VAT_REFUSAL } from "../records/pricing"
import { customerAdapter } from "../records/registry"
import { loaded, loadModule, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: Parameters<typeof getModuleDefinition>[0]["workspaceId"], moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const productFixtures = fixturesOf("commercial", "products")
const rowFixtures = fixturesOf("commercial", "price-rows")

// The seeded rows as the API answers them (packages/db/src/seed), in the seed's id scheme.
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual", wasteCode: null, treatment: null, densityKgPerCubicMetre: null, hazardous: false }
const bin240: ContainerType = { id: "01a0d2a4-a280-7006-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240, serviceSeconds: null }
const fortnightly: ServiceFrequency = { id: "01a0d2a4-a280-7007-8000-000000000002", ...STAMPS, projectId: copenhagen.id, name: "Every 2 weeks", description: null, collectionsPerWeek: 1, weeksBetween: 2, daysBetween: null }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const AREA = "01a0d2a4-a280-7015-8000-000000000001"

const res240: Product = {
  id: "01a0d2a4-a280-700a-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  name: "Residual waste · 240L bin",
  kind: "container-collection",
  status: "active",
  unit: "pickup",
  containerTypeId: bin240.id,
  wasteFractionId: residual.id,
  serviceFrequencyId: fortnightly.id,
  invoiceName: "Residual waste collection 240L",
  invoiceCode: "RES-240",
  vatPercent: 25,
  freeDays: null,
}
const bulky: Product = { ...res240, id: "01a0d2a4-a280-700a-8000-000000000005", name: "Bulky waste pickup", kind: "additional-service", unit: "job", containerTypeId: null, wasteFractionId: null, serviceFrequencyId: null, invoiceName: "Bulky waste pickup", invoiceCode: "SRV-BLK" }
const xmas: Product = { ...bulky, id: "01a0d2a4-a280-700a-8000-000000000007", name: "Christmas tree collection", status: "draft", invoiceName: null, invoiceCode: null, vatPercent: null }

const plCph: PriceList = { id: "01a0d2a4-a280-7028-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "PL-Copenhagen-2026", name: "PL-Copenhagen-2026", currency: "DKK", isDefault: true, notes: "Annual tariff for Copenhagen municipal collection.", validFrom: "2026-01-01", validTo: null }
const plNext: PriceList = { ...plCph, id: "01a0d2a4-a280-7028-8000-000000000003", code: "pl-cph-2027", name: "Copenhagen 2027", isDefault: false, notes: null, validFrom: "2027-01-01", validTo: "2028-01-01" }

const rowDefault: PriceListRow = { id: "01a0d2a4-a280-7029-8000-000000000001", ...STAMPS, projectId: copenhagen.id, priceListId: plCph.id, productId: res240.id, unitPriceMinor: 1850, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId: null, customerId: null, note: null, indexedFromId: null, indexLabel: null, indexBasisPoints: null, validFrom: "2026-01-01", validTo: null }
const rowOrganisation: PriceListRow = { ...rowDefault, id: "01a0d2a4-a280-7029-8000-000000000002", unitPriceMinor: 2450, customerKind: "organisation" }
const rowOsterbro: PriceListRow = { ...rowDefault, id: "01a0d2a4-a280-7029-8000-000000000003", unitPriceMinor: 1650, customerId: osterbro.id, note: "Negotiated deal", validTo: "2027-02-03" }
const rowArea: PriceListRow = { ...rowDefault, id: "01a0d2a4-a280-7029-8000-000000000004", priceListId: plNext.id, unitPriceMinor: 1999, planningAreaId: AREA, containerTypeId: bin240.id, wasteFractionId: residual.id, validFrom: "2027-01-01" }

// What the store holds when the commercial modules load: the organisation, the master data, the customers and the planning areas.
const NO_CONTEXT = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const copenhagenRecord = projectAdapter.toRecord(copenhagen, NO_CONTEXT(fixturesOf("configure", "organization")))
const masterRecords = [
  wasteFractionAdapter.toRecord(residual, NO_CONTEXT(fixturesOf("configure", "master"))),
  containerTypeAdapter.toRecord(bin240, NO_CONTEXT(fixturesOf("configure", "master"))),
  serviceFrequencyAdapter.toRecord(fortnightly, NO_CONTEXT(fixturesOf("configure", "master"))),
]
const osterbroRecord = customerAdapter.toRecord(osterbro, NO_CONTEXT(fixturesOf("customers", "contacts")))
const areaRecord: BusinessRecord = { ...copenhagenRecord, id: `area-${AREA}`, name: "Østerbro", recordKind: "Planning area", submittedValues: {} }
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([copenhagenRecord], [copenhagen.id])],
  ["configure.master", moduleOf(masterRecords, [residual.id, bin240.id, fortnightly.id])],
  ["customers.contacts", moduleOf([osterbroRecord], [osterbro.id])],
  ["configure.areas", moduleOf([areaRecord], [AREA])],
])
const context = (fixtures: readonly BusinessRecord[], at: ServerRecordsState = state): MappingContext => ({ fixtures, resolve: resolverOver(at), companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

/** The state once the products have loaded, for the rows that name them. */
function withProducts(products: readonly Product[], base: ServerRecordsState = state): ServerRecordsState {
  const records = products.map((product) => productAdapter.toRecord(product, context(productFixtures, base)))
  return new Map([...base, ["commercial.products", moduleOf(records, products.map((product) => product.id))]])
}
const productsState = withProducts([res240, bulky, xmas])

/** The state once the price rows module has loaded its lists and rows. */
function withPriceRows(lists: readonly PriceList[], rows: readonly PriceListRow[], base: ServerRecordsState = productsState): ServerRecordsState {
  const listRecords = lists.map((list) => priceListAdapter.toRecord(list, context(rowFixtures, base)))
  const listed = new Map([...base, ["commercial.price-rows", moduleOf(listRecords, lists.map((list) => list.id))]])
  const rowRecords = rows.map((row) => priceRowAdapter.toRecord(row, context(rowFixtures, listed)))
  return new Map([...base, ["commercial.price-rows", moduleOf([...listRecords, ...rowRecords], [...lists.map((list) => list.id), ...rows.map((row) => row.id)])]])
}
const pricedState = withPriceRows([plCph, plNext], [rowDefault, rowOrganisation, rowOsterbro, rowArea])

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** A record a Pilot form makes before the API has answered: the generic create path's id shape and the form's kind. */
function made(id: string, recordKind: string, values: Record<string, string | boolean>, status = "Draft"): BusinessRecord {
  return { id, name: String(values.productName ?? values.name ?? id), context: "", status, owner: "", value: "", updated: "Now", description: "", facts: {}, related: [], source: "Waste API", freshness: "Now", companyId: FIXTURE_COMPANY_ID, projectIds: ["project-copenhagen"], recordKind, submittedValues: values }
}

const PRODUCT_FORM = {
  projectId: "project-copenhagen",
  productName: "Garden waste · 140L bin",
  productType: "container-collection",
  priceUnit: "pickup",
  containerType: `container-type-${bin240.id}`,
  wasteFraction: `fraction-${residual.id}`,
  serviceFrequencyId: `frequency-${fortnightly.id}`,
  invoiceName: "Garden waste collection 140L",
  invoiceCode: "GRD-140",
  vatPercent: "25",
}

describe("the products module", () => {
  test("is switched, after the organisation and the master data a product names", () => {
    assert.ok(isServerBacked("commercial", "products"))
    for (const before of ["configure.organization", "configure.master"]) assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.products") > SERVER_MODULE_KEYS.indexOf(before), before)
    assert.deepEqual(productsModule.resources, [productAdapter])
    assert.deepEqual([productsModule.workspaceId, productsModule.moduleId], [PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId])
  })

  test("shows a product as the catalogue reads it: its type and unit, its master data by name, its VAT and invoice fields, under its own uuid", () => {
    const record = productAdapter.toRecord(res240, context(productFixtures))
    assert.equal(record.id, `product-${res240.id}`, "rule (b): no fixture lends its id")
    assert.equal(record.name, "Residual waste · 240L bin")
    assert.equal(record.context, "Container collection · /pickup")
    assert.equal(record.status, "Active")
    assert.deepEqual(record.allowedTransitions, ["Inactive"])
    assert.deepEqual(record.projectIds, ["project-copenhagen"])
    assert.equal(record.recordKind, "Product")
    assert.deepEqual(record.facts, {
      Type: "Container collection",
      Unit: "pickup",
      "Container type": "Two-wheel bin · 240 L",
      "Waste fraction": "Residual",
      "Service frequency": "Every 2 weeks",
      VAT: "25%",
      "Invoice name": "Residual waste collection 240L",
      "Invoice code": "RES-240",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(record.submittedValues, {
      projectId: "project-copenhagen",
      productName: "Residual waste · 240L bin",
      productType: "container-collection",
      priceUnit: "pickup",
      containerType: `container-type-${bin240.id}`,
      wasteFraction: `fraction-${residual.id}`,
      serviceFrequencyId: `frequency-${fortnightly.id}`,
      invoiceName: "Residual waste collection 240L",
      invoiceCode: "RES-240",
      vatPercent: "25",
    })
  })

  test("lists each product with its default price — its project's default list's row with no condition, in force today — or Unpriced", async () => {
    const { fetch, calls } = scripted([() => pageOf([res240, bulky]), () => pageOf([plCph]), () => pageOf([rowDefault, rowOrganisation, rowOsterbro])])
    const result = await loadModule(clientOver(fetch), productsModule, { fixtures: productFixtures, state, now: NOW })
    assert.equal(calls[0].url, "http://api.test/products?limit=200")
    assert.match(calls[1].url, /^http:\/\/api\.test\/price-lists\?limit=200&isDefault=true&validOn=\d{4}-\d{2}-\d{2}$/, "the default list in force today")
    assert.match(calls[2].url, new RegExp(`^http://api\\.test/price-lists/${plCph.id}/rows\\?limit=200&validOn=\\d{4}-\\d{2}-\\d{2}$`))
    assert.deepEqual(
      result.records.map((record) => record.value),
      ["DKK 18.50/pickup", "Unpriced"],
    )
  })

  test("loads the products for a role that does not view the price lists, the default price then read from the rows the store holds", async () => {
    // `/price-lists` is granted under commercial.price-rows: its refusal must not take the catalogue with it.
    const { fetch } = scripted([() => pageOf([res240, bulky]), () => problem(403, "Your role does not allow view on commercial.price-rows")])
    const result = await loadModule(clientOver(fetch), productsModule, { fixtures: productFixtures, state: pricedState, now: NOW })
    assert.deepEqual(
      result.records.map((record) => [record.name, record.value]),
      [
        ["Residual waste · 240L bin", "DKK 18.50/pickup"],
        ["Bulky waste pickup", "Unpriced"],
      ],
    )
  })

  test("reads a product written later at its default price from the rows the store holds", () => {
    assert.equal(productAdapter.toRecord(res240, context(productFixtures, pricedState)).value, "DKK 18.50/pickup")
    assert.equal(productAdapter.toRecord(bulky, context(productFixtures, pricedState)).value, "Unpriced")
  })

  test("says a product without a VAT rate has none, since its events block on it, and names an unloaded master row by its id chip", () => {
    const record = productAdapter.toRecord(xmas, context(productFixtures))
    assert.equal(record.facts.VAT, "Not set: its events block until it has one")
    assert.equal(record.status, "Draft")
    assert.deepEqual(record.allowedTransitions, ["Active"])
    assert.equal(record.submittedValues?.vatPercent, undefined)
    const chipped = productAdapter.toRecord(res240, context(productFixtures, new Map([["configure.organization", state.get("configure.organization")!]])))
    assert.equal(chipped.facts["Waste fraction"], `fraction-${residual.id}`)
  })

  test("offers the transitions the wire's three statuses take, and the store spells each", () => {
    assert.deepEqual(PRODUCT_TRANSITIONS, { draft: ["Active"], active: ["Inactive"], inactive: ["Active"] })
    const record = productAdapter.toRecord(res240, context(productFixtures))
    for (const status of ["Draft", "Active", "Inactive"]) assert.ok(spellsStatus(productsModule, record, status), status)
    assert.ok(!spellsStatus(productsModule, record, "Archived"))
  })

  test("makes the create body the contract accepts from the Pilot's product form, names resolved to server ids", () => {
    const body = productAdapter.toCreateBody!(made("products-product-1700000000000", "Product", PRODUCT_FORM, "Active"), context(productFixtures))
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Garden waste · 140L bin",
      kind: "container-collection",
      status: "active",
      unit: "pickup",
      containerTypeId: bin240.id,
      wasteFractionId: residual.id,
      serviceFrequencyId: fortnightly.id,
      invoiceName: "Garden waste collection 140L",
      invoiceCode: "GRD-140",
      vatPercent: 25,
    })
    assert.ok(ProductCreate.safeParse(body).success)
    const bare = productAdapter.toCreateBody!(made("products-product-1", "Product", { projectId: "project-copenhagen", productName: "Extra lid", productType: "additional-service", priceUnit: "job" }), context(productFixtures))
    assert.deepEqual(bare, { projectId: copenhagen.id, name: "Extra lid", kind: "additional-service", status: "draft", unit: "job" })
    assert.ok(ProductCreate.safeParse(bare).success)
  })

  test("refuses a create the API would, at the field: no project, no type, no unit, a VAT rate that is no whole percent, a master row it does not hold", () => {
    const refusalOf = (values: Record<string, string>) => productAdapter.toCreateBody!(made("products-product-1", "Product", { ...PRODUCT_FORM, ...values }), context(productFixtures))
    // A record made outside any scope, the form's project left blank.
    assert.deepEqual(productAdapter.toCreateBody!({ ...made("products-product-1", "Product", { ...PRODUCT_FORM, projectId: "" }), projectIds: [] }, context(productFixtures)), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(refusalOf({ productType: "" }), { path: "productType", message: "Pick a type" })
    assert.deepEqual(refusalOf({ priceUnit: "litre" }), { path: "priceUnit", message: "Pick a unit" })
    for (const vat of ["101", "12.5", "-1", "a"]) assert.deepEqual(refusalOf({ vatPercent: vat }), { path: "vatPercent", message: VAT_REFUSAL }, vat)
    assert.deepEqual(refusalOf({ wasteFraction: "fraction-paper" }), { path: "wasteFraction", message: "Pick a waste fraction the API holds" })
  })

  test("patches only what moved — a cleared field as null — and refuses a product moved to another project", () => {
    const before = productAdapter.toRecord(res240, context(productFixtures))
    const after = { ...before, status: "Inactive", submittedValues: { ...before.submittedValues, invoiceCode: "", vatPercent: "0", serviceFrequencyId: "" } }
    const body = productAdapter.toPatchBody(before, after, context(productFixtures))
    assert.deepEqual(body, { status: "inactive", serviceFrequencyId: null, invoiceCode: null, vatPercent: 0 })
    assert.ok(ProductPatch.safeParse(body).success)
    assert.equal(productAdapter.toPatchBody(before, { ...before }, context(productFixtures)), null)
    assert.deepEqual(productAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, projectId: "project-harbor" } }, context(productFixtures)), { path: "projectId", message: "A product stays in its project" })
  })

  test("gives a hire product its free days (M14 of #293): read back as a fact, sent on a create and a patch, refused at the field, and none under any other unit", () => {
    const hire: Product = { ...bulky, id: "01a0d2a4-a280-700a-8000-000000000009", name: "Skip hire", kind: "additional-service", unit: "day", freeDays: 7 }
    const before = productAdapter.toRecord(hire, context(productFixtures))
    assert.equal(before.facts["Free days"], "7 days")
    assert.equal(before.submittedValues?.freeDays, "7")
    assert.equal(productAdapter.toRecord(bulky, context(productFixtures)).facts["Free days"], undefined, "a product with none says nothing")
    const longer = productAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, freeDays: "14" } }, context(productFixtures))
    assert.deepEqual(longer, { freeDays: 14 })
    assert.ok(ProductPatch.safeParse(longer).success)
    assert.deepEqual(productAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, freeDays: "" } }, context(productFixtures)), { freeDays: null })
    assert.deepEqual(productAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, priceUnit: "job" } }, context(productFixtures)), { unit: "job", freeDays: null }, "a product sold by the job again has none")
    for (const days of ["367", "1.5", "-1", "a"]) assert.deepEqual(productAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, freeDays: days } }, context(productFixtures)), { path: "freeDays", message: FREE_DAYS_REFUSAL }, days)
    const created = productAdapter.toCreateBody!(made("products-product-1", "Product", { projectId: "project-copenhagen", productName: "Skip hire", productType: "additional-service", priceUnit: "day", freeDays: "7" }), context(productFixtures))
    assert.deepEqual(created, { projectId: copenhagen.id, name: "Skip hire", kind: "additional-service", status: "draft", unit: "day", freeDays: 7 })
    assert.ok(ProductCreate.safeParse(created).success)
    const hidden = productAdapter.toCreateBody!(made("products-product-1", "Product", { projectId: "project-copenhagen", productName: "Extra lid", productType: "additional-service", priceUnit: "job", freeDays: "7" }), context(productFixtures))
    assert.equal((hidden as { freeDays?: number }).freeDays, undefined, "the field the form hid is not sent")
  })

  test("writes a product through the store's seam, and tells the API's refusal in its own words", async () => {
    const created: Product = { ...res240, id: "01a0d2a4-a280-700a-8000-000000000099", name: "Garden waste · 140L bin" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/products/${created.id}` }), () => problem(409, "A product with invoice code GRD-140 already exists in this project")])
    const current = productsState.get("commercial.products")!
    const outcome = await writeRecord(clientOver(fetch), productsModule, current, made("products-product-1700000000000", "Product", PRODUCT_FORM, "Active"), { fixtures: productFixtures, state: productsState, now: NOW })
    assert.equal(outcome.kind, "created")
    assert.equal(calls[0].url, "http://api.test/products")
    assert.equal(calls[0].init.method, "POST")
    assert.ok(ProductCreate.safeParse(bodyOf(calls[0])).success)
    const refused = await writeRecord(clientOver(fetch), productsModule, current, made("products-product-1700000000001", "Product", PRODUCT_FORM, "Active"), { fixtures: productFixtures, state: productsState, now: NOW })
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") assert.equal(problemSentence(refused.problem), "A product with invoice code GRD-140 already exists in this project")
  })
})

describe("the price rows module: the lists and their rows", () => {
  test("is switched after the products, the master data, the customers and the planning areas its rows name, the lists before the rows", () => {
    assert.ok(isServerBacked("commercial", "price-rows"))
    for (const before of ["commercial.products", "configure.master", "customers.contacts", "configure.areas"]) assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.price-rows") > SERVER_MODULE_KEYS.indexOf(before), before)
    assert.deepEqual(priceRowsModule.resources, [priceListAdapter, priceRowAdapter])
    assert.deepEqual([priceRowsModule.workspaceId, priceRowsModule.moduleId], [PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId])
  })

  test("reads the lists, then every list's rows, and flattens them into one module (the pilot's fan-out)", async () => {
    const { fetch, calls } = scripted([
      () => pageOf([plCph, plNext]),
      () => pageOf([plCph, plNext]),
      ({ url }) => pageOf(url.includes(plCph.id) ? [rowDefault, rowOrganisation, rowOsterbro] : [rowArea]),
      ({ url }) => pageOf(url.includes(plCph.id) ? [rowDefault, rowOrganisation, rowOsterbro] : [rowArea]),
    ])
    const result = await loadModule(clientOver(fetch), priceRowsModule, { fixtures: rowFixtures, state: productsState, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), [
      "http://api.test/price-lists?limit=200",
      "http://api.test/price-lists?limit=200",
      `http://api.test/price-lists/${plCph.id}/rows?limit=200`,
      `http://api.test/price-lists/${plNext.id}/rows?limit=200`,
    ])
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`price-list-${plCph.id}`, `price-list-${plNext.id}`, ...[rowDefault, rowOrganisation, rowOsterbro, rowArea].map((row) => `price-row-${row.id}`)],
    )
  })

  test("shows a list as Settings › Commercial reads it: code, currency, default flag and period, its status a reading of the period", () => {
    const current = priceListAdapter.toRecord(plCph, context(rowFixtures, productsState))
    assert.equal(current.id, `price-list-${plCph.id}`, "no still-fixture reader names a price list by its fixture id")
    assert.equal(current.name, "PL-Copenhagen-2026")
    assert.equal(current.status, "Active")
    assert.equal(current.recordKind, "Price list")
    assert.deepEqual(current.submittedValues, { projectId: "project-copenhagen", code: "PL-Copenhagen-2026", name: "PL-Copenhagen-2026", currency: "DKK", isDefault: true, notes: "Annual tariff for Copenhagen municipal collection.", validFrom: "2026-01-01" })
    const next = priceListAdapter.toRecord(plNext, context(rowFixtures, productsState))
    assert.equal(next.status, "Scheduled")
    assert.equal(next.submittedValues?.validTo, "2027-12-31", "the form's last day in force; the wire's validTo is the first day out")
    assert.equal(next.facts.Default, "No")
  })

  test("shows a row with its list, its product and its conditions by name, the amount in the list's currency per the product's unit", () => {
    const negotiated = priceRowAdapter.toRecord(rowOsterbro, context(rowFixtures, pricedState))
    assert.equal(negotiated.id, `price-row-${rowOsterbro.id}`)
    assert.equal(negotiated.name, "Østerbro Housing (negotiated)")
    assert.equal(negotiated.context, "Residual waste · 240L bin")
    assert.equal(negotiated.value, "DKK 16.50/pickup")
    assert.equal(negotiated.status, "Active")
    assert.equal(negotiated.recordKind, "Price row")
    assert.equal(negotiated.facts["Price list"], "PL-Copenhagen-2026")
    assert.equal(negotiated.facts["Negotiated customer"], "Østerbro Housing")
    assert.equal(negotiated.facts["Effective to"], "2027-02-02")
    assert.deepEqual(negotiated.submittedValues, {
      priceListId: `price-list-${plCph.id}`,
      productId: `product-${res240.id}`,
      amount: "16.50",
      customerId: osterbroRecord.id,
      note: "Negotiated deal",
      validFrom: "2026-01-01",
      validTo: "2027-02-02",
    })
    assert.equal(priceRowAdapter.toRecord(rowDefault, context(rowFixtures, pricedState)).name, "Everyone")
    assert.equal(priceRowAdapter.toRecord(rowDefault, context(rowFixtures, pricedState)).facts.Indexed, undefined, "a row typed in names no index")
    const indexed = priceRowAdapter.toRecord({ ...rowDefault, id: "01a0d2a4-a280-7029-8000-000000000009", indexedFromId: rowDefault.id, indexLabel: "CPI 2027", indexBasisPoints: 320, validFrom: "2027-01-01" }, context(rowFixtures, pricedState))
    assert.equal(indexed.facts.Indexed, "CPI 2027 +3.2% from 2027-01-01", "an indexed row names its index and its first day (#291 C8)")
    assert.equal(priceRowAdapter.toRecord(rowOrganisation, context(rowFixtures, pricedState)).facts["Customer type"], "Organisation")
    const area = priceRowAdapter.toRecord(rowArea, context(rowFixtures, pricedState))
    assert.equal(area.name, "Østerbro · Two-wheel bin · 240 L · Residual")
    assert.equal(area.status, "Scheduled")
    assert.deepEqual(area.submittedValues?.planningAreaId, `area-${AREA}`)
  })

  test("makes a list's create body: the code a slug, the period's end the first day out", () => {
    const record = made("price-rows-price-list-1", "Price list", { projectId: "project-copenhagen", code: "PL-CPH-2028", name: "Copenhagen 2028", currency: "DKK", isDefault: false, notes: "Next year's tariff", validFrom: "2028-01-01", validTo: "2028-12-31" })
    const body = priceListAdapter.toCreateBody!(record, context(rowFixtures, pricedState))
    assert.deepEqual(body, { projectId: copenhagen.id, code: "pl-cph-2028", name: "Copenhagen 2028", currency: "DKK", isDefault: false, notes: "Next year's tariff", validFrom: "2028-01-01", validTo: "2029-01-01" })
    assert.ok(PriceListCreate.safeParse(body).success)
    assert.deepEqual(priceListAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, code: "PL CPH/2028" } }, context(rowFixtures, pricedState)), { path: "code", message: "A code is letters, digits and single hyphens, such as PL-CPH-2027" })
  })

  test("patches a list's name, flag, notes and period, and refuses a code or a currency moved, which its rows are quoted in", () => {
    const before = priceListAdapter.toRecord(plNext, context(rowFixtures, pricedState))
    const after = { ...before, submittedValues: { ...before.submittedValues, isDefault: true, validTo: "", notes: "Takes over in 2027" } }
    const body = priceListAdapter.toPatchBody(before, after, context(rowFixtures, pricedState))
    assert.deepEqual(body, { isDefault: true, notes: "Takes over in 2027", validTo: null })
    assert.ok(PriceListPatch.safeParse(body).success)
    assert.deepEqual(priceListAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, code: "pl-cph-2029" } }, context(rowFixtures, pricedState)), { path: "code", message: "A list keeps its code and its currency: its rows are quoted in them" })
    assert.deepEqual(priceListAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, currency: "EUR" } }, context(rowFixtures, pricedState)), { path: "currency", message: "A list keeps its code and its currency: its rows are quoted in them" })
  })

  test("makes a row's create body under the chosen list, the amount in the list's minor units and each condition by server id", () => {
    const record = made("price-rows-price-row-1", "Price row", {
      priceListId: `price-list-${plCph.id}`,
      productId: `product-${bulky.id}`,
      amount: "45,00",
      planningAreaId: `area-${AREA}`,
      customerKind: "organisation",
      containerType: "",
      wasteFraction: `fraction-${residual.id}`,
      customerId: "",
      note: "Commercial bulky",
      validFrom: "2026-10-01",
      validTo: "2026-12-31",
    })
    const body = priceRowAdapter.toCreateBody!(record, context(rowFixtures, pricedState)) as { priceListId: string; body: unknown }
    assert.equal(body.priceListId, plCph.id)
    assert.deepEqual(body.body, { productId: bulky.id, unitPriceMinor: 4500, planningAreaId: AREA, customerKind: "organisation", wasteFractionId: residual.id, note: "Commercial bulky", validFrom: "2026-10-01", validTo: "2027-01-01" })
    assert.ok(PriceListRowCreate.safeParse(body.body).success)
    const refusalOf = (values: Record<string, string>) => priceRowAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, ...values } }, context(rowFixtures, pricedState))
    assert.deepEqual(refusalOf({ priceListId: "PL-Copenhagen-2026" }), { path: "priceListId", message: "Pick a price list the API holds" })
    assert.deepEqual(refusalOf({ productId: "product-bulky" }), { path: "productId", message: "Pick a product the API holds" })
    assert.deepEqual(refusalOf({ amount: "45.005" }), { path: "amount", message: "An amount in DKK, such as 18.50" })
    assert.deepEqual(refusalOf({ customerKind: "municipal" }), { path: "customerKind", message: "Pick a person or an organisation" })
  })

  test("patches a row's price, note and end only, and refuses a condition or its start moved: end it and add another", () => {
    const before = priceRowAdapter.toRecord(rowOsterbro, context(rowFixtures, pricedState))
    const after = { ...before, submittedValues: { ...before.submittedValues, amount: "17.25", note: "", validTo: "" } }
    const body = priceRowAdapter.toPatchBody(before, after, context(rowFixtures, pricedState))
    assert.deepEqual(body, { unitPriceMinor: 1725, note: null, validTo: null })
    assert.ok(PriceListRowPatch.safeParse(body).success)
    const ended = "A row keeps its list, its product, its conditions and its start: end it and add another"
    for (const [key, value] of [["customerId", ""], ["validFrom", "2026-02-01"], ["productId", `product-${bulky.id}`], ["customerKind", "person"]] as const) {
      assert.deepEqual(priceRowAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, [key]: value } }, context(rowFixtures, pricedState)), { path: key, message: ended }, key)
    }
  })

  test("writes a row under its list and patches it at its own route", async () => {
    const created: PriceListRow = { ...rowDefault, id: "01a0d2a4-a280-7029-8000-000000000099", productId: bulky.id, unitPriceMinor: 4500 }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/price-list-rows/${created.id}` }), () => json({ ...created, unitPriceMinor: 4700 })])
    const current = pricedState.get("commercial.price-rows")!
    const record = made("price-rows-price-row-1", "Price row", { priceListId: `price-list-${plCph.id}`, productId: `product-${bulky.id}`, amount: "45.00", validFrom: "2026-10-01" })
    const outcome = await writeRecord(clientOver(fetch), priceRowsModule, current, record, { fixtures: rowFixtures, state: pricedState, now: NOW })
    assert.equal(calls[0].url, `http://api.test/price-lists/${plCph.id}/rows`)
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    const withCreated = { ...current, records: [outcome.record, ...current.records], serverIds: new Map([...current.serverIds, [outcome.record.id, created.id]]) }
    const repriced = { ...outcome.record, submittedValues: { ...outcome.record.submittedValues, amount: "47.00" } }
    const patched = await writeRecord(clientOver(fetch), priceRowsModule, withCreated, repriced, { fixtures: rowFixtures, state: pricedState, now: NOW })
    assert.equal(patched.kind, "updated")
    assert.equal(calls[1].url, `http://api.test/price-list-rows/${created.id}`)
    assert.equal(calls[1].init.method, "PATCH")
    assert.deepEqual(bodyOf(calls[1]), { unitPriceMinor: 4700 })
  })

  test("refuses every status move of a row or a list: their status is a reading of the period", () => {
    const row = priceRowAdapter.toRecord(rowDefault, context(rowFixtures, pricedState))
    const list = priceListAdapter.toRecord(plCph, context(rowFixtures, pricedState))
    for (const record of [row, list]) for (const status of ["Scheduled", "Active", "Expired"]) assert.ok(!spellsStatus(priceRowsModule, record, status))
  })
})

describe("Explain price", () => {
  const resolution: PriceResolution = {
    verdicts: [
      { row: rowOsterbro, eligible: true, reason: null, matched: ["Customer Østerbro Housing"], score: 100, winner: true },
      { row: rowDefault, eligible: true, reason: null, matched: [], score: 0, winner: false },
      { row: rowOrganisation, eligible: false, reason: "Customer type is organisation, not person", matched: [], score: -1, winner: false },
    ],
    winner: { row: rowOsterbro, eligible: true, reason: null, matched: ["Customer Østerbro Housing"], score: 100, winner: true },
    unitPriceMinor: 1650,
    vatPercent: 25,
    currency: "DKK",
  }

  test("asks the list's resolve read with the product, the day and only the conditions given, by server id", async () => {
    const asked = explainQuery({ priceListId: `price-list-${plCph.id}`, productId: `product-${res240.id}`, on: "2026-10-01", customerId: osterbroRecord.id, customerKind: "", planningAreaId: "", containerType: "", wasteFraction: `fraction-${residual.id}` }, resolverOver(pricedState))
    assert.deepEqual(asked, { priceListId: plCph.id, query: { productId: res240.id, on: "2026-10-01", wasteFractionId: residual.id, customerId: osterbro.id } })
    if ("query" in asked) assert.ok(PriceResolveQuery.safeParse(asked.query).success)
    const { fetch, calls } = scripted([() => json(resolution)])
    if (!("query" in asked)) throw new Error("refused")
    const answer = await explainPrice(clientOver(fetch), asked.priceListId, asked.query)
    assert.equal(calls[0].url, `http://api.test/price-lists/${plCph.id}/resolve?productId=${res240.id}&on=2026-10-01&wasteFractionId=${residual.id}&customerId=${osterbro.id}`)
    assert.equal(answer.winner?.row.id, rowOsterbro.id)
  })

  test("refuses a question with no list, no product or no day before the API sees it", () => {
    const resolve = resolverOver(pricedState)
    assert.deepEqual(explainQuery({ priceListId: "", productId: `product-${res240.id}`, on: "2026-10-01" }, resolve), { path: "priceListId", message: "Pick a price list the API holds" })
    assert.deepEqual(explainQuery({ priceListId: `price-list-${plCph.id}`, productId: "", on: "2026-10-01" }, resolve), { path: "productId", message: "Pick a product the API holds" })
    assert.deepEqual(explainQuery({ priceListId: `price-list-${plCph.id}`, productId: `product-${res240.id}`, on: "" }, resolve), { path: "on", message: "Pick the day the price is asked for" })
  })
})
