// Agreements and subscriptions on the prototype's records (Issue #183, slice
// 9a of #81): the Registry's effective-dated pair (`@waste/contracts/
// agreements`, imported as types so no zod reaches the bundle; the routes
// are apps/api/src/routes/agreements.ts) as the two kinds of one module,
// `customers.agreements` — the agreements listed first, then every
// agreement's subscriptions, which name their agreement through the rows
// loaded just before them. Which adapter owns a record is lib/data/
// agreements.ts's one rule: the id's prefix, then the kind the form stamped.
//
// An agreement names its customer and its payer through the switched
// contacts module — by web id on the record, resolved to the server's id on
// a write, refused when the store holds no such row — and its project
// through the organisation. Its status is the wire's three (`draft`,
// `active`, `cancelled`), listed as the adapter's `statuses`, so the store
// spells a move to Cancelled and refuses the lifecycle's Pending, Expiring,
// Expired and Terminated before the API sees them: those are readings of the
// period (ADR-0005), and the end of an agreement is its `validTo`, never a
// delete. The transitions a row offers follow its wire status.
//
// A subscription names its product and its place — a property or a shared
// collection point, one of the two — as id chips until their modules are
// switched (slices 10 and 9b): `product-<uuid>` on the record, and on a
// write the store's resolver first, then the chip's or a bare id
// (`referencedId`), so the fields become pickers as the modules land without
// a change here. No status is on the wire, so every move is refused; the
// record's status is a reading of its period on the project's day (Pending,
// Active, Expired), the same day the planning areas are read on.
//
// #79's gates are the API's: an inactive customer or payer on an agreement,
// a draft product or an unserved place on a subscription come back as the
// API's 409 sentence through the store's toast. The one refusal spelled here
// beyond the form's own fields: the agreement form's "Initial subscription"
// names a product the API takes only as a row of its own, so a create that
// fills it is refused at the field and the subscription is added once the
// agreement is saved.
//
// Periods are spelled two ways: the wire's `validTo` is the first day out of
// force, the form's "Effective to" and "Valid to" the last day in, as every
// fixture end date reads and as the planning adapter has it; a day is added
// on the way out and taken on the way in.
//
// Ids. A seeded agreement keeps its fixture's id (`agreement-2408`), matched
// by the number it quotes — the one stable key the wire has (#81's review,
// answer 4) — since the tickets' fixtures name agreements by id; every other
// agreement is `agreement-<uuid>` and every subscription `subscription-<uuid>`.
import type { Agreement, AgreementStatus, Subscription } from "@waste/contracts/agreements"
import { AGREEMENT_STATUSES as WIRE_AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"

import {
  AGREEMENT_PREFIX,
  AGREEMENT_RECORD_KIND,
  AGREEMENTS_MODULE,
  isAgreementRecord,
  isSubscriptionRecord,
  ONE_PLACE,
  PRICE_LIST_PREFIX,
  PRODUCT_PREFIX,
  PROPERTY_PREFIX,
  referencedId,
  SHARED_POINT_PREFIX,
  SUBSCRIPTION_PREFIX,
  SUBSCRIPTION_RECORD_KIND,
} from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"

import { create, listAll, patch } from "../client"
import { hasPrefix, inheritedPresentation, patchOf, stampFacts, statusLabel, statusToken, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayIn, firstDayOut, lastDayIn } from "./planning"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The wire's agreement statuses, the vocabulary's own tuple: exactly what a patch may say. */
export const AGREEMENT_STATUSES: readonly AgreementStatus[] = WIRE_AGREEMENT_STATUSES

/** The transitions a row offers, by its wire status: a draft is signed or cancelled, a running agreement cancelled, a cancelled one left as it is. */
const TRANSITIONS: Readonly<Record<AgreementStatus, readonly string[]>> = { draft: ["Active", "Cancelled"], active: ["Cancelled"], cancelled: [] }

/** What the agreement form's "Initial subscription" is refused with: the API takes a subscription as a row of its own, under a saved agreement. */
export const INITIAL_SUBSCRIPTION_REFUSAL = "Save the agreement first, then add its subscription from the agreement's actions"

export const QUANTITY_REFUSAL = "A quantity is a whole number, 1 or more"

/** `2026-01-01 – 2026-12-31`, or `– open` while it runs: the period as the form's last day in force. */
const periodLabel = (validFrom: string, validTo: string | null) => `${validFrom} – ${validTo === null ? "open" : lastDayIn(validTo)}`

/** A form's count: undefined for blank, the number for a whole positive one, NaN for anything else. */
function countOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : Number.NaN
}

/** The status the record's own label says, where it is one the wire has. */
const wireStatusOf = (record: Pick<BusinessRecord, "status">): AgreementStatus | undefined => AGREEMENT_STATUSES.find((candidate) => candidate === statusToken(record.status))

/** A row of another module the store may or may not hold: its web id and the name a person reads, the server's id as a chip when it holds none. */
function referenced(context: MappingContext, serverId: string, prefix: string): { id: string; name: string } {
  const record = context.resolve.byServerId(serverId)
  if (record !== undefined) return { id: record.id, name: record.name }
  const chip = webIdOf(prefix, serverId)
  return { id: chip, name: chip }
}

/** The server id a chip or a web id stands for: the store's row first, then the chip's own id, so a switched module resolves and an unswitched one is named by id. */
const chipServerId = (value: string | undefined, prefix: string, context: MappingContext): string | undefined =>
  (value === undefined ? undefined : context.resolve.serverIdOf(value)) ?? referencedId(value, prefix)

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

/** The fixture agreement quoting the number: its typed number, or the number its name starts with (`AGR-2408 · Østerbro Housing`). */
function fixtureNumbered(fixtures: readonly BusinessRecord[], number: string): BusinessRecord | undefined {
  return fixtures.filter(hasPrefix(AGREEMENT_PREFIX)).find((record) => typed(record, "agreementNumber") === number || record.name === number || record.name.startsWith(`${number} · `))
}

/** The customer a party field names, as the server's id: the store's row, else the chip an unresolved row was shown as. */
const partyServerId = (record: BusinessRecord, key: string, context: MappingContext) => chipServerId(typed(record, key), "customer", context)

/** What the record says the agreement's fields are, as the wire spells them: undefined leaves a field alone on a patch, null clears it. */
function agreementFields(record: BusinessRecord, context: MappingContext) {
  const lastDay = typed(record, "effectiveTo")
  return {
    number: typed(record, "agreementNumber"),
    customerId: partyServerId(record, "customerId", context),
    payerCustomerId: partyServerId(record, "payerId", context),
    status: wireStatusOf(record),
    billingCadence: typed(record, "billingCadence"),
    currency: typed(record, "currency"),
    // The record carries notes only where the wire has some, so a blank and an absent field both read as the wire's null.
    notes: typed(record, "internalNotes") ?? null,
    validFrom: typed(record, "effectiveFrom"),
    validTo: lastDay === undefined ? null : firstDayOut(lastDay),
  }
}

export const agreementAdapter: ResourceAdapter<Agreement> = {
  prefix: AGREEMENT_PREFIX,
  owns: isAgreementRecord,
  statuses: AGREEMENT_STATUSES,
  list: (client) => listAll<Agreement>(client, "/agreements"),
  toRecord: (agreement, context) => {
    const fixture = fixtureNumbered(context.fixtures, agreement.number)
    const customer = referenced(context, agreement.customerId, "customer")
    const payer = referenced(context, agreement.payerCustomerId, "customer")
    const samePayer = agreement.payerCustomerId === agreement.customerId
    const project = context.resolve.byServerId(agreement.projectId)
    const projectWebId = project?.id ?? webIdOf("project", agreement.projectId)
    const period = periodLabel(agreement.validFrom, agreement.validTo)
    const lastDay = agreement.validTo === null ? undefined : lastDayIn(agreement.validTo)
    return {
      id: fixture?.id ?? webIdOf(AGREEMENT_PREFIX, agreement.id),
      name: `${agreement.number} · ${customer.name}`,
      context: `${customer.name} · ${samePayer ? "same payer" : `payer ${payer.name}`}`,
      status: statusLabel(agreement.status),
      ...inheritedPresentation(fixture),
      ...stampFacts(agreement, context.now),
      value: period,
      description: fixture?.description || `Agreement of ${customer.name}${samePayer ? "" : `, billed to ${payer.name}`}.`,
      facts: {
        Kind: AGREEMENT_RECORD_KIND,
        Number: agreement.number,
        Customer: customer.name,
        Payer: payer.name,
        Project: project?.name ?? "Project",
        Billing: statusLabel(agreement.billingCadence),
        Currency: agreement.currency,
        ...(agreement.priceListId === null ? {} : { "Price list": referenced(context, agreement.priceListId, PRICE_LIST_PREFIX).name }),
        ...(agreement.notes === null ? {} : { Notes: agreement.notes }),
        "Valid from": agreement.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
      },
      related: samePayer ? [customer.name] : [customer.name, payer.name],
      allowedTransitions: [...TRANSITIONS[agreement.status]],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: AGREEMENT_RECORD_KIND,
      submittedValues: {
        projectId: projectWebId,
        agreementNumber: agreement.number,
        customerId: customer.id,
        payerId: payer.id,
        effectiveFrom: agreement.validFrom,
        ...(lastDay === undefined ? {} : { effectiveTo: lastDay }),
        billingCadence: agreement.billingCadence,
        currency: agreement.currency,
        ...(agreement.notes === null ? {} : { internalNotes: agreement.notes }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const fields = agreementFields(record, context)
    if (fields.number === undefined) return refusal("agreementNumber", "An agreement needs a number")
    if (fields.customerId === undefined) return refusal("customerId", "Pick a customer the API holds")
    if (fields.payerCustomerId === undefined) return refusal("payerId", "Pick a payer the API holds")
    if (typed(record, "productId") !== undefined) return refusal("productId", INITIAL_SUBSCRIPTION_REFUSAL)
    if (fields.validFrom === undefined) return refusal("effectiveFrom", "An agreement needs the first day it is in force")
    if (fields.billingCadence === undefined || !(BILLING_CADENCES as readonly string[]).includes(fields.billingCadence)) return refusal("billingCadence", "Pick a billing cadence")
    if (fields.currency === undefined) return refusal("currency", "Pick a currency")
    return {
      projectId,
      number: fields.number,
      customerId: fields.customerId,
      payerCustomerId: fields.payerCustomerId,
      // A create says a status only where the form set one other than the API's default.
      ...(fields.status === undefined || fields.status === "draft" ? {} : { status: fields.status }),
      billingCadence: fields.billingCadence,
      currency: fields.currency,
      ...(fields.notes === null ? {} : { notes: fields.notes }),
      validFrom: fields.validFrom,
      ...(fields.validTo === null ? {} : { validTo: fields.validTo }),
    }
  },
  toPatchBody: (before, after, context) => {
    if ((typed(after, "projectId") ?? after.projectIds?.[0]) !== (typed(before, "projectId") ?? before.projectIds?.[0])) return refusal("projectId", "An agreement stays in its project")
    if (typed(after, "productId") !== typed(before, "productId")) return refusal("productId", INITIAL_SUBSCRIPTION_REFUSAL)
    const fields = agreementFields(after, context)
    if (typed(after, "customerId") !== undefined && fields.customerId === undefined) return refusal("customerId", "Pick a customer the API holds")
    if (typed(after, "payerId") !== undefined && fields.payerCustomerId === undefined) return refusal("payerId", "Pick a payer the API holds")
    return patchOf(before, after, (record) => agreementFields(record, context))
  },
  create: (client, body) => create<Agreement>(client, "/agreements", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Agreement>(client, `/agreements/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** What a subscription's create carries: the agreement it is posted under, and the body the contract accepts. */
type SubscriptionWrite = { agreementId: string; body: unknown }

/** The subscription's status as a reading of its period on the project's day: not yet in force, in force, or ended. */
function periodStatus(subscription: Subscription, day: string): "Pending" | "Active" | "Expired" {
  if (subscription.validFrom > day) return "Pending"
  if (subscription.validTo !== null && subscription.validTo <= day) return "Expired"
  return "Active"
}

export const subscriptionAdapter: ResourceAdapter<Subscription> = {
  prefix: SUBSCRIPTION_PREFIX,
  owns: isSubscriptionRecord,
  // No status on the wire: the record's is a reading of its period, and every move the lifecycle offers is refused.
  statuses: undefined,
  // The flat list across agreements (`GET /subscriptions`, added for this
  // slice as placements are listed across containers): one read for the
  // module, where one per agreement was a burst of fifty on the seeded tenant.
  list: (client) => listAll<Subscription>(client, "/subscriptions"),
  toRecord: (subscription, context) => {
    // The agreement's row, loaded just before this one in the module's order; the agreement's own id names it when the rows are not there.
    const agreement = context.resolve.byServerId(subscription.agreementId)
    const agreementWebId = agreement?.id ?? webIdOf(AGREEMENT_PREFIX, subscription.agreementId)
    const number = agreement === undefined ? agreementWebId : (typed(agreement, "agreementNumber") ?? agreement.name)
    const product = referenced(context, subscription.productId, PRODUCT_PREFIX)
    const property = subscription.propertyId === null ? undefined : referenced(context, subscription.propertyId, PROPERTY_PREFIX)
    const point = subscription.sharedCollectionPointId === null ? undefined : referenced(context, subscription.sharedCollectionPointId, SHARED_POINT_PREFIX)
    const place = property ?? point
    const project = context.resolve.byServerId(subscription.projectId)
    const projectWebId = project?.id ?? webIdOf("project", subscription.projectId)
    const day = dayIn(context.now ?? new Date(), project === undefined ? undefined : typed(project, "timezone"))
    const lastDay = subscription.validTo === null ? undefined : lastDayIn(subscription.validTo)
    return {
      id: webIdOf(SUBSCRIPTION_PREFIX, subscription.id),
      name: `${number} · ${product.name}`,
      context: agreement?.context ?? number,
      status: periodStatus(subscription, day),
      ...inheritedPresentation(undefined),
      ...stampFacts(subscription, context.now),
      value: periodLabel(subscription.validFrom, subscription.validTo),
      description: `One product delivered at one place under ${number}.`,
      facts: {
        Kind: SUBSCRIPTION_RECORD_KIND,
        Agreement: number,
        Product: product.name,
        ...(property === undefined ? {} : { Property: property.name }),
        ...(point === undefined ? {} : { "Shared collection point": point.name }),
        Quantity: String(subscription.quantity),
        "Valid from": subscription.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
      },
      related: [agreement?.name ?? agreementWebId, product.name, ...(place === undefined ? [] : [place.name])],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: SUBSCRIPTION_RECORD_KIND,
      submittedValues: {
        agreementId: agreementWebId,
        productId: product.id,
        // Which of the form's two place pickers holds the place (lib/data/agreements.ts): the edit shows that one.
        placeKind: point === undefined ? "property" : "shared-point",
        ...(property === undefined ? {} : { propertyId: property.id }),
        ...(point === undefined ? {} : { sharedPointId: point.id }),
        quantity: String(subscription.quantity),
        validFrom: subscription.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
      },
    }
  },
  toCreateBody: (record, context) => {
    // The agreement is a switched module's row: the store's resolver alone names it, never a typed id.
    const agreementWebId = typed(record, "agreementId")
    const agreementId = agreementWebId === undefined ? undefined : context.resolve.serverIdOf(agreementWebId)
    if (agreementId === undefined) {
      // A row the workspace minted this session (`<moduleId>-<kind>-<clock>`, adapter.ts) whose create has not answered yet holds no server id: the wait is the remedy, as the store's commands say.
      if (agreementWebId?.startsWith(`${AGREEMENTS_MODULE.moduleId}-`)) return refusal("agreementId", "The agreement is not on the API yet: wait for it to be saved, then try again")
      return refusal("agreementId", "Pick an agreement the API holds")
    }
    const productId = chipServerId(typed(record, "productId"), PRODUCT_PREFIX, context)
    if (productId === undefined) return refusal("productId", "Pick a product the API holds")
    const propertyText = typed(record, "propertyId")
    const pointText = typed(record, "sharedPointId")
    if ((propertyText === undefined) === (pointText === undefined)) return refusal("propertyId", ONE_PLACE)
    const propertyId = chipServerId(propertyText, PROPERTY_PREFIX, context)
    if (propertyText !== undefined && propertyId === undefined) return refusal("propertyId", "Pick a property the API holds")
    const sharedCollectionPointId = chipServerId(pointText, SHARED_POINT_PREFIX, context)
    if (pointText !== undefined && sharedCollectionPointId === undefined) return refusal("sharedPointId", "Pick a shared collection point the API holds")
    const quantity = countOf(typed(record, "quantity"))
    if (Number.isNaN(quantity)) return refusal("quantity", QUANTITY_REFUSAL)
    const validFrom = typed(record, "validFrom")
    if (validFrom === undefined) return refusal("validFrom", "A subscription needs the first day it is in force")
    const lastDay = typed(record, "validTo")
    const write: SubscriptionWrite = {
      agreementId,
      body: {
        productId,
        ...(propertyId === undefined ? {} : { propertyId }),
        ...(sharedCollectionPointId === undefined ? {} : { sharedCollectionPointId }),
        // A blank quantity leaves the API's default, one of the product at the place.
        ...(quantity === undefined ? {} : { quantity }),
        validFrom,
        ...(lastDay === undefined ? {} : { validTo: firstDayOut(lastDay) }),
      },
    }
    return write
  },
  toPatchBody: (before, after, context) => {
    // What each field names, not how it is spelled: the row the store mapped
    // carries chips, the row the workspace minted the bare ids the form took,
    // and the two name one product and one place.
    const names = (record: BusinessRecord, key: string, prefix: string) => chipServerId(typed(record, key), prefix, context) ?? typed(record, key)
    if (names(before, "agreementId", AGREEMENT_PREFIX) !== names(after, "agreementId", AGREEMENT_PREFIX)) return refusal("agreementId", "A subscription stays under its agreement")
    if (names(before, "productId", PRODUCT_PREFIX) !== names(after, "productId", PRODUCT_PREFIX)) return refusal("productId", "A subscription keeps its product: end this one and add another")
    if (names(before, "propertyId", PROPERTY_PREFIX) !== names(after, "propertyId", PROPERTY_PREFIX) || names(before, "sharedPointId", SHARED_POINT_PREFIX) !== names(after, "sharedPointId", SHARED_POINT_PREFIX)) {
      return refusal("propertyId", "A subscription keeps its place: end this one and add another")
    }
    if (Number.isNaN(countOf(typed(after, "quantity")))) return refusal("quantity", QUANTITY_REFUSAL)
    return patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return {
        // A blank quantity on an edit leaves the stored one alone.
        quantity: countOf(typed(record, "quantity")),
        validFrom: typed(record, "validFrom"),
        validTo: lastDay === undefined ? null : firstDayOut(lastDay),
      }
    })
  },
  create: (client, body) => {
    const write = body as SubscriptionWrite
    return create<Subscription>(client, `/agreements/${write.agreementId}/subscriptions`, write.body).then((created) => created.body)
  },
  update: (client, serverId, body) => patch<Subscription>(client, `/subscriptions/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/** Customers → Agreements and Subscriptions: the agreements before the subscriptions that name them. */
export const agreementsModule: ServerModule = {
  workspaceId: AGREEMENTS_MODULE.workspaceId,
  moduleId: AGREEMENTS_MODULE.moduleId,
  resources: [agreementAdapter, subscriptionAdapter],
}

export type { Client }
