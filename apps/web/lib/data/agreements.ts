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
// resources.ts), trimmed on the API to what the wire takes, its price list
// picked from the lists of `commercial.price-rows` in the agreement's
// project and currency (#291). The subscription's is here, the module's
// second form: an agreement fixed to the row the person chose "Add
// subscription" on, a product and a place, a quantity and a period, each
// picked from its switched module (`commercial.products`, slice 10;
// `customers.properties`, `customers.shared`, slice 9b) among the rows of the
// agreement's project. A row the store does not hold is still named by an id
// chip — `product-<uuid>`, or the bare id — and `referencedId` is the one
// reading of a chip.
import { ofKind } from "@/lib/api/records/adapter"

import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormSection, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { isPriceListRecord, PRICE_ROWS_MODULE, PRODUCTS_MODULE } from "./commercial"

/** Where the agreements live — the one seam callers resolve the module through. */
export const AGREEMENTS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "agreements" }

/** The two kinds' id prefixes: the fixtures' own for an agreement, the adapter's for a subscription. */
export const AGREEMENT_PREFIX = "agreement"
export const SUBSCRIPTION_PREFIX = "subscription"

/** What the forms stamp on a row of each kind (`recordKind`), and what a new row is recognised by until the API has answered. */
export const AGREEMENT_RECORD_KIND = "Agreement"
export const SUBSCRIPTION_RECORD_KIND = "Subscription"

/** The id prefixes a row of another module carries, and its chip while the store does not hold it: the fixtures' own, so a fixture row and a chip read alike. */
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
 * is a row of its own on the API, added under a saved agreement) and the
 * container (a placement's, Resources').
 */
const FIXTURE_ONLY_AGREEMENT_FIELDS: ReadonlySet<string> = new Set(["source", "agreementTemplate", "propertyId", "propertyGroupId", "sharedPointId", "productId", "containerId"])

/** What the section that held the initial subscription is called once the price list and the notes alone remain. */
const NOTES_SECTION = "initial-service"

/** The price list option that is no list at all: the wire's null, the project's default list (#291). A select is never emptied once picked, so the default is a pick of its own. */
export const PROJECT_DEFAULT_LIST = "project-default"

/** The agreement's price list on the API (#291): one of the lists of `commercial.price-rows`, where the fixture form tags the fixtures' names. */
const PRICE_LIST_ON_API: BusinessFormField = {
  id: "priceListId",
  label: "Price list",
  type: "select",
  relation: PRICE_ROWS_MODULE,
  defaultValue: PROJECT_DEFAULT_LIST,
  description: "The list the agreement's work is priced under: one of the project's, in the agreement's currency.",
}

/** The window the agreement promises its stops are served in (O14 of #290), the API's alone. */
const SERVICE_WINDOW_SECTION: BusinessFormSection = {
  id: "service-window",
  title: "Service window",
  description: "When in the day the agreement's stops are served. Route optimisation keeps each stop inside it and its property's access hours. Blank both for any time.",
  fields: [
    { id: "serviceWindowStart", label: "Served from", type: "time" },
    { id: "serviceWindowEnd", label: "Served until", type: "time" },
  ],
}

/**
 * The registry's agreement form as the API takes it: the fields above gone,
 * the price list the API's, a section that lost fields losing the words that
 * were about them, and the one left holding the price list and the notes
 * called so, then the service window (O14 of #290). Fixture mode keeps the
 * registry's form whole.
 */
export function agreementFormSchemaOnApi(schema: BusinessFormSchema): BusinessFormSchema {
  return {
    ...schema,
    sections: [
      ...schema.sections.flatMap((section) => {
        const fields = section.fields.filter((field) => !FIXTURE_ONLY_AGREEMENT_FIELDS.has(field.id)).map((field) => (field.id === PRICE_LIST_ON_API.id ? PRICE_LIST_ON_API : field))
        if (fields.length === 0) return []
        if (fields.length === section.fields.length) return [{ ...section, fields }]
        return [{ id: section.id, title: section.id === NOTES_SECTION ? "Price list and notes" : section.title, fields }]
      }),
      SERVICE_WINDOW_SECTION,
    ],
  }
}

/** A row's name as a picker offers it: its status beside it where it is not Active (#79: a status gates a new reference, and the API's 409 says so). */
const optionOf = (record: BusinessRecord): BusinessFormOption => ({ value: record.id, label: record.status === "Active" ? record.name : `${record.name} · ${record.status}` })

const valueOf = (values: BusinessFormValues, key: string) => (typeof values[key] === "string" && values[key] !== "" ? (values[key] as string) : undefined)

/**
 * The price lists an agreement may be priced under, from the rows of
 * `commercial.price-rows`: the lists alone, of the project the form names, in
 * the currency it bills in — the API refuses another project's list and a list
 * in another currency (400 on `priceListId`) — after the project's default
 * list, which is no list at all; none but the default until a project is
 * picked. The list the form already names stays offered where none of these
 * is it — a role that reads no price lists edits its agreements all the same
 * — named by its id chip, as the agreement's fact is, and a list the API
 * would refuse comes back as its sentence.
 */
export function agreementPriceListOptions(records: readonly BusinessRecord[], values: BusinessFormValues): BusinessFormOption[] {
  const project = valueOf(values, "projectId")
  const currency = valueOf(values, "currency")
  const lists = project === undefined ? [] : records.filter((record) => isPriceListRecord(record) && record.projectIds?.includes(project) === true && record.submittedValues?.currency === currency)
  const options = [{ value: PROJECT_DEFAULT_LIST, label: "The project's default list" }, ...lists.map(optionOf)]
  const current = valueOf(values, "priceListId")
  return current === undefined || options.some((option) => option.value === current) ? options : [...options, { value: current, label: current }]
}

/** The products a subscription may name: its agreement's project's (`subscriptionInitialValues`), or every project's where it names none. */
export function subscriptionProductOptions(records: readonly BusinessRecord[], values: BusinessFormValues): BusinessFormOption[] {
  const project = valueOf(values, "projectId")
  return records.filter((record) => project === undefined || !record.projectIds?.length || record.projectIds.includes(project)).map(optionOf)
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
 * agreement read-only, since it is the row the person chose, and the product
 * and the place picked.
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
        { id: "productId", label: "Product", type: "select", required: true, relation: PRODUCTS_MODULE, description: "Only an active product can be subscribed to." },
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

/**
 * The create form as the person's role allows: the product picked where the
 * role reads the products, and given by its id where it reads none — a
 * picker over a module the store never reads would offer nothing — the API
 * holding the product to the agreement's project and an active status either
 * way.
 */
export function subscriptionFormSchemaFor(productsViewed: boolean): BusinessFormSchema {
  if (productsViewed) return subscriptionFormSchema
  return {
    ...subscriptionFormSchema,
    sections: subscriptionFormSchema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        if (field.id !== "productId") return field
        const byId: BusinessFormField = { ...field, type: "text", placeholder: "The product's id on the API", description: "Your role reads no products here: give the product's id. Only an active product can be subscribed to." }
        delete byId.relation
        return byId
      }),
    })),
  }
}

/** The fields the edit form shows by name in place of a picker, under the record's key for the name (lib/api/records/agreements.ts). */
const SHOWN_BY_NAME: Readonly<Record<string, string>> = { productId: "productName", propertyId: "propertyName", sharedPointId: "sharedPointName" }

/** A picked row on the edit form: shown by its name, not picked — a read-only picker would still be held to the rows its module offers, and an edit refused while that module is not ready. */
function shownByName(field: BusinessFormField, id: string): BusinessFormField {
  const shown: BusinessFormField = { ...field, id, type: "text", readOnly: true }
  delete shown.relation
  delete shown.required
  delete shown.requiredWhen
  delete shown.description
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
      const shown = SHOWN_BY_NAME[field.id]
      if (shown !== undefined) return shownByName(field, shown)
      return ["agreementId", "placeKind"].includes(field.id) ? { ...field, readOnly: true } : field
    }),
  })),
}

/** The values a new subscription opens with: under its agreement, in its project — so the pickers offer that project's products and places, a row of another being one the API refuses — for the agreement's own period, since the API holds it inside that. */
export function subscriptionInitialValues(agreement: BusinessRecord): BusinessFormValues {
  const day = (key: string) => {
    const value = agreement.submittedValues?.[key]
    return typeof value === "string" && value.trim() !== "" ? value : undefined
  }
  const projectId = agreement.projectIds?.[0]
  const validFrom = day("effectiveFrom")
  const validTo = day("effectiveTo")
  return {
    agreementId: agreement.id,
    ...(projectId === undefined ? {} : { projectId }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
  }
}
