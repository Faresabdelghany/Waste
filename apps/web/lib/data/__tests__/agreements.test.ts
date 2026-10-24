// The agreements module's own rules (#183, slice 9a of #81): which kind a
// record is, the id chip a field names an unswitched module's row with, the
// subscription form the workspace opens under an agreement, and the pickers
// its product and the agreement's price list are chosen from (#291).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SubscriptionCreate } from "@waste/contracts/agreements"

import {
  agreementFormSchemaOnApi,
  agreementPriceListOptions,
  AGREEMENTS_MODULE,
  isAgreementRecord,
  isSubscriptionRecord,
  ONE_PLACE,
  PROJECT_DEFAULT_LIST,
  referencedId,
  SUBSCRIPTION_RECORD_KIND,
  subscriptionEditSchema,
  subscriptionFormSchema,
  subscriptionFormSchemaFor,
  subscriptionInitialValues,
  subscriptionProductOptions,
} from "../agreements"
import { getBusinessFormSchema } from "../business-form-schemas"
import { getModuleDefinition, type BusinessRecord } from "../business-modules"
import { PRICE_ROWS_MODULE, PRODUCTS_MODULE } from "../commercial"

const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"

describe("the agreements module", () => {
  test("is one seam: customers.agreements, whose create form is the registry's own", () => {
    assert.deepEqual(AGREEMENTS_MODULE, { workspaceId: "customers", moduleId: "agreements" })
    assert.ok(getModuleDefinition(AGREEMENTS_MODULE))
    assert.equal(getBusinessFormSchema(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)?.recordKind, "Agreement")
  })

  test("a record's kind is its id prefix first, then the kind the form stamped on a row made this session", () => {
    assert.ok(isAgreementRecord({ id: "agreement-2408" }))
    assert.ok(isAgreementRecord({ id: "agreements-agreement-1700000000000", recordKind: "Agreement" }))
    assert.ok(!isAgreementRecord({ id: "subscription-01a0d2a4-a280-7013-8000-000000000001" }))
    assert.ok(!isAgreementRecord({ id: "agreements-subscription-1700000000000", recordKind: SUBSCRIPTION_RECORD_KIND }))
    assert.ok(isSubscriptionRecord({ id: "subscription-01a0d2a4-a280-7013-8000-000000000001" }))
    assert.ok(isSubscriptionRecord({ id: "agreements-subscription-1700000000000", recordKind: SUBSCRIPTION_RECORD_KIND }))
    assert.ok(!isSubscriptionRecord({ id: "agreement-2408", recordKind: "Agreement" }))
    assert.ok(!isSubscriptionRecord({ id: "contact-mikkel" }))
  })

  test("an id chip names the API's row: the kind's prefix before the id, or the bare id, lowercased; anything else names nothing", () => {
    assert.equal(referencedId(`product-${PRODUCT}`, "product"), PRODUCT)
    assert.equal(referencedId(PRODUCT.toUpperCase(), "product"), PRODUCT)
    assert.equal(referencedId(` product-${PRODUCT} `, "product"), PRODUCT, "the form's text is trimmed")
    assert.equal(referencedId("product-res-240", "product"), undefined, "a fixture's id names no row on the API")
    assert.equal(referencedId(`property-${PRODUCT}`, "product"), undefined, "another kind's chip is not this one's")
    assert.equal(referencedId(undefined, "product"), undefined)
    assert.equal(referencedId("", "product"), undefined)
  })

  test("the subscription form is the module's own: its agreement fixed, its product and its place picked from their switched modules, its period and quantity", () => {
    const schema = subscriptionFormSchema
    assert.equal(schema.key, "customers.agreements")
    assert.equal(schema.recordKind, SUBSCRIPTION_RECORD_KIND)
    assert.equal(schema.mode, "create")
    assert.equal(schema.nameField, undefined, "a subscription is named by the adapter, from its agreement and product")
    assert.equal(schema.execution?.kind, "create-record")
    const fields = schema.sections.flatMap((section) => section.fields)
    assert.deepEqual(
      fields.map((field) => field.id),
      ["agreementId", "productId", "placeKind", "propertyId", "sharedPointId", "quantity", "validFrom", "validTo"],
    )
    const byId = new Map(fields.map((field) => [field.id, field]))
    assert.deepEqual(byId.get("agreementId")?.relation, AGREEMENTS_MODULE)
    assert.equal(byId.get("agreementId")?.readOnly, true, "the agreement is the row the person chose Add subscription on")
    assert.equal(byId.get("agreementId")?.required, true)
    assert.equal(byId.get("productId")?.type, "select")
    assert.deepEqual(byId.get("productId")?.relation, PRODUCTS_MODULE, "a picker over the switched products (#185), never a typed id (#291)")
    assert.equal(byId.get("productId")?.required, true)
    assert.equal(byId.get("productId")?.placeholder, undefined)
    // One place, chosen first: the picker of the other kind is hidden, and a hidden field is not submitted, so a pick can be taken back (#184).
    assert.deepEqual(byId.get("placeKind")?.options?.map((option) => option.value), ["property", "shared-point"])
    assert.equal(byId.get("placeKind")?.defaultValue, "property")
    assert.equal(byId.get("propertyId")?.type, "select")
    assert.deepEqual(byId.get("propertyId")?.relation, { workspaceId: "customers", moduleId: "properties" }, "a picker over the switched properties (#184)")
    assert.deepEqual(byId.get("propertyId")?.visibleWhen, { fieldId: "placeKind", equals: "property" })
    assert.deepEqual(byId.get("propertyId")?.requiredWhen, { fieldId: "placeKind", equals: "property" })
    assert.equal(byId.get("sharedPointId")?.type, "select")
    assert.deepEqual(byId.get("sharedPointId")?.relation, { workspaceId: "customers", moduleId: "shared" })
    assert.deepEqual(byId.get("sharedPointId")?.visibleWhen, { fieldId: "placeKind", equals: "shared-point" })
    assert.equal(byId.get("quantity")?.type, "number")
    assert.equal(byId.get("quantity")?.min, 1)
    assert.equal(byId.get("quantity")?.defaultValue, "1")
    assert.equal(byId.get("validFrom")?.type, "date")
    assert.equal(byId.get("validFrom")?.required, true)
    assert.equal(byId.get("validTo")?.type, "date")
    assert.equal(byId.get("validTo")?.required, undefined)
  })

  test("the edit form holds the agreement, the product and the place read-only, the product and the place by name: what moves is the quantity and the period", () => {
    const schema = subscriptionEditSchema
    assert.equal(schema.title, "Edit subscription")
    assert.equal(schema.submitLabel, "Save changes")
    const fields = schema.sections.flatMap((section) => section.fields)
    const readOnly = fields.filter((field) => field.readOnly).map((field) => field.id)
    assert.deepEqual(readOnly, ["agreementId", "productName", "placeKind", "propertyName", "sharedPointName"])
    assert.deepEqual(
      fields.filter((field) => !field.readOnly).map((field) => field.id),
      ["quantity", "validFrom", "validTo"],
    )
    // The product and the place are shown, not picked: a read-only picker would be held to the rows its module offers, and an edit refused while that module is not ready.
    const byId = new Map(fields.map((field) => [field.id, field]))
    for (const [id, label] of [["productName", "Product"], ["propertyName", "Property"], ["sharedPointName", "Shared collection point"]] as const) {
      assert.equal(byId.get(id)?.type, "text", id)
      assert.equal(byId.get(id)?.label, label, id)
      assert.equal(byId.get(id)?.relation, undefined, id)
      assert.equal(byId.get(id)?.required, undefined, id)
    }
    assert.deepEqual(byId.get("propertyName")?.visibleWhen, { fieldId: "placeKind", equals: "property" })
    assert.deepEqual(byId.get("sharedPointName")?.visibleWhen, { fieldId: "placeKind", equals: "shared-point" })
  })

  test("a new subscription opens under its agreement, in the agreement's project, for the agreement's own period", () => {
    const agreement = {
      id: "agreement-2408",
      projectIds: ["project-copenhagen"],
      submittedValues: { agreementNumber: "AGR-2408", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" },
    } as unknown as BusinessRecord
    // The project is the agreement's, so the pickers offer that project's products and places alone: a row of another project is one the API refuses.
    assert.deepEqual(subscriptionInitialValues(agreement), { agreementId: "agreement-2408", projectId: "project-copenhagen", validFrom: "2026-01-01", validTo: "2026-12-31" })
    const open = { ...agreement, submittedValues: { agreementNumber: "AGR-2188", effectiveFrom: "2026-01-01" } } as unknown as BusinessRecord
    assert.deepEqual(subscriptionInitialValues(open), { agreementId: "agreement-2408", projectId: "project-copenhagen", validFrom: "2026-01-01" })
    const unscoped = { ...open, projectIds: undefined } as unknown as BusinessRecord
    assert.deepEqual(subscriptionInitialValues(unscoped), { agreementId: "agreement-2408", validFrom: "2026-01-01" })
  })

  test("on the API the agreement form keeps the fields the wire takes and loses the ones it does not, its initial-subscription section the price list's and the notes'", () => {
    const registry = getBusinessFormSchema(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)
    if (!registry) throw new Error("no agreement form")
    const onApi = agreementFormSchemaOnApi(registry)
    const ids = onApi.sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(ids, ["projectId", "agreementNumber", "customerId", "payerId", "effectiveFrom", "effectiveTo", "billingCadence", "currency", "priceListId", "internalNotes"])
    assert.deepEqual(onApi.sections.map((section) => section.id), ["scope-source", "identity-parties", "effective-period", "initial-service"], "a section that keeps a field stays, in order")
    assert.equal(onApi.nameField, registry.nameField)
    assert.equal(onApi.key, registry.key)
    assert.deepEqual(onApi.contextFieldIds, registry.contextFieldIds)
    assert.ok(!onApi.sections.some((section) => section.description?.includes("At least one Property")), "the fixture rule about the place goes with its fields")
    assert.equal(onApi.sections[3]?.title, "Price list and notes", "the section that held the initial subscription keeps the price list and the notes")
    assert.equal(onApi.sections[3]?.description, undefined, "the initial subscription's words go with it")
    assert.equal(onApi.sections[0]?.description, registry.sections[0]?.description, "a section that kept every field keeps its words")
    // The price list is the API's (#291): a picker over the lists of `commercial.price-rows`, opening on the project's default list, never the fixtures' names.
    const priceList = onApi.sections.flatMap((section) => section.fields).find((field) => field.id === "priceListId")
    assert.equal(priceList?.type, "select")
    assert.deepEqual(priceList?.relation, PRICE_ROWS_MODULE)
    assert.equal(priceList?.options, undefined)
    assert.equal(priceList?.required, undefined)
    assert.equal(priceList?.defaultValue, PROJECT_DEFAULT_LIST)
    // The registry's own form is untouched: fixture mode keeps every field, its price list the fixtures' names.
    assert.ok(registry.sections.flatMap((section) => section.fields).some((field) => field.id === "productId"))
    assert.ok(registry.sections.flatMap((section) => section.fields).find((field) => field.id === "priceListId")?.options?.length)
  })

  test("an agreement's price list is one of its project's lists in its currency, the project's default list first; a list's status rides beside its name where it is not Active", () => {
    const list = (id: string, name: string, project: string, currency: string, status = "Active") =>
      ({ id, name, status, projectIds: [project], recordKind: "Price list", submittedValues: { currency } }) as unknown as BusinessRecord
    const row = { id: "price-row-1", name: "Residual · 240L", status: "Active", projectIds: ["project-copenhagen"], recordKind: "Price row", submittedValues: {} } as unknown as BusinessRecord
    const records = [
      list("price-list-cph", "Copenhagen tariff 2026", "project-copenhagen", "DKK"),
      list("price-list-cph-eur", "Copenhagen EUR", "project-copenhagen", "EUR"),
      list("price-list-cph-2025", "Copenhagen tariff 2025", "project-copenhagen", "DKK", "Expired"),
      list("price-list-harbor", "Harbor tariff 2026", "project-harbor", "DKK"),
      row,
    ]
    assert.deepEqual(agreementPriceListOptions(records, { projectId: "project-copenhagen", currency: "DKK" }), [
      { value: PROJECT_DEFAULT_LIST, label: "The project's default list" },
      { value: "price-list-cph", label: "Copenhagen tariff 2026" },
      { value: "price-list-cph-2025", label: "Copenhagen tariff 2025 · Expired" },
    ])
    assert.deepEqual(
      agreementPriceListOptions(records, { projectId: "project-copenhagen", currency: "EUR" }).map((option) => option.value),
      [PROJECT_DEFAULT_LIST, "price-list-cph-eur"],
      "another currency, another list: the API refuses a list in a currency the agreement is not billed in",
    )
    assert.deepEqual(agreementPriceListOptions(records, {}).map((option) => option.value), [PROJECT_DEFAULT_LIST], "no list until the project is picked")
    // The list an agreement already names stays offered where the store holds no such list — a role that reads no price lists edits its agreements all the same — named by its id chip, as the agreement's fact is.
    assert.deepEqual(agreementPriceListOptions([], { projectId: "project-copenhagen", currency: "DKK", priceListId: "price-list-01a0d2a4" }), [
      { value: PROJECT_DEFAULT_LIST, label: "The project's default list" },
      { value: "price-list-01a0d2a4", label: "price-list-01a0d2a4" },
    ])
    assert.equal(agreementPriceListOptions(records, { projectId: "project-copenhagen", currency: "DKK", priceListId: "price-list-cph" }).length, 3, "a list offered once")
  })

  test("a subscription's product is one of its agreement's project's, its status beside its name where it is not Active", () => {
    const product = (id: string, name: string, project: string, status = "Active") => ({ id, name, status, projectIds: [project] }) as unknown as BusinessRecord
    const records = [
      product("product-res-240", "Residual waste · 240L", "project-copenhagen"),
      product("product-bulky", "Bulky pickup", "project-copenhagen", "Draft"),
      product("product-harbor", "Cardboard · 660L", "project-harbor"),
    ]
    assert.deepEqual(subscriptionProductOptions(records, { projectId: "project-copenhagen" }), [
      { value: "product-res-240", label: "Residual waste · 240L" },
      // #79: a status gates a new reference and the API's 409 says so; the picker shows it coming rather than hiding the row.
      { value: "product-bulky", label: "Bulky pickup · Draft" },
    ])
    assert.deepEqual(subscriptionProductOptions(records, {}).map((option) => option.value), ["product-res-240", "product-bulky", "product-harbor"], "every project's, where the agreement names none")
  })

  test("a role that reads no products gives the product by its id: the picker would offer nothing to pick", () => {
    assert.equal(subscriptionFormSchemaFor(true), subscriptionFormSchema)
    const byId = subscriptionFormSchemaFor(false)
    const fields = byId.sections.flatMap((section) => section.fields)
    assert.deepEqual(fields.map((field) => field.id), subscriptionFormSchema.sections.flatMap((section) => section.fields).map((field) => field.id), "the same form")
    const product = fields.find((field) => field.id === "productId")
    assert.equal(product?.type, "text")
    assert.equal(product?.relation, undefined)
    assert.equal(product?.required, true)
    assert.equal(product?.placeholder, "The product's id on the API")
    assert.equal(product?.description, "Your role reads no products here: give the product's id. Only an active product can be subscribed to.")
  })

  test("the one-place sentence is the contract's own", () => {
    const parsed = SubscriptionCreate.safeParse({ productId: PRODUCT, quantity: 1, validFrom: "2026-10-01" })
    assert.ok(!parsed.success)
    assert.equal(parsed.error.issues[0]?.message, ONE_PLACE)
  })
})
