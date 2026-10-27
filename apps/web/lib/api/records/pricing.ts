// The Price Engine's catalogue and prices on the prototype's records (Issue
// #185, slice 10 of #81, for #148): Products (`@waste/contracts/catalogue`,
// the routes apps/api/src/routes/products.ts) as `commercial.products`, and
// the Price Lists with their rows (`@waste/contracts/price-lists`, routes
// price-lists.ts) as the two kinds of `commercial.price-rows` — the module the
// API grants `/price-lists` under. The contracts are imported as types only,
// so no zod reaches the bundle.
//
// A product names its project through the organisation and its container
// type, waste fraction and default cadence through the master data, by web
// id on the record and by server id on the wire. Its status is the wire's
// three, listed as the adapter's `statuses`, so the lifecycle's transitions
// write it; its invoice name, invoice code and VAT rate are what an invoice
// line is made of (#112), and a product without a VAT rate blocks its events
// with `no-vat-rate`, which its facts say.
//
// The rows of every list are read list by list and flattened into the one
// module (`GET /price-lists`, then each list's `/rows`): the fan-out is a
// pilot implementation detail, not an API assumption (#127), and a cross-list
// read is the API's answer if the lists grow. The lists come first in the
// module's order, so a row names its list through the rows loaded just
// before it, and its amount is read in that list's currency. A row's
// conditions — a planning area (the prototype's Zone), a customer kind (its
// Customer type), a container type, a waste fraction, and the customer a
// negotiated row is for — name rows of the modules loaded before, and a row
// with none is the product's default price, "Everyone". A row's conditions,
// its product, its list and its start are its key and its period on the
// wire: an edit moves its price, its note and its end alone, and anything
// else is refused at the field with what to do instead.
//
// Neither a list nor a row has a status on the wire: the record's is a
// reading of its period on the project's day (Scheduled, Active, Expired), so
// every move is refused. Periods are spelled as everywhere else: the wire's
// `validTo` is the first day out of force, the form's end the last day in.
//
// Ids, rule (b) of #81's plan closing with this slice: every row here is
// `<prefix>-<uuid>`, and no fixture lends its id — no still-fixture reader
// names a product, a list or a row by a fixture's id (slice 11's provider
// prices show a product as its id chip until #186 switches them).
//
// Explain price is a read, not a write: `explainQuery` turns the dialog's
// pick into the list's server id and `PriceResolveQuery`, and `explainPrice`
// asks `GET /price-lists/:id/resolve`, whose verdicts the dialog shows.
import type { Product } from "@waste/contracts/catalogue"
import { FREE_DAYS_MAX, HIRE_UNIT } from "@waste/domain/finance/hire"
import type { PriceList, PriceListRow, PriceResolution, PriceResolveQuery } from "@waste/contracts/price-lists"
import { CUSTOMER_KINDS, PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS, type CustomerKind, type ProductKind, type ProductStatus, type ProductUnit } from "@waste/domain/registry/vocabulary"

import { percentLabel } from "@/lib/commercial/indexation"
import { formatMinor, majorOf, minorOf } from "@/lib/commercial/money"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import {
  CUSTOMER_KIND_LABELS,
  isPriceListRecord,
  isPriceRowRecord,
  isProductRecord,
  PRICE_LIST_PREFIX,
  PRICE_LIST_RECORD_KIND,
  PRICE_ROW_PREFIX,
  PRICE_ROW_RECORD_KIND,
  PRICE_ROWS_MODULE,
  PRODUCT_KIND_LABELS,
  PRODUCT_PREFIX,
  PRODUCT_RECORD_KIND,
  PRODUCTS_MODULE,
  UNIT_SUFFIX,
} from "@/lib/data/commercial"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf, type MasterDataKind } from "@/lib/data/master-data-kinds"

import { create, get, listAll, patch, withQuery } from "../client"
import { inheritedPresentation, isLocalRefusal, NOTHING_RESOLVED, patchOf, stampFacts, statusLabel, statusToken, typed, typedFlag, webIdOf, type Client, type LocalRefusal, type MappingContext, type Resolver, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayIn, firstDayOut, lastDayIn, planningAreaAdapter } from "./planning"
import { projectMoved, projectServerIdOf, referenced, refusal } from "./places"
import { nameVia, referencedServerId, typedReference, webIdVia } from "./references"
import { customerAdapter } from "./registry"

const AREA_PREFIX = "area"
const CUSTOMER_PREFIX = "customer"

/** What a VAT rate that is not a whole percent is told. */
export const VAT_REFUSAL = "A VAT rate is a whole percent from 0 to 100"
/** What a code the wire cannot take as a slug is told: the form may say it in capitals, as the fixtures' `PL-Copenhagen-2026`. */
export const CODE_REFUSAL = "A code is letters, digits and single hyphens, such as PL-CPH-2027"
/** What an edit moving a list's code or currency is told. */
export const LIST_KEY_REFUSAL = "A list keeps its code and its currency: its rows are quoted in them"
/** What an edit moving a row's key or start is told. */
export const ROW_KEY_REFUSAL = "A row keeps its list, its product, its conditions and its start: end it and add another"

/** The transitions a product offers, by its wire status: a draft is put on sale, an active one withdrawn, an inactive one offered again. */
export const PRODUCT_TRANSITIONS: Readonly<Record<ProductStatus, readonly string[]>> = { draft: ["Active"], active: ["Inactive"], inactive: ["Active"] }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

const oneOf = <Token extends string>(tokens: readonly Token[], value: string | undefined): Token | undefined => tokens.find((token) => token === value)

/** The record's project's day: what a period is read on. */
/** The project's own day, on its clock: what a period is read against. */
export function projectDay(projectServerId: string, context: MappingContext): string {
  const project = context.resolve.byServerId(projectServerId)
  return dayIn(context.now ?? new Date(), project === undefined ? undefined : typed(project, "timezone"))
}

/** A period as a reading of the day: not yet in force, in force, or ended (ADR-0005: `validTo` is the first day out). */
function periodStatus(validFrom: string, validTo: string | null, day: string): "Scheduled" | "Active" | "Expired" {
  if (validFrom > day) return "Scheduled"
  if (validTo !== null && validTo <= day) return "Expired"
  return "Active"
}

/** `2026-01-01 – open`, or its last day in force. */
const periodLabel = (validFrom: string, validTo: string | null) => `${validFrom} – ${validTo === null ? "open" : lastDayIn(validTo)}`

/** A master-data row a field names, as a server id: the loaded row held to its kind, or an id chip; a refusal in the field's words. */
function masterReference(record: BusinessRecord, key: string, kind: MasterDataKind, context: MappingContext): string | undefined | LocalRefusal {
  const details = MASTER_DATA_KIND_DETAILS[kind]
  return typedReference(record, key, details.prefix, context, `Pick a ${details.label.toLowerCase()} the API holds`, { owns: (named) => masterDataKindOf(named) === kind })
}

/** The first refusal among a set of read values, or undefined. */
const firstRefusalOf = (values: readonly unknown[]): LocalRefusal | undefined => values.find(isLocalRefusal) as LocalRefusal | undefined

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

type ProductWire = {
  name: string
  kind: ProductKind | undefined
  status: ProductStatus | undefined
  unit: ProductUnit | undefined
  containerTypeId: string | null
  wasteFractionId: string | null
  serviceFrequencyId: string | null
  invoiceName: string | null
  invoiceCode: string | null
  vatPercent: number | null
  freeDays: number | null
}

/** What free days the API would refuse are told, at `freeDays`. */
export const FREE_DAYS_REFUSAL = `Free days are a whole number from 0 to ${FREE_DAYS_MAX}`

/** A form's free days: null for blank, the whole number for one from 0 to `FREE_DAYS_MAX`, NaN for anything else. */
function freeDaysOf(value: string | undefined): number | null {
  if (value === undefined) return null
  if (!/^\d{1,3}$/.test(value)) return Number.NaN
  const days = Number(value)
  return days <= FREE_DAYS_MAX ? days : Number.NaN
}

/** A form's VAT rate: null for blank, the whole percent for one from 0 to 100, NaN for anything else. */
function vatOf(value: string | undefined): number | null {
  if (value === undefined) return null
  if (!/^\d{1,3}$/.test(value)) return Number.NaN
  const percent = Number(value)
  return percent <= 100 ? percent : Number.NaN
}

/** What the record says the product's fields are, as the wire spells them — null for a field the form left blank — or the first field the API would refuse. */
function productWire(record: BusinessRecord, context: MappingContext): ProductWire | LocalRefusal {
  const kindText = typed(record, "productType")
  const kind = oneOf(PRODUCT_KINDS, kindText)
  if (kindText !== undefined && kind === undefined) return refusal("productType", "Pick a type")
  const unitText = typed(record, "priceUnit")
  const unit = oneOf(PRODUCT_UNITS, unitText)
  if (unitText !== undefined && unit === undefined) return refusal("priceUnit", "Pick a unit")
  const containerTypeId = masterReference(record, "containerType", "container-type", context)
  const wasteFractionId = masterReference(record, "wasteFraction", "waste-fraction", context)
  const serviceFrequencyId = masterReference(record, "serviceFrequencyId", "service-frequency", context)
  const refused = firstRefusalOf([containerTypeId, wasteFractionId, serviceFrequencyId])
  if (refused !== undefined) return refused
  const vatPercent = vatOf(typed(record, "vatPercent"))
  if (Number.isNaN(vatPercent)) return refusal("vatPercent", VAT_REFUSAL)
  // Free days are a hire product's alone: under any other unit the form hides them, and they read as none.
  const freeDays = unit === HIRE_UNIT ? freeDaysOf(typed(record, "freeDays")) : null
  if (Number.isNaN(freeDays)) return refusal("freeDays", FREE_DAYS_REFUSAL)
  return {
    name: typed(record, "productName") ?? record.name,
    kind,
    status: oneOf(PRODUCT_STATUSES, statusToken(record.status)),
    unit,
    containerTypeId: (containerTypeId as string | undefined) ?? null,
    wasteFractionId: (wasteFractionId as string | undefined) ?? null,
    serviceFrequencyId: (serviceFrequencyId as string | undefined) ?? null,
    invoiceName: typed(record, "invoiceName") ?? null,
    invoiceCode: typed(record, "invoiceCode") ?? null,
    vatPercent,
    freeDays,
  }
}

/**
 * A product as the module reads it: the wire's, and on the list read its
 * default price — the row with no condition of its project's default list,
 * in force today — which the Products table shows as the catalogue's price
 * (`null` where it has none). A product a write answers carries none, and
 * reads it from the price rows the store holds instead.
 */
export type ProductResource = Product & { defaultPrice?: { unitPriceMinor: number; currency: string } | null }

/** A row with no condition: the price everyone pays. */
const unconditioned = (row: Pick<PriceListRow, "planningAreaId" | "customerKind" | "containerTypeId" | "wasteFractionId" | "customerId">) =>
  row.planningAreaId === null && row.customerKind === null && row.containerTypeId === null && row.wasteFractionId === null && row.customerId === null

/**
 * Each project's products' default prices, by `project|product`: the rows
 * with no condition of the default list in force on the browser's day — one
 * per project, the database's partial unique — or undefined when the lists
 * cannot be read: `/price-lists` is granted under `commercial.price-rows`, and
 * a role that views the catalogue without it still reads its products.
 */
async function defaultPrices(client: Client): Promise<Map<string, { unitPriceMinor: number; currency: string }> | undefined> {
  const today = dayIn(new Date(), undefined)
  const lists = await listAll<PriceList>(client, "/price-lists", { isDefault: "true", validOn: today }).catch(() => undefined)
  if (lists === undefined) return undefined
  const prices = new Map<string, { unitPriceMinor: number; currency: string }>()
  const rows = await Promise.all(lists.map((list) => listAll<PriceListRow>(client, `/price-lists/${list.id}/rows`, { validOn: today })))
  lists.forEach((list, index) => {
    // The newest start wins where two rows overlap the day, as the resolver's tie-break has it.
    for (const row of rows[index].filter(unconditioned).sort((a, b) => a.validFrom.localeCompare(b.validFrom))) prices.set(`${list.projectId}|${row.productId}`, { unitPriceMinor: row.unitPriceMinor, currency: list.currency })
  })
  return prices
}

/** The Products table's price: the list read's default price, or — on a product a write answered — its default row among the price rows the store holds. */
function defaultPriceOf(product: ProductResource, productWebId: string, projectWebId: string, context: MappingContext): string {
  if (product.defaultPrice !== undefined) return product.defaultPrice === null ? "Unpriced" : `${formatMinor(product.defaultPrice.unitPriceMinor, product.defaultPrice.currency)}${UNIT_SUFFIX[product.unit]}`
  const isDefaultList = (webId: string | undefined) => {
    const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
    const list = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
    return list !== undefined && list.submittedValues?.isDefault === true && (list.projectIds ?? []).includes(projectWebId)
  }
  const conditionKeys = ["planningAreaId", "customerKind", "containerType", "wasteFraction", "customerId"]
  const row = context.resolve.find(
    (record) => isPriceRowRecord(record) && record.status === "Active" && typed(record, "productId") === productWebId && conditionKeys.every((key) => typed(record, key) === undefined) && isDefaultList(typed(record, "priceListId")),
  )
  return row?.value ?? "Unpriced"
}

export const productAdapter: ResourceAdapter<ProductResource> = {
  prefix: PRODUCT_PREFIX,
  auditTable: "product",
  owns: isProductRecord,
  statuses: PRODUCT_STATUSES,
  list: async (client) => {
    const [products, prices] = await Promise.all([listAll<Product>(client, "/products"), defaultPrices(client)])
    // Without the lists, a product reads its default price from the rows the store holds, as after a write.
    return products.map((product) => (prices === undefined ? product : { ...product, defaultPrice: prices.get(`${product.projectId}|${product.id}`) ?? null }))
  },
  read: (client, serverId) => get<Product>(client, `/products/${serverId}`),
  toRecord: (product, context) => {
    const project = referenced(context, "project", product.projectId)
    const master = (kind: MasterDataKind, serverId: string | null) => (serverId === null ? undefined : { id: webIdVia(context, MASTER_DATA_KIND_DETAILS[kind].prefix, serverId), name: nameVia(context, MASTER_DATA_KIND_DETAILS[kind].prefix, serverId) })
    const type = master("container-type", product.containerTypeId)
    const fraction = master("waste-fraction", product.wasteFractionId)
    const frequency = master("service-frequency", product.serviceFrequencyId)
    const kindLabel = PRODUCT_KIND_LABELS[product.kind]
    const id = webIdOf(PRODUCT_PREFIX, product.id)
    return {
      id,
      name: product.name,
      context: `${kindLabel} · ${UNIT_SUFFIX[product.unit]}`,
      status: statusLabel(product.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(product, context.now),
      value: defaultPriceOf(product, id, project.webId, context),
      description: product.invoiceName === null ? "No invoice name yet: an invoice line reads the product's own name." : `Invoiced as ${product.invoiceName}${product.invoiceCode === null ? "" : ` (${product.invoiceCode})`}.`,
      facts: {
        Type: kindLabel,
        Unit: product.unit,
        ...(product.freeDays === null ? {} : { "Free days": product.freeDays === 1 ? "1 day" : `${product.freeDays} days` }),
        ...(type === undefined ? {} : { "Container type": type.name }),
        ...(fraction === undefined ? {} : { "Waste fraction": fraction.name }),
        ...(frequency === undefined ? {} : { "Service frequency": frequency.name }),
        VAT: product.vatPercent === null ? "Not set: its events block until it has one" : `${product.vatPercent}%`,
        ...(product.invoiceName === null ? {} : { "Invoice name": product.invoiceName }),
        ...(product.invoiceCode === null ? {} : { "Invoice code": product.invoiceCode }),
        Project: project.name ?? project.webId,
      },
      allowedTransitions: [...PRODUCT_TRANSITIONS[product.status]],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PRODUCT_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        productName: product.name,
        productType: product.kind,
        priceUnit: product.unit,
        ...(product.freeDays === null ? {} : { freeDays: String(product.freeDays) }),
        ...(type === undefined ? {} : { containerType: type.id }),
        ...(fraction === undefined ? {} : { wasteFraction: fraction.id }),
        ...(frequency === undefined ? {} : { serviceFrequencyId: frequency.id }),
        ...(product.invoiceName === null ? {} : { invoiceName: product.invoiceName }),
        ...(product.invoiceCode === null ? {} : { invoiceCode: product.invoiceCode }),
        ...(product.vatPercent === null ? {} : { vatPercent: String(product.vatPercent) }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const wire = productWire(record, context)
    if (isLocalRefusal(wire)) return wire
    if (wire.kind === undefined) return refusal("productType", "Pick a type")
    if (wire.unit === undefined) return refusal("priceUnit", "Pick a unit")
    const given = <Key extends keyof ProductWire>(key: Key) => (wire[key] === null || wire[key] === undefined ? {} : { [key]: wire[key] })
    return {
      projectId,
      name: wire.name,
      kind: wire.kind,
      ...given("status"),
      unit: wire.unit,
      ...given("containerTypeId"),
      ...given("wasteFractionId"),
      ...given("serviceFrequencyId"),
      ...given("invoiceName"),
      ...given("invoiceCode"),
      ...given("vatPercent"),
      ...given("freeDays"),
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "A product stays in its project")
    const wire = productWire(after, context)
    if (isLocalRefusal(wire)) return wire
    return patchOf(before, after, (record) => {
      const read = productWire(record, context)
      return isLocalRefusal(read) ? {} : read
    })
  },
  create: (client, body) => create<Product>(client, "/products", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Product>(client, `/products/${serverId}`, body),
}

/** Price Engine › Products: the catalogue, one adapter. */
export const productsModule: ServerModule = { workspaceId: PRODUCTS_MODULE.workspaceId, moduleId: PRODUCTS_MODULE.moduleId, resources: [productAdapter] }

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

/** What the record says the list's patchable fields are, as the wire spells them. */
function listFields(record: BusinessRecord) {
  const lastDay = typed(record, "validTo")
  return {
    name: typed(record, "name") ?? record.name,
    isDefault: typedFlag(record, "isDefault") ?? false,
    notes: typed(record, "notes") ?? null,
    validFrom: typed(record, "validFrom"),
    validTo: lastDay === undefined ? null : firstDayOut(lastDay),
  }
}

export const priceListAdapter: ResourceAdapter<PriceList> = {
  prefix: PRICE_LIST_PREFIX,
  auditTable: "price_list",
  owns: isPriceListRecord,
  // No status on the wire: the record's is a reading of its period, and every move is refused.
  statuses: undefined,
  list: (client) => listAll<PriceList>(client, "/price-lists"),
  read: (client, serverId) => get<PriceList>(client, `/price-lists/${serverId}`),
  toRecord: (list, context) => {
    const project = referenced(context, "project", list.projectId)
    const lastDay = list.validTo === null ? undefined : lastDayIn(list.validTo)
    return {
      id: webIdOf(PRICE_LIST_PREFIX, list.id),
      name: list.name,
      context: `${list.code} · ${list.currency}`,
      status: periodStatus(list.validFrom, list.validTo, projectDay(list.projectId, context)),
      ...inheritedPresentation(undefined),
      ...stampFacts(list, context.now),
      value: periodLabel(list.validFrom, list.validTo),
      description: list.notes ?? "",
      facts: {
        Kind: PRICE_LIST_RECORD_KIND,
        Code: list.code,
        Currency: list.currency,
        Default: list.isDefault ? "Yes" : "No",
        Project: project.name ?? project.webId,
        "Valid from": list.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
        ...(list.notes === null ? {} : { Notes: list.notes }),
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PRICE_LIST_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        code: list.code,
        name: list.name,
        currency: list.currency,
        isDefault: list.isDefault,
        ...(list.notes === null ? {} : { notes: list.notes }),
        validFrom: list.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const code = typed(record, "code")?.toLowerCase()
    if (code === undefined) return refusal("code", "A list needs a code")
    if (!SLUG.test(code)) return refusal("code", CODE_REFUSAL)
    const fields = listFields(record)
    if (fields.validFrom === undefined) return refusal("validFrom", "A list needs the first day it is in force")
    const currency = typed(record, "currency")?.toUpperCase()
    return {
      projectId,
      code,
      name: typed(record, "name") ?? typed(record, "code") ?? record.name,
      // The project's currency where the form left it blank: a default list is always in it.
      ...(currency === undefined ? {} : { currency }),
      isDefault: fields.isDefault,
      ...(fields.notes === null ? {} : { notes: fields.notes }),
      validFrom: fields.validFrom,
      ...(fields.validTo === null ? {} : { validTo: fields.validTo }),
    }
  },
  toPatchBody: (before, after) => {
    if (projectMoved(before, after)) return refusal("projectId", "A list stays in its project")
    if (typed(after, "code")?.toLowerCase() !== typed(before, "code")?.toLowerCase()) return refusal("code", LIST_KEY_REFUSAL)
    if (typed(after, "currency")?.toUpperCase() !== typed(before, "currency")?.toUpperCase()) return refusal("currency", LIST_KEY_REFUSAL)
    return patchOf(before, after, listFields)
  },
  create: (client, body) => create<PriceList>(client, "/price-lists", body).then((created) => created.body),
  update: (client, serverId, body) => patch<PriceList>(client, `/price-lists/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Price rows
// ---------------------------------------------------------------------------

/** What a row's create carries: the list it is posted under, and the body the contract accepts. */
type RowWrite = { priceListId: string; body: unknown }

/** The list a record names under `priceListId`, loaded, with its server id and its currency; undefined for one the store does not hold. */
function listOf(webId: string | undefined, context: MappingContext): { serverId: string; currency: string } | undefined {
  if (webId === undefined) return undefined
  const serverId = context.resolve.serverIdOf(webId)
  const list = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  const currency = list === undefined ? undefined : typed(list, "currency")
  return serverId === undefined || list === undefined || !isPriceListRecord(list) || currency === undefined ? undefined : { serverId, currency }
}

/** The conditions and the key a row's record names, each as the server id it stands for — or the form's text where none — for an edit to compare. */
function rowKeyOf(record: BusinessRecord, context: MappingContext): Record<string, string | undefined> {
  const named = (key: string, prefix: string) => {
    const webId = typed(record, key)
    return webId === undefined ? undefined : (referencedServerId(webId, prefix, context) ?? webId)
  }
  return {
    priceListId: named("priceListId", PRICE_LIST_PREFIX),
    productId: named("productId", PRODUCT_PREFIX),
    planningAreaId: named("planningAreaId", AREA_PREFIX),
    customerKind: typed(record, "customerKind"),
    containerType: named("containerType", MASTER_DATA_KIND_DETAILS["container-type"].prefix),
    wasteFraction: named("wasteFraction", MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix),
    customerId: named("customerId", CUSTOMER_PREFIX),
    validFrom: typed(record, "validFrom"),
  }
}

/** The amount a person reads a price as, `18.50` being the example in any currency of two minor digits. */
const amountRefusal = (currency: string) => refusal("amount", `An amount in ${currency}, such as ${majorOf(1850, currency)}`)

export const priceRowAdapter: ResourceAdapter<PriceListRow> = {
  prefix: PRICE_ROW_PREFIX,
  auditTable: "price_list_row",
  owns: isPriceRowRecord,
  statuses: undefined,
  // Every list's rows, list by list: the pilot's fan-out (#127). The lists are read again here, since the two adapters list at once.
  list: async (client) => {
    const lists = await listAll<PriceList>(client, "/price-lists")
    const rows = await Promise.all(lists.map((list) => listAll<PriceListRow>(client, `/price-lists/${list.id}/rows`)))
    return rows.flat()
  },
  read: (client, serverId) => get<PriceListRow>(client, `/price-list-rows/${serverId}`),
  toRecord: (row, context) => {
    // The list, loaded just before this row in the module's order; its currency is every amount's.
    const list = context.resolve.byServerId(row.priceListId)
    const project = referenced(context, "project", row.projectId)
    const projectRecord = context.resolve.byServerId(row.projectId)
    const currency = (list === undefined ? undefined : typed(list, "currency")) ?? (projectRecord === undefined ? undefined : typed(projectRecord, "currency")) ?? "DKK"
    const product = referenced(context, PRODUCT_PREFIX, row.productId)
    const productRecord = context.resolve.byServerId(row.productId)
    const unit = oneOf(PRODUCT_UNITS, productRecord === undefined ? undefined : typed(productRecord, "priceUnit"))
    const productName = product.name ?? product.webId
    const listName = list?.name ?? webIdOf(PRICE_LIST_PREFIX, row.priceListId)
    const condition = (prefix: string, serverId: string | null) => (serverId === null ? undefined : { id: webIdVia(context, prefix, serverId), name: nameVia(context, prefix, serverId) })
    const area = condition(AREA_PREFIX, row.planningAreaId)
    const type = condition(MASTER_DATA_KIND_DETAILS["container-type"].prefix, row.containerTypeId)
    const fraction = condition(MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, row.wasteFractionId)
    const customer = condition(CUSTOMER_PREFIX, row.customerId)
    const kind = row.customerKind === null ? undefined : CUSTOMER_KIND_LABELS[row.customerKind]
    const conditions = [area?.name, kind, type?.name, fraction?.name].filter((part): part is string => part !== undefined)
    const name = [...(customer === undefined ? [] : [`${customer.name} (negotiated)`]), ...conditions].join(" · ") || "Everyone"
    const lastDay = row.validTo === null ? undefined : lastDayIn(row.validTo)
    const amount = majorOf(row.unitPriceMinor, currency)
    return {
      id: webIdOf(PRICE_ROW_PREFIX, row.id),
      name,
      context: productName,
      status: periodStatus(row.validFrom, row.validTo, projectDay(row.projectId, context)),
      ...inheritedPresentation(undefined),
      ...stampFacts(row, context.now),
      value: `${formatMinor(row.unitPriceMinor, currency)}${unit === undefined ? "" : UNIT_SUFFIX[unit]}`,
      description: `Price row on ${productName} (${name}) in ${listName}.`,
      facts: {
        Kind: PRICE_ROW_RECORD_KIND,
        Product: productName,
        "Price list": listName,
        Amount: amount,
        Currency: currency,
        ...(unit === undefined ? {} : { Unit: unit }),
        ...(area === undefined ? {} : { Zone: area.name }),
        ...(kind === undefined ? {} : { "Customer type": kind }),
        ...(type === undefined ? {} : { "Container type": type.name }),
        ...(fraction === undefined ? {} : { "Waste fraction": fraction.name }),
        ...(customer === undefined ? {} : { "Negotiated customer": customer.name }),
        "Effective from": row.validFrom,
        ...(lastDay === undefined ? {} : { "Effective to": lastDay }),
        ...(row.note === null ? {} : { Note: row.note }),
        // The chain (#291 C8): the row Apply index wrote this one from, by its index, the day being the row's own start.
        ...(row.indexLabel === null || row.indexBasisPoints === null ? {} : { Indexed: `${row.indexLabel} ${percentLabel(row.indexBasisPoints)} from ${row.validFrom}` }),
      },
      related: [listName, productName],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PRICE_ROW_RECORD_KIND,
      submittedValues: {
        priceListId: list?.id ?? webIdOf(PRICE_LIST_PREFIX, row.priceListId),
        productId: product.webId,
        amount,
        ...(area === undefined ? {} : { planningAreaId: area.id }),
        ...(row.customerKind === null ? {} : { customerKind: row.customerKind }),
        ...(type === undefined ? {} : { containerType: type.id }),
        ...(fraction === undefined ? {} : { wasteFraction: fraction.id }),
        ...(customer === undefined ? {} : { customerId: customer.id }),
        ...(row.note === null ? {} : { note: row.note }),
        validFrom: row.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const list = listOf(typed(record, "priceListId"), context)
    if (list === undefined) return refusal("priceListId", "Pick a price list the API holds")
    const productWebId = typed(record, "productId")
    const productId = productWebId === undefined ? undefined : referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
    if (productId === undefined) return refusal("productId", "Pick a product the API holds")
    const amount = typed(record, "amount")
    const unitPriceMinor = amount === undefined ? Number.NaN : minorOf(amount, list.currency)
    if (Number.isNaN(unitPriceMinor)) return amountRefusal(list.currency)
    const planningAreaId = typedReference(record, "planningAreaId", AREA_PREFIX, context, "Pick a planning area the API holds", { owns: planningAreaAdapter.owns })
    const containerTypeId = masterReference(record, "containerType", "container-type", context)
    const wasteFractionId = masterReference(record, "wasteFraction", "waste-fraction", context)
    const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
    const refused = firstRefusalOf([planningAreaId, containerTypeId, wasteFractionId, customerId])
    if (refused !== undefined) return refused
    const kindText = typed(record, "customerKind")
    const customerKind: CustomerKind | undefined = oneOf(CUSTOMER_KINDS, kindText)
    if (kindText !== undefined && customerKind === undefined) return refusal("customerKind", "Pick a person or an organisation")
    const validFrom = typed(record, "validFrom")
    if (validFrom === undefined) return refusal("validFrom", "A row needs the first day it is in force")
    const lastDay = typed(record, "validTo")
    const note = typed(record, "note")
    const write: RowWrite = {
      priceListId: list.serverId,
      body: {
        productId,
        unitPriceMinor,
        ...(planningAreaId === undefined ? {} : { planningAreaId }),
        ...(customerKind === undefined ? {} : { customerKind }),
        ...(containerTypeId === undefined ? {} : { containerTypeId }),
        ...(wasteFractionId === undefined ? {} : { wasteFractionId }),
        ...(customerId === undefined ? {} : { customerId }),
        ...(note === undefined ? {} : { note }),
        validFrom,
        ...(lastDay === undefined ? {} : { validTo: firstDayOut(lastDay) }),
      },
    }
    return write
  },
  toPatchBody: (before, after, context) => {
    const was = rowKeyOf(before, context)
    const is = rowKeyOf(after, context)
    const moved = Object.keys(is).find((key) => is[key] !== was[key])
    if (moved !== undefined) return refusal(moved, ROW_KEY_REFUSAL)
    const currency = listOf(typed(after, "priceListId"), context)?.currency ?? "DKK"
    const priceOf = (record: BusinessRecord) => {
      const amount = typed(record, "amount")
      return amount === undefined ? undefined : minorOf(amount, currency)
    }
    if (Number.isNaN(priceOf(after))) return amountRefusal(currency)
    return patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return { unitPriceMinor: priceOf(record), note: typed(record, "note") ?? null, validTo: lastDay === undefined ? null : firstDayOut(lastDay) }
    })
  },
  create: (client, body) => {
    const write = body as RowWrite
    return create<PriceListRow>(client, `/price-lists/${write.priceListId}/rows`, write.body).then((created) => created.body)
  },
  update: (client, serverId, body) => patch<PriceListRow>(client, `/price-list-rows/${serverId}`, body),
}

/** Price Engine › Price rows: the lists, then every list's rows, which name their list through the rows loaded just before them. */
export const priceRowsModule: ServerModule = { workspaceId: PRICE_ROWS_MODULE.workspaceId, moduleId: PRICE_ROWS_MODULE.moduleId, resources: [priceListAdapter, priceRowAdapter] }

// ---------------------------------------------------------------------------
// Explain price
// ---------------------------------------------------------------------------

/** What the Explain price dialog asks: the list's server id and the resolve read's query. */
export type ExplainQuery = { priceListId: string; query: PriceResolveQuery }

/**
 * The dialog's pick as the resolve read's question: the list and the product
 * the store holds, the day, and each condition the person gave, by server id
 * — a condition left blank is not asked, so the read judges every row as a
 * stranger would be judged. A refusal names the field before the API sees it.
 */
export function explainQuery(values: BusinessFormValues, resolve: Resolver = NOTHING_RESOLVED): ExplainQuery | LocalRefusal {
  const context: MappingContext = { fixtures: [], resolve }
  const record = { submittedValues: values } as BusinessRecord
  const list = listOf(typed(record, "priceListId"), context)
  if (list === undefined) return refusal("priceListId", "Pick a price list the API holds")
  const productWebId = typed(record, "productId")
  const productId = productWebId === undefined ? undefined : referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
  if (productId === undefined) return refusal("productId", "Pick a product the API holds")
  const on = typed(record, "on")
  if (on === undefined) return refusal("on", "Pick the day the price is asked for")
  const planningAreaId = typedReference(record, "planningAreaId", AREA_PREFIX, context, "Pick a planning area the API holds", { owns: planningAreaAdapter.owns })
  const containerTypeId = masterReference(record, "containerType", "container-type", context)
  const wasteFractionId = masterReference(record, "wasteFraction", "waste-fraction", context)
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  const refused = firstRefusalOf([planningAreaId, containerTypeId, wasteFractionId, customerId])
  if (refused !== undefined) return refused
  const customerKind = oneOf(CUSTOMER_KINDS, typed(record, "customerKind"))
  const query: PriceResolveQuery = {
    productId,
    on,
    ...(planningAreaId === undefined ? {} : { planningAreaId: planningAreaId as string }),
    ...(customerKind === undefined ? {} : { customerKind }),
    ...(containerTypeId === undefined ? {} : { containerTypeId: containerTypeId as string }),
    ...(wasteFractionId === undefined ? {} : { wasteFractionId: wasteFractionId as string }),
    ...(customerId === undefined ? {} : { customerId: customerId as string }),
  }
  return { priceListId: list.serverId, query }
}

/** `GET /price-lists/:id/resolve`: every row's verdict on the question, the winner first. */
export function explainPrice(client: Client, priceListId: string, query: PriceResolveQuery): Promise<PriceResolution> {
  return get<PriceResolution>(client, withQuery(`/price-lists/${priceListId}/resolve`, query))
}
