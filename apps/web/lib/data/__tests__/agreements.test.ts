// The agreements module's own rules (#183, slice 9a of #81): which kind a
// record is, the id chip a field names an unswitched module's row with, and
// the subscription form the workspace opens under an agreement.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SubscriptionCreate } from "@waste/contracts/agreements"

import {
  agreementFormSchemaOnApi,
  AGREEMENTS_MODULE,
  isAgreementRecord,
  isSubscriptionRecord,
  ONE_PLACE,
  referencedId,
  SUBSCRIPTION_RECORD_KIND,
  subscriptionEditSchema,
  subscriptionFormSchema,
  subscriptionInitialValues,
} from "../agreements"
import { getBusinessFormSchema } from "../business-form-schemas"
import { getModuleDefinition, type BusinessRecord } from "../business-modules"

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

  test("the subscription form is the module's own: its agreement fixed, its product an id chip until its module is switched, its place picked from the places' modules, its period and quantity", () => {
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
    assert.equal(byId.get("productId")?.type, "text")
    assert.equal(byId.get("productId")?.required, true)
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

  test("the edit form holds the agreement, the product and the place read-only: what moves is the quantity and the period", () => {
    const schema = subscriptionEditSchema
    assert.equal(schema.title, "Edit subscription")
    assert.equal(schema.submitLabel, "Save changes")
    const fields = schema.sections.flatMap((section) => section.fields)
    const readOnly = fields.filter((field) => field.readOnly).map((field) => field.id)
    assert.deepEqual(readOnly, ["agreementId", "productId", "placeKind", "propertyId", "sharedPointId"])
    assert.deepEqual(
      fields.filter((field) => !field.readOnly).map((field) => field.id),
      ["quantity", "validFrom", "validTo"],
    )
    // The place is shown, not picked: a read-only picker would be held to the rows its module offers, and an edit refused while that module is not ready.
    for (const id of ["propertyId", "sharedPointId"]) {
      const field = fields.find((candidate) => candidate.id === id)
      assert.equal(field?.type, "text", id)
      assert.equal(field?.relation, undefined, id)
    }
  })

  test("a new subscription opens under its agreement, for the agreement's own period", () => {
    const agreement = {
      id: "agreement-2408",
      submittedValues: { agreementNumber: "AGR-2408", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" },
    } as unknown as BusinessRecord
    assert.deepEqual(subscriptionInitialValues(agreement), { agreementId: "agreement-2408", validFrom: "2026-01-01", validTo: "2026-12-31" })
    const open = { ...agreement, submittedValues: { agreementNumber: "AGR-2188", effectiveFrom: "2026-01-01" } } as unknown as BusinessRecord
    assert.deepEqual(subscriptionInitialValues(open), { agreementId: "agreement-2408", validFrom: "2026-01-01" })
  })

  test("on the API the agreement form keeps the fields the wire takes and loses the ones it does not, its initial-subscription section with them", () => {
    const registry = getBusinessFormSchema(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)
    if (!registry) throw new Error("no agreement form")
    const onApi = agreementFormSchemaOnApi(registry)
    const ids = onApi.sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(ids, ["projectId", "agreementNumber", "customerId", "payerId", "effectiveFrom", "effectiveTo", "billingCadence", "currency", "internalNotes"])
    assert.deepEqual(onApi.sections.map((section) => section.id), ["scope-source", "identity-parties", "effective-period", "initial-service"], "a section that keeps a field stays, in order")
    assert.equal(onApi.nameField, registry.nameField)
    assert.equal(onApi.key, registry.key)
    assert.deepEqual(onApi.contextFieldIds, registry.contextFieldIds)
    assert.ok(!onApi.sections.some((section) => section.description?.includes("At least one Property")), "the fixture rule about the place goes with its fields")
    assert.equal(onApi.sections[3]?.title, "Notes", "the section that held the initial subscription is the notes' alone")
    assert.equal(onApi.sections[0]?.description, registry.sections[0]?.description, "a section that kept every field keeps its words")
    // The registry's own form is untouched: fixture mode keeps every field.
    assert.ok(registry.sections.flatMap((section) => section.fields).some((field) => field.id === "productId"))
  })

  test("the one-place sentence is the contract's own", () => {
    const parsed = SubscriptionCreate.safeParse({ productId: PRODUCT, quantity: 1, validFrom: "2026-10-01" })
    assert.ok(!parsed.success)
    assert.equal(parsed.error.issues[0]?.message, ONE_PLACE)
  })
})
