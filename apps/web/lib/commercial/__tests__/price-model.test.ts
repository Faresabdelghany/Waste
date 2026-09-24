// The Products & Prices harness (issue #22): the record ⇄ model converters
// round-trip, a soft-deleted row is invisible to every pricing read, the
// history and indexation codecs survive " · " inside a label, a percent is
// signed once, a price row's status and context are derived from the row
// and not from the form's lifecycle or context fields, a product delete
// takes its rows with it, the product's pricing sentence is derived beside
// its pricing facts, and the forms' field labels are the fact keys the
// generic write path stores under.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { softDeletedRecord, type SoftDeletion } from "@waste/domain/record-visibility"

import { getBusinessFormSchema } from "../../data/business-form-schemas"
import { getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import {
  applyIndexToRate,
  decodeHistory,
  decodeIndexation,
  encodeHistory,
  encodeIndexation,
  normalizePriceRowRecord,
  priceRowStatus,
  priceRowToRecord,
  pricingSentence,
  PRICING_REFERENCE_DATE,
  PRODUCT_FACTS,
  recordToPriceRow,
  recordToServiceProviderPrice,
  RESOLUTION_RULE,
  ROW_FACTS,
  signedPercent,
  softDeletedPriceRowsOf,
  syncProductPricingFacts,
  type PriceRowModel,
  type ServiceProviderPriceModel,
} from "../price-model"

// Module-scope reads throw at load, which fails the file loudly (a throw in
// a describe body would not).
const requireModule = (moduleId: string) => {
  const module = getModuleDefinition({ workspaceId: "commercial", moduleId })
  if (!module) throw new Error(`no commercial.${moduleId} module`)
  return module
}
const products = requireModule("products")
const priceRows = requireModule("price-rows")
const fixtureProducts = products.records
const fixtureRowRecords = priceRows.records
const fixtureRows = fixtureRowRecords
  .map(recordToPriceRow)
  .filter((row): row is PriceRowModel => row !== null)

const productById = new Map(fixtureProducts.map((product) => [product.id, product]))
const requireProduct = (productId: string) => {
  const product = productById.get(productId)
  if (!product) throw new Error(`no fixture product ${productId}`)
  return product
}
const productOf = (row: PriceRowModel) => requireProduct(row.productId)
const residual = requireProduct("product-res-240")

const withoutFact = (record: BusinessRecord, key: string): BusinessRecord => {
  const facts = { ...record.facts }
  delete facts[key]
  return { ...record, facts }
}

const deletion: SoftDeletion = {
  reason: "Product retired",
  actorName: "Mette Holm",
  deletionLogId: "audit-1",
}

const rowsOfRecords = (records: readonly BusinessRecord[]) =>
  records.map(recordToPriceRow).filter((row): row is PriceRowModel => row !== null)

describe("recordToPriceRow ⇄ priceRowToRecord", () => {
  test("every fixture price row reads as a live row", () => {
    assert.equal(fixtureRows.length, fixtureRowRecords.length)
  })

  test("every fixture row survives the round trip unchanged", () => {
    for (const row of fixtureRows) {
      const product = productOf(row)
      assert.deepEqual(
        recordToPriceRow(priceRowToRecord(row, { id: product.id, name: product.name })),
        row,
        row.id,
      )
    }
  })

  test("a row carrying every field survives the round trip unchanged", () => {
    const row: PriceRowModel = {
      id: "price-row-full",
      productId: "product-res-240",
      amount: 18.5,
      unit: "pickup",
      conditions: {
        zone: "Harbor",
        customerType: "Commercial",
        containerType: "660L container",
        wasteFraction: "Glass",
      },
      negotiatedCustomer: "Nørrebro CoWork ApS",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      scheduled: { newAmount: 19.06, from: "2026-07-01", revertOn: "2026-09-01", note: "Summer +3%" },
      tag: "PL-Harbor-2026",
    }
    assert.deepEqual(
      recordToPriceRow(priceRowToRecord(row, { id: "product-res-240", name: "Residual waste · 240L bin" })),
      row,
    )
  })

  test("a record is written under the fact keys the model spells", () => {
    const row = fixtureRows.find((candidate) => candidate.id === "price-row-res-default")
    assert.ok(row)
    const record = priceRowToRecord(row, { id: "product-res-240", name: "Residual waste · 240L bin" })
    assert.equal(record.context, "Residual waste · 240L bin")
    assert.equal(record.facts[ROW_FACTS.amount], "18.50")
    assert.equal(record.facts[ROW_FACTS.scheduledFrom], "2027-01-01")
    assert.equal(record.status, "Active")
  })
})

describe("soft-deleted rows and the product-fact sync", () => {
  const product = residual
  const rowRecordsOf = (productId: string) =>
    fixtureRowRecords.filter(
      (record) => record.relationRefs?.some((ref) => ref.recordId === productId) ?? false,
    )

  test("a soft-deleted row reads as no row at all", () => {
    const [record] = rowRecordsOf("product-res-240")
    assert.notEqual(recordToPriceRow(record), null)
    assert.equal(recordToPriceRow(softDeletedRecord(record, deletion)), null)
  })

  test("the fixture product's facts already say what its rows say", () => {
    const synced = syncProductPricingFacts(product, fixtureRows)
    assert.equal(synced.facts[PRODUCT_FACTS.variations], "5")
    assert.equal(synced.facts[PRODUCT_FACTS.customer], "Østerbro Housing Association")
    assert.equal(synced.facts[PRODUCT_FACTS.priceList], "PL-Copenhagen-2026")
    assert.equal(synced.value, "€18.50/pickup")
  })

  test("soft-deleting the negotiated row drops it from Variations and Customer", () => {
    const records = rowRecordsOf("product-res-240").map((record) =>
      record.id === "price-row-res-osterbro" ? softDeletedRecord(record, deletion) : record,
    )
    const synced = syncProductPricingFacts(product, rowsOfRecords(records))
    assert.equal(synced.facts[PRODUCT_FACTS.variations], "4")
    assert.equal(synced.facts[PRODUCT_FACTS.customer], undefined)
    assert.equal(synced.value, "€18.50/pickup")
  })

  test("soft-deleting the default row unprices the product and drops its price list", () => {
    const records = rowRecordsOf("product-res-240").map((record) =>
      record.id === "price-row-res-default" ? softDeletedRecord(record, deletion) : record,
    )
    const synced = syncProductPricingFacts(product, rowsOfRecords(records))
    assert.equal(synced.value, "Unpriced")
    assert.equal(synced.facts[PRODUCT_FACTS.priceList], undefined)
    // Five rows remain and none is the default, so all five are variations.
    assert.equal(synced.facts[PRODUCT_FACTS.variations], "5")
  })

  test("soft-deleting every row leaves no derived pricing fact behind", () => {
    const records = rowRecordsOf("product-res-240").map((record) => softDeletedRecord(record, deletion))
    const synced = syncProductPricingFacts(product, rowsOfRecords(records))
    assert.equal(synced.value, "Unpriced")
    assert.equal(synced.facts[PRODUCT_FACTS.variations], undefined)
    assert.equal(synced.facts[PRODUCT_FACTS.customer], undefined)
    assert.equal(synced.facts[PRODUCT_FACTS.priceList], undefined)
  })
})

describe("the fixture products and their rows", () => {
  for (const product of fixtureProducts) {
    test(`${product.id} carries the facts, value and pricing sentence its rows derive`, () => {
      const synced = syncProductPricingFacts(product, fixtureRows)
      assert.equal(synced.value, product.value)
      assert.equal(synced.description, product.description)
      for (const key of [PRODUCT_FACTS.priceList, PRODUCT_FACTS.variations, PRODUCT_FACTS.customer]) {
        assert.equal(synced.facts[key], product.facts[key], key)
      }
    })
  }
})

describe("the pricing sentence of a product's description", () => {
  const defaultRow: PriceRowModel = {
    id: "row-default",
    productId: "product-x",
    amount: 10,
    unit: "job",
    conditions: {},
    effectiveFrom: "2026-01-01",
  }
  const variation: PriceRowModel = { ...defaultRow, id: "row-zone", conditions: { zone: "Harbor" } }
  const negotiated: PriceRowModel = {
    ...defaultRow,
    id: "row-deal",
    negotiatedCustomer: "Nørrebro CoWork ApS",
  }

  test("spells the default row's standing and counts the variations", () => {
    assert.equal(pricingSentence([]), "Unpriced — add its price in Price Engine with Add price.")
    assert.equal(pricingSentence([defaultRow]), "Default price applies to everyone; no variations.")
    assert.equal(
      pricingSentence([defaultRow, variation]),
      "Default price applies to everyone; 1 variation.",
    )
    assert.equal(
      pricingSentence([defaultRow, variation, negotiated]),
      "Default price applies to everyone; 2 variations including 1 negotiated deal.",
    )
    assert.equal(pricingSentence([variation]), "No default price; 1 variation.")
    assert.equal(
      pricingSentence([{ ...defaultRow, effectiveFrom: "2027-01-02" }]),
      "Default price takes effect 2027-01-02; no variations.",
    )
    assert.equal(
      pricingSentence([{ ...defaultRow, effectiveTo: "2026-06-30" }]),
      "Default price expired 2026-06-30; no variations.",
    )
  })

  test("the sync replaces the pricing sentence and keeps the product's own", () => {
    const product: BusinessRecord = {
      ...residual,
      id: "product-x",
      description: "Residual collection with a rented 240L bin. Default price applies to everyone; 5 variations including 1 negotiated deal.",
    }
    const synced = syncProductPricingFacts(product, [defaultRow, variation])
    assert.equal(
      synced.description,
      "Residual collection with a rented 240L bin. Default price applies to everyone; 1 variation.",
    )
  })

  test("a product created in Settings loses its Unpriced sentence once it is priced", () => {
    const product: BusinessRecord = {
      ...residual,
      id: "product-x",
      description:
        "Additional service product created in Settings. Unpriced until Add price creates its default row in Price Engine.",
    }
    const synced = syncProductPricingFacts(product, [defaultRow])
    assert.equal(
      synced.description,
      "Additional service product created in Settings. Default price applies to everyone; no variations.",
    )
    const unpriced = syncProductPricingFacts(synced, [])
    assert.equal(
      unpriced.description,
      "Additional service product created in Settings. Unpriced — add its price in Price Engine with Add price.",
    )
  })

  test("a description with no pricing sentence gains one", () => {
    const product: BusinessRecord = { ...residual, id: "product-x", description: "" }
    assert.equal(
      syncProductPricingFacts(product, [defaultRow]).description,
      "Default price applies to everyone; no variations.",
    )
  })
})

describe("signedPercent", () => {
  test("writes the sign once", () => {
    assert.equal(signedPercent(5), "+5%")
    assert.equal(signedPercent(-2), "-2%")
    assert.equal(signedPercent(0), "0%")
    assert.equal(signedPercent(2.5), "+2.5%")
  })

  test("an index run notes a negative percent without a stray plus", () => {
    const rate: ServiceProviderPriceModel = {
      id: "rate-1",
      serviceProvider: "NordRen ApS",
      productId: "product-res-240",
      productName: "Residual waste · 240L bin",
      serviceArea: "CA-Ø-2",
      bid: 10,
      currentFee: 10,
      unit: "pickup",
      validFrom: "2026-01-01",
      validUntil: "2027-12-31",
      components: [],
      indexation: [],
    }
    const indexed = applyIndexToRate(rate, { label: "Fuel", percent: -2, from: "2026-09-01", base: "bid" })
    assert.equal(indexed.currentFee, 9.8)
    assert.equal(indexed.lastIndexNote, "Fuel -2%")
    assert.equal(indexed.indexation[0]?.note, "Fuel -2%")
  })
})

describe("the history and indexation codecs", () => {
  test("history keeps a ' · ' inside what happened", () => {
    const entry = { at: "2026-06-15", who: "Mette Holm", what: "Price change scheduled · +3% for 1 Jan 2027" }
    assert.deepEqual(decodeHistory([encodeHistory(entry), "Deletion log audit-1"]), [entry])
  })

  test("indexation keeps a ' · ' inside the index label", () => {
    const entry: ServiceProviderPriceModel["indexation"][number] = {
      at: "2026-03-01",
      note: "CPI · Denmark +5%",
      from: 11.2,
      to: 11.76,
      base: "bid",
    }
    assert.deepEqual(decodeIndexation([encodeIndexation(entry)]), [entry])
  })

  test("indexation still reads the seeded fixture entries", () => {
    assert.deepEqual(decodeIndexation(["Indexed · 2026-03-01 · CPI +5% · €11.20 → €11.76 · base: bid"]), [
      { at: "2026-03-01", note: "CPI +5%", from: 11.2, to: 11.76, base: "bid" },
    ])
    assert.deepEqual(
      decodeIndexation(["Indexed · 2026-06-01 · Fuel +3% · €11.76 → €12.11 · base: current fee"]),
      [{ at: "2026-06-01", note: "Fuel +3%", from: 11.76, to: 12.11, base: "current fee" }],
    )
  })

  test("a fixture service provider price decodes its indexation history", () => {
    const rates = requireModule("service-provider-prices").records
    const indexed = rates.map(recordToServiceProviderPrice).filter((rate) => rate.indexation.length > 0)
    assert.ok(indexed.length > 0)
    for (const rate of indexed) {
      for (const entry of rate.indexation) {
        assert.match(entry.at, /^\d{4}-\d{2}-\d{2}$/)
        assert.ok(entry.note.length > 0)
        assert.ok(entry.from > 0 && entry.to > 0)
      }
    }
  })
})

describe("priceRowStatus", () => {
  const row: PriceRowModel = {
    id: "row",
    productId: "product-x",
    amount: 1,
    unit: "job",
    conditions: {},
    effectiveFrom: "2026-01-01",
  }

  test("is Scheduled before effective-from, Expired after effective-to, else Active", () => {
    assert.equal(priceRowStatus({ ...row, effectiveFrom: "2027-01-02" }), "Scheduled")
    assert.equal(priceRowStatus({ ...row, effectiveTo: "2026-06-30" }), "Expired")
    assert.equal(priceRowStatus(row), "Active")
    assert.equal(priceRowStatus({ ...row, effectiveTo: PRICING_REFERENCE_DATE }), "Active")
    assert.equal(priceRowStatus(row, "2025-12-31"), "Scheduled")
  })
})

describe("normalizePriceRowRecord", () => {
  // What the generic create path hands over: the lifecycle's first state as
  // status, the context fields joined, the Unit fact as the option's label.
  const created: BusinessRecord = {
    id: "price-rows-price-row-1",
    name: "Price row · 1",
    context: "Residual waste · 240L bin · 18.5 · 2026-01-01",
    status: "Scheduled",
    owner: "Mette Holm",
    value: "Add price",
    updated: "Now",
    description: "Price a product from the Settings catalogue.",
    facts: {
      Product: "Residual waste · 240L bin",
      [ROW_FACTS.amount]: "18.5",
      [ROW_FACTS.unit]: "€ per pickup",
      [ROW_FACTS.effectiveFrom]: "2026-01-01",
      [ROW_FACTS.zone]: "Harbor",
    },
    related: [],
    source: "Office workspace",
    freshness: "Now",
    recordKind: "Price row",
    relationRefs: [
      {
        fieldId: "productId",
        workspaceId: "commercial",
        moduleId: "products",
        recordId: "product-res-240",
        label: "Residual waste · 240L bin",
      },
    ],
  }

  test("derives status, context, name and value from the row", () => {
    const normalized = normalizePriceRowRecord(created, { unit: "pickup" })
    assert.equal(normalized.status, "Active")
    assert.equal(normalized.context, "Residual waste · 240L bin")
    assert.equal(normalized.name, "Harbor")
    assert.equal(normalized.value, "€18.50/pickup")
    assert.equal(normalized.facts[ROW_FACTS.unit], "pickup")
  })

  test("a row effective in the future is Scheduled, an ended one Expired", () => {
    const scheduled = normalizePriceRowRecord(
      { ...created, facts: { ...created.facts, [ROW_FACTS.effectiveFrom]: "2027-01-02" } },
      { unit: "pickup" },
    )
    assert.equal(scheduled.status, "Scheduled")
    const expired = normalizePriceRowRecord(
      { ...created, facts: { ...created.facts, [ROW_FACTS.effectiveTo]: "2026-06-30" } },
      { unit: "pickup" },
    )
    assert.equal(expired.status, "Expired")
  })

  test("an edit that cleared every condition reads as the default row again", () => {
    const normalized = normalizePriceRowRecord(withoutFact(created, ROW_FACTS.zone), { unit: "pickup" })
    assert.equal(normalized.name, "Everyone")
  })

  test("a record that is not a price row is returned as it came", () => {
    const notARow = withoutFact(created, ROW_FACTS.amount)
    assert.deepEqual(normalizePriceRowRecord(notARow, { unit: "pickup" }), {
      ...notARow,
      facts: { ...notARow.facts, [ROW_FACTS.unit]: "pickup" },
    })
  })
})

describe("softDeletedPriceRowsOf", () => {
  test("marks every live row of the product and no other", () => {
    const cascaded = softDeletedPriceRowsOf(fixtureRowRecords, "product-res-240", deletion)
    assert.deepEqual(
      cascaded.map((record) => record.id).sort(),
      [
        "price-row-res-centre",
        "price-row-res-centre-com",
        "price-row-res-com",
        "price-row-res-default",
        "price-row-res-north",
        "price-row-res-osterbro",
      ],
    )
    for (const record of cascaded) {
      assert.equal(recordToPriceRow(record), null)
      assert.equal(record.facts["Deletion reason"], deletion.reason)
      assert.equal(record.facts["Deleted by"], deletion.actorName)
      assert.equal(record.related[0], `Deletion log ${deletion.deletionLogId}`)
    }
  })

  test("a row already soft-deleted is left alone", () => {
    const records = fixtureRowRecords.map((record) =>
      record.id === "price-row-res-north" ? softDeletedRecord(record, deletion) : record,
    )
    const cascaded = softDeletedPriceRowsOf(records, "product-res-240", deletion)
    assert.equal(cascaded.length, 5)
    assert.ok(!cascaded.some((record) => record.id === "price-row-res-north"))
  })

  test("a product with no rows cascades nothing", () => {
    assert.deepEqual(softDeletedPriceRowsOf(fixtureRowRecords, "product-nobody", deletion), [])
  })
})

describe("the forms write under the model's fact keys", () => {
  // The generic write path stores each field under its label, so a label
  // that drifts from the fact key the model reads is a fact the model never
  // sees. These are the fields that are facts; the name, status and the
  // linked product are stored elsewhere on the record.
  const productFields: Record<string, keyof typeof PRODUCT_FACTS> = {
    productType: "type",
    priceUnit: "unit",
    container: "container",
    containerType: "containerType",
    wasteFraction: "wasteFraction",
    serviceLevels: "serviceLevels",
  }
  const rowFields: Record<string, keyof typeof ROW_FACTS> = {
    amount: "amount",
    unit: "unit",
    tag: "tag",
    zone: "zone",
    customerType: "customerType",
    containerType: "containerType",
    wasteFraction: "wasteFraction",
    negotiatedCustomer: "negotiatedCustomer",
    effectiveFrom: "effectiveFrom",
    effectiveTo: "effectiveTo",
    scheduledAmount: "scheduledAmount",
    scheduledFrom: "scheduledFrom",
    scheduledRevertOn: "scheduledRevertOn",
  }
  const labelsOf = (workspaceId: "commercial", moduleId: string) => {
    const schema = getBusinessFormSchema(workspaceId, moduleId)
    assert.ok(schema, `${workspaceId}.${moduleId} has no form schema`)
    return new Map(schema.sections.flatMap((section) => section.fields.map((field) => [field.id, field.label])))
  }

  test("the products form", () => {
    const labels = labelsOf("commercial", "products")
    for (const [fieldId, fact] of Object.entries(productFields)) {
      assert.equal(labels.get(fieldId), PRODUCT_FACTS[fact], fieldId)
    }
  })

  test("the price-rows form", () => {
    const labels = labelsOf("commercial", "price-rows")
    for (const [fieldId, fact] of Object.entries(rowFields)) {
      assert.equal(labels.get(fieldId), ROW_FACTS[fact], fieldId)
    }
  })
})

describe("RESOLUTION_RULE", () => {
  test("is the sentence the two pricing modules and the Add price form state", () => {
    assert.ok(products.rules.includes(RESOLUTION_RULE))
    assert.ok(priceRows.rules.includes(RESOLUTION_RULE))
    const schema = getBusinessFormSchema("commercial", "price-rows")
    assert.ok(schema?.description.includes(RESOLUTION_RULE))
  })
})
