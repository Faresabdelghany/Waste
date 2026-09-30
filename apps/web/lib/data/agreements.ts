// Agreements and subscriptions as the web keeps them (Issue #183, slice 9a of
// #81): the `customers.agreements` module — the prototype's "Agreements and
// Subscriptions", whose two fixture records are agreements and whose
// subscriptions were a metric — becomes, on the API, the Registry's
// effective-dated pair (`@waste/contracts/agreements`): an agreement, and the
// subscriptions that hang off it, each a row of the module. The adapters
// that speak to the API are lib/api/records/agreements.ts; the generic
// workspace reads the rules here to tell the two kinds apart, to open the
// subscription form under an agreement and to edit a subscription with it.
//
// Two kinds in one module, told apart by one rule: the id's prefix first
// (`agreement-…`, `subscription-…`: a fixture's id, or what the adapters mint
// from the server's), then the kind the form stamped on a row made this
// session, before the API has answered (`recordKind`, adapter.ts `ofKind`).
//
// The agreement's form is the registry's own (business-form-schemas-customers-
// resources.ts). The subscription's is here, the module's second form: an
// agreement fixed to the row the person chose "Add subscription" on, a
// product and a place, a quantity and a period. The place is picked from its
// switched module (`customers.properties`, `customers.shared`, slice 9b); the
// product's module (`commercial.products`, slice 10) is not switched yet, so
// a subscription names it as an id chip — `product-<uuid>`, or the bare id —
// the way #126 has an unswitched link read, until that slice lands, and
// `referencedId` is the one reading of a chip.
import { ofKind } from "@/lib/api/records/adapter"

import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"

/** Where the agreements live — the one seam callers resolve the module through. */
export const AGREEMENTS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "agreements" }

/** The two kinds' id prefixes: the fixtures' own for an agreement, the adapter's for a subscription. */
export const AGREEMENT_PREFIX = "agreement"
export const SUBSCRIPTION_PREFIX = "subscription"

/** What the forms stamp on a row of each kind (`recordKind`), and what a new row is recognised by until the API has answered. */
export const AGREEMENT_RECORD_KIND = "Agreement"
export const SUBSCRIPTION_RECORD_KIND = "Subscription"

/** The id prefixes the chips of the modules not yet switched carry: the fixtures' own, so a fixture row and a chip read alike. */
export const PRODUCT_PREFIX = "product"
export const PROPERTY_PREFIX = "property"
export const SHARED_POINT_PREFIX = "shared-point"
export const PRICE_LIST_PREFIX = "price-list"

/** Whether a record of the module is a subscription: the adapters' one ownership rule — its id's prefix, else the kind the form stamped on it. */
export const isSubscriptionRecord: (record: Pick<BusinessRecord, "id" | "recordKind">) => boolean = ofKind(SUBSCRIPTION_PREFIX, [SUBSCRIPTION_RECORD_KIND])

/** Whether a record of the module is an agreement: the same rule, for the other kind. */
export const isAgreementRecord: (record: Pick<BusinessRecord, "id" | "recordKind">) => boolean = ofKind(AGREEMENT_PREFIX, [AGREEMENT_RECORD_KIND])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The API's id an id chip names: `<prefix>-<uuid>` — the web id the adapters
 * mint for an unswitched module's row — or the bare id a person pasted,
 * lowercased as the contracts spell one; undefined for anything else, a
 * fixture's id included, since the API holds no such row.
 */
export function referencedId(value: string | undefined, prefix: string): string | undefined {
  const text = value?.trim() ?? ""
  if (text === "") return undefined
  const bare = text.startsWith(`${prefix}-`) ? text.slice(prefix.length + 1) : text
  return UUID.test(bare) ? bare.toLowerCase() : undefined
}

/** The contract's one-place sentence (`SubscriptionCreate`), quoted since the contracts reach the bundle as types alone; the tests hold the two equal. */
export const ONE_PLACE = "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place"

// ---------------------------------------------------------------------------
// The agreement form on the API
// ---------------------------------------------------------------------------

/**
 * The agreement form's fields the wire has no home for: the prototype's
 * source and template, the place and the initial subscription (a subscription
 * is a row of its own on the API, added under a saved agreement), the
 * container (a placement's, Resources') and the price list, whose options
 * are the fixtures' names until #185 switches the price lists.
 */
const FIXTURE_ONLY_AGREEMENT_FIELDS: ReadonlySet<string> = new Set(["source", "agreementTemplate", "propertyId", "propertyGroupId", "sharedPointId", "productId", "priceListId", "containerId"])

/** What the section that held the initial subscription is called once only the notes remain. */
const NOTES_SECTION = "initial-service"

/**
 * The registry's agreement form as the API takes it: the fields above gone,
 * a section that lost fields losing the words that were about them, and the
 * one left holding the notes alone called so. Fixture mode keeps the
 * registry's form whole.
 */
export function agreementFormSchemaOnApi(schema: BusinessFormSchema): BusinessFormSchema {
  return {
    ...schema,
    sections: schema.sections.flatMap((section) => {
      const fields = section.fields.filter((field) => !FIXTURE_ONLY_AGREEMENT_FIELDS.has(field.id))
      if (fields.length === 0) return []
      if (fields.length === section.fields.length) return [section]
      return [{ id: section.id, title: section.id === NOTES_SECTION ? "Notes" : section.title, fields }]
    }),
  }
}

// ---------------------------------------------------------------------------
// The subscription form
// ---------------------------------------------------------------------------

/** The two kinds of place a subscription is delivered at, as the form's `placeKind` spells them. */
const PLACE_KINDS = [
  { value: "property", label: "A property" },
  { value: "shared-point", label: "A shared collection point" },
] as const

/**
 * The create form, opened from an agreement's "Add subscription": the
 * agreement read-only, since it is the row the person chose, the product as
 * the API's id until its module is switched, and the place picked.
 */
export const subscriptionFormSchema: BusinessFormSchema = {
  key: `${AGREEMENTS_MODULE.workspaceId}.${AGREEMENTS_MODULE.moduleId}`,
  mode: "create",
  recordKind: SUBSCRIPTION_RECORD_KIND,
  title: "Add subscription",
  description: "One product delivered at one place under the agreement, for a period inside the agreement's.",
  submitLabel: "Add subscription",
  contextFieldIds: ["agreementId"],
  sections: [
    {
      id: "subscription",
      title: "Subscription",
      fields: [
        { id: "agreementId", label: "Agreement", type: "select", required: true, readOnly: true, relation: AGREEMENTS_MODULE },
        { id: "productId", label: "Product", type: "text", required: true, placeholder: "The product's id on the API", description: "Only an active product can be subscribed to. Until the products are on the API here, give the product's id." },
        // One place, its kind chosen first: the other kind's picker is hidden, and a hidden field is not submitted, so a pick is taken back by choosing the other kind.
        { id: "placeKind", label: "Delivered at", type: "select", required: true, defaultValue: "property", options: PLACE_KINDS, description: "A subscription is delivered at one place: a property or a shared collection point." },
        // The places' modules by location: lib/data/properties.ts spells them, and imports this module.
        { id: "propertyId", label: "Property", type: "select", relation: { workspaceId: "customers", moduleId: "properties" }, visibleWhen: { fieldId: "placeKind", equals: "property" }, requiredWhen: { fieldId: "placeKind", equals: "property" } },
        { id: "sharedPointId", label: "Shared collection point", type: "select", relation: { workspaceId: "customers", moduleId: "shared" }, visibleWhen: { fieldId: "placeKind", equals: "shared-point" }, requiredWhen: { fieldId: "placeKind", equals: "shared-point" } },
        { id: "quantity", label: "Quantity", type: "number", min: 1, defaultValue: "1" },
        { id: "validFrom", label: "Valid from", type: "date", required: true },
        { id: "validTo", label: "Valid to", type: "date", description: "The last day in force; blank while it runs. Inside the agreement's period." },
      ],
    },
  ],
  execution: { kind: "create-record", initialStatus: "Active", completionMessage: "Subscription added." },
}

/** The place's field on the edit form: shown, not picked — a read-only picker would still be held to the rows its module offers, and an edit refused while that module is not ready. */
function shownPlace(field: BusinessFormField): BusinessFormField {
  const shown: BusinessFormField = { ...field, type: "text", readOnly: true }
  delete shown.relation
  return shown
}

/** The edit form: the create form with what the wire never patches held read-only — a subscription that moves is one that ended and another that began. */
export const subscriptionEditSchema: BusinessFormSchema = {
  ...subscriptionFormSchema,
  title: "Edit subscription",
  description: "Change the quantity or the period. The product and the place do not move: end this subscription and add another.",
  submitLabel: "Save changes",
  sections: subscriptionFormSchema.sections.map((section) => ({
    ...section,
    fields: section.fields.map((field) => {
      if (field.id === "propertyId" || field.id === "sharedPointId") return shownPlace(field)
      return ["agreementId", "productId", "placeKind"].includes(field.id) ? { ...field, readOnly: true } : field
    }),
  })),
}

/** The values a new subscription opens with: under its agreement, for the agreement's own period, since the API holds it inside that. */
export function subscriptionInitialValues(agreement: BusinessRecord): BusinessFormValues {
  const day = (key: string) => {
    const value = agreement.submittedValues?.[key]
    return typeof value === "string" && value.trim() !== "" ? value : undefined
  }
  const validFrom = day("effectiveFrom")
  const validTo = day("effectiveTo")
  return {
    agreementId: agreement.id,
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
  }
}
