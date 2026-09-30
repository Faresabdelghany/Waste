// Agreements and subscriptions on the adapter (#183, slice 9a of #81): the
// Registry's effective-dated pair become the records of `customers.agreements`
// — an agreement naming its customer and payer through the switched contacts
// module, a subscription naming its agreement through the rows loaded before
// it and its product and place as id chips until their modules are switched;
// the records the workspace writes become the bodies the API's contracts
// accept, held here against the contracts' own zod schemas; and the writes go
// out through the store's seam over a scripted `fetch`, the API's refusals
// coming back as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AgreementCreate, AgreementPatch, SubscriptionCreate, SubscriptionPatch, type Agreement, type Subscription } from "@waste/contracts/agreements"
import type { Customer } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"

import { AGREEMENTS_MODULE, ONE_PLACE, SUBSCRIPTION_RECORD_KIND } from "../../data/agreements"
import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { AGREEMENT_STATUSES, agreementAdapter, agreementsModule, INITIAL_SUBSCRIPTION_REFUSAL, subscriptionAdapter } from "../records/agreements"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { customerAdapter } from "../records/registry"
import { loaded, loadModule, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const module = getModuleDefinition(AGREEMENTS_MODULE)
if (!module) throw new Error("no module customers.agreements")
const agreementFixtures = module.records
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const customerFixtures = getModuleDefinition({ workspaceId: "customers", moduleId: "contacts" })?.records ?? []

// The seeded rows as the API answers them (packages/db/src/seed/registry.ts), in the seed's id scheme.
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const HARBOR = "01a0d2a4-a280-7002-8000-000000000002"
const mikkel: Customer = { id: "01a0d2a4-a280-700b-8000-000000000001", ...STAMPS, kind: "person", name: "Mikkel Sørensen", registrationNumber: null, email: "mikkel.sorensen@example.dk", phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const osterbro: Customer = { ...mikkel, id: "01a0d2a4-a280-700b-8000-000000000002", kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null }
const kab: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000004", name: "KAB Bolig", registrationNumber: null, status: "inactive" }
const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"
const PROPERTY = "01a0d2a4-a280-700c-8000-000000000001"
const POINT = "01a0d2a4-a280-7010-8000-000000000001"
const agr2408: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: osterbro.id, payerCustomerId: osterbro.id, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, validFrom: "2026-01-01", validTo: "2027-01-01" }
const agr2512: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000002", projectId: HARBOR, number: "AGR-2512", status: "draft", validFrom: "2026-09-01", validTo: null }
const agr2188: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000003", number: "AGR-2188", customerId: mikkel.id, payerCustomerId: kab.id, validTo: null }
const agrDraft: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000004", number: "AGR-2700", status: "draft", notes: "Payer to be confirmed", priceListId: "01a0d2a4-a280-7028-8000-000000000001", validFrom: "2026-10-01", validTo: null }
const agrCancelled: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000005", number: "AGR-2701", status: "cancelled" }
const sub1: Subscription = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, agreementId: agr2408.id, productId: PRODUCT, propertyId: PROPERTY, sharedCollectionPointId: null, quantity: 1, validFrom: "2026-01-01", validTo: "2027-01-01" }
const sub2: Subscription = { ...sub1, id: "01a0d2a4-a280-7013-8000-000000000002", propertyId: null, sharedCollectionPointId: POINT, quantity: 2, validFrom: "2026-11-01", validTo: null }
const subEnded: Subscription = { ...sub1, id: "01a0d2a4-a280-7013-8000-000000000003", validFrom: "2025-01-01", validTo: "2026-01-01" }

// The organisation and the customers as the store has them when the agreements load.
const copenhagenRecord = projectAdapter.toRecord(copenhagen, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW })
const customerRecords = [mikkel, osterbro, kab].map((customer) => customerAdapter.toRecord(customer, { fixtures: customerFixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id]]) }, 1)],
  ["customers.contacts", loaded({ records: customerRecords, serverIds: new Map(customerRecords.map((record, index) => [record.id, [mikkel, osterbro, kab][index].id])) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures: agreementFixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

/** The agreements module as the store holds it once loaded, for the subscriptions that name an agreement and for a write's context. */
function withAgreements(agreements: readonly Agreement[], base: ServerRecordsState = state): ServerRecordsState {
  const records = agreements.map((agreement) => agreementAdapter.toRecord(agreement, context()))
  return new Map([...base, ["customers.agreements", loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, agreements[index].id])) }, 1)]])
}
const loadedState = withAgreements([agr2408, agr2188, agrDraft])
const resolveLoaded = resolverOver(loadedState)

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** A record the generic create path makes from the agreement form, before the API has answered. */
function madeAgreement(values: Record<string, string>, status = "Draft"): BusinessRecord {
  return {
    id: "agreements-agreement-1700000000000",
    name: values.agreementNumber ?? "Agreement · 1700000000000",
    context: "",
    status,
    owner: "Olivia Larsen",
    value: "Create draft agreement",
    updated: "Now",
    description: "",
    facts: {},
    related: [],
    source: "Office workspace",
    freshness: "Now",
    companyId: FIXTURE_COMPANY_ID,
    projectIds: [FIXTURE_PROJECT_IDS.copenhagen],
    recordKind: "Agreement",
    submittedValues: values,
  }
}

const AGREEMENT_FORM: Record<string, string> = {
  projectId: FIXTURE_PROJECT_IDS.copenhagen,
  source: "manual",
  agreementNumber: "AGR-3001",
  customerId: "company-osterbro-housing",
  payerId: "company-osterbro-housing",
  effectiveFrom: "2026-10-01",
  effectiveTo: "2026-12-31",
  billingCadence: "monthly",
  currency: "DKK",
  internalNotes: "Signed at the housing fair",
}

/** A record the generic create path makes from the subscription form (lib/data/agreements.ts), under an agreement. */
function madeSubscription(values: Record<string, string>): BusinessRecord {
  return { ...madeAgreement(values, "Active"), id: "agreements-subscription-1700000000000", name: "Subscription · 1700000000000", recordKind: SUBSCRIPTION_RECORD_KIND, submittedValues: values }
}

const SUBSCRIPTION_FORM = {
  agreementId: "agreement-2408",
  productId: `product-${PRODUCT}`,
  propertyId: `property-${PROPERTY}`,
  sharedPointId: "",
  quantity: "2",
  validFrom: "2026-10-01",
  validTo: "2026-12-31",
}

describe("the agreements module", () => {
  test("is switched, after the organisation its agreements are scoped by and the customers they name", () => {
    assert.ok(isServerBacked("customers", "agreements"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("customers.agreements") > SERVER_MODULE_KEYS.indexOf("configure.organization"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("customers.agreements") > SERVER_MODULE_KEYS.indexOf("customers.contacts"))
    assert.deepEqual(agreementsModule.resources, [agreementAdapter, subscriptionAdapter], "the agreements before the subscriptions that name them")
  })

  test("loads the agreements and the subscriptions across them in two lists, files each under its own prefix, and lends a fixture's id to the agreement of its number", async () => {
    const { fetch, calls } = scripted([() => pageOf([agr2408, agr2512, agr2188]), () => pageOf([sub1, sub2])])
    const result = await loadModule(clientOver(fetch), agreementsModule, { fixtures: agreementFixtures, state, now: NOW })
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/agreements?limit=200", "http://api.test/subscriptions?limit=200"],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      ["agreement-2408", "agreement-2512", `agreement-${agr2188.id}`, `subscription-${sub1.id}`, `subscription-${sub2.id}`],
    )
    assert.equal(result.serverIds.get("agreement-2408"), agr2408.id)
    assert.equal(result.serverIds.get(`subscription-${sub1.id}`), sub1.id)
    const subscription = result.records.find((record) => record.id === `subscription-${sub1.id}`)
    assert.equal(subscription?.facts.Agreement, "AGR-2408", "a subscription names its agreement through the rows loaded before it")
    assert.equal(subscription?.submittedValues?.agreementId, "agreement-2408", "by the web id the store knows the agreement under")
    const harbor = result.records.find((record) => record.id === "agreement-2512")
    assert.deepEqual(harbor?.projectIds, [`project-${HARBOR}`], "a project the store has not loaded is named by its id")
  })
})

describe("an agreement", () => {
  test("is the fixture of its number, the wire's fields over it and none of the fixture's facts, scoped to its project", () => {
    const record = agreementAdapter.toRecord(agr2408, context())
    assert.equal(record.id, "agreement-2408")
    assert.equal(record.name, "AGR-2408 · Østerbro Housing")
    assert.equal(record.context, "Østerbro Housing · same payer")
    assert.equal(record.status, "Active")
    assert.equal(record.value, "2026-01-01 – 2026-12-31", "the form's last day in force, not the wire's first day out")
    assert.equal(record.recordKind, "Agreement")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.equal(record.owner, "Contract Team", "the fixture's presentation is inherited")
    assert.equal(record.facts.Template, undefined, "a fact the wire does not carry is not shown as the API's")
    assert.deepEqual(record.facts, {
      Kind: "Agreement",
      Number: "AGR-2408",
      Customer: "Østerbro Housing",
      Payer: "Østerbro Housing",
      Project: "Copenhagen Central",
      Billing: "Monthly",
      Currency: "DKK",
      "Valid from": "2026-01-01",
      "Valid to": "2026-12-31",
    })
    assert.deepEqual(record.related, ["Østerbro Housing"])
    assert.deepEqual(record.allowedTransitions, ["Cancelled"])
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      agreementNumber: "AGR-2408",
      customerId: "company-osterbro-housing",
      payerId: "company-osterbro-housing",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      billingCadence: "monthly",
      currency: "DKK",
    })
    assert.equal(record.updated, "5 days ago")
    assert.ok(agreementAdapter.owns(record))
    assert.ok(!subscriptionAdapter.owns(record))
  })

  test("an agreement no fixture numbers is `agreement-<uuid>`; its payer is named when another customer pays, and its period runs open", () => {
    const record = agreementAdapter.toRecord(agr2188, context())
    assert.equal(record.id, `agreement-${agr2188.id}`)
    assert.equal(record.name, "AGR-2188 · Mikkel Sørensen")
    assert.equal(record.context, "Mikkel Sørensen · payer KAB Bolig")
    assert.equal(record.value, "2026-01-01 – open")
    assert.equal(record.facts.Payer, "KAB Bolig")
    assert.equal(record.facts["Valid to"], undefined)
    assert.deepEqual(record.related, ["Mikkel Sørensen", "KAB Bolig"])
    assert.equal(record.owner, "")
    assert.equal(record.submittedValues?.customerId, "contact-mikkel")
    assert.equal(record.submittedValues?.payerId, `company-${kab.id}`)
    assert.equal(record.submittedValues?.effectiveTo, undefined)
  })

  test("a draft offers Active and Cancelled, an active one Cancelled, a cancelled one nothing; the notes and the price list travel as facts", () => {
    const draft = agreementAdapter.toRecord(agrDraft, context())
    assert.equal(draft.status, "Draft")
    assert.deepEqual(draft.allowedTransitions, ["Active", "Cancelled"])
    assert.equal(draft.facts.Notes, "Payer to be confirmed")
    assert.equal(draft.submittedValues?.internalNotes, "Payer to be confirmed")
    assert.equal(draft.facts["Price list"], `price-list-${agrDraft.priceListId}`, "an id chip until the price lists are switched")
    assert.equal(draft.submittedValues?.priceListId, undefined, "the form's price list options are names, so the id is never seeded into it")
    const cancelled = agreementAdapter.toRecord(agrCancelled, context())
    assert.equal(cancelled.status, "Cancelled")
    assert.deepEqual(cancelled.allowedTransitions, [])
  })

  test("says exactly the wire's three statuses, so the store spells Cancelled and refuses Expired and Terminated before the API", () => {
    assert.deepEqual(AGREEMENT_STATUSES, ["draft", "active", "cancelled"])
    assert.deepEqual(agreementAdapter.statuses, AGREEMENT_STATUSES)
    const record = agreementAdapter.toRecord(agr2408, context())
    assert.ok(spellsStatus(agreementsModule, record, "Cancelled"))
    assert.ok(spellsStatus(agreementsModule, record, "Draft"))
    assert.ok(!spellsStatus(agreementsModule, record, "Expired"))
    assert.ok(!spellsStatus(agreementsModule, record, "Terminated"))
    assert.ok(!spellsStatus(agreementsModule, record, "Pending"))
  })

  test("the form's record becomes an AgreementCreate the contract accepts: the project, the customer and the payer by server id, the end as the first day out", () => {
    const body = agreementAdapter.toCreateBody?.(madeAgreement(AGREEMENT_FORM), context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      number: "AGR-3001",
      customerId: osterbro.id,
      payerCustomerId: osterbro.id,
      billingCadence: "monthly",
      currency: "DKK",
      notes: "Signed at the housing fair",
      validFrom: "2026-10-01",
      validTo: "2027-01-01",
    })
    const parsed = AgreementCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
    assert.equal(parsed.data?.status, "draft", "a create says no status, so the API's default stands")
    const active = agreementAdapter.toCreateBody?.(madeAgreement({ ...AGREEMENT_FORM, effectiveTo: "", internalNotes: "" }, "Active"), context()) as Record<string, unknown>
    assert.equal(active.status, "active")
    assert.equal(active.validTo, undefined)
    assert.equal(active.notes, undefined)
    assert.ok(AgreementCreate.safeParse(active).success)
  })

  test("is refused here, naming the field, without a project, a customer or a payer the store holds, a number, a start, a cadence or a currency", () => {
    const made = (values: Record<string, string>) => agreementAdapter.toCreateBody?.(madeAgreement({ ...AGREEMENT_FORM, ...values }), context())
    assert.deepEqual(made({ projectId: "project-nowhere" }), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(made({ customerId: "company-nowhere" }), { path: "customerId", message: "Pick a customer the API holds" })
    assert.deepEqual(made({ payerId: "" }), { path: "payerId", message: "Pick a payer the API holds" })
    assert.deepEqual(made({ agreementNumber: " " }), { path: "agreementNumber", message: "An agreement needs a number" })
    assert.deepEqual(made({ effectiveFrom: "" }), { path: "effectiveFrom", message: "An agreement needs the first day it is in force" })
    assert.deepEqual(made({ billingCadence: "" }), { path: "billingCadence", message: "Pick a billing cadence" })
    assert.deepEqual(made({ currency: "" }), { path: "currency", message: "Pick a currency" })
  })

  test("a product named on the agreement form is refused: a subscription is its own row, added once the agreement is saved", () => {
    const body = agreementAdapter.toCreateBody?.(madeAgreement({ ...AGREEMENT_FORM, productId: "product-res-240" }), context())
    assert.deepEqual(body, { path: "productId", message: INITIAL_SUBSCRIPTION_REFUSAL })
  })

  test("a patch says what moved — a status, a cleared end as null, another payer by server id, emptied notes — and the contract accepts it", () => {
    const record = agreementAdapter.toRecord(agrDraft, context())
    const activated: BusinessRecord = { ...record, status: "Active" }
    assert.deepEqual(agreementAdapter.toPatchBody(record, activated, context()), { status: "active" })
    const running = agreementAdapter.toRecord(agr2408, context())
    const reopened: BusinessRecord = { ...running, submittedValues: { ...running.submittedValues, effectiveTo: "" } }
    assert.deepEqual(agreementAdapter.toPatchBody(running, reopened, context()), { validTo: null })
    const repaid: BusinessRecord = { ...running, submittedValues: { ...running.submittedValues, payerId: `company-${kab.id}`, internalNotes: "" } }
    const body = agreementAdapter.toPatchBody(running, repaid, context())
    assert.deepEqual(body, { payerCustomerId: kab.id })
    assert.ok(AgreementPatch.safeParse(body).success)
    const noted: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, internalNotes: "" } }
    assert.deepEqual(agreementAdapter.toPatchBody(record, noted, context()), { notes: null })
    const ended: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, effectiveTo: "2026-12-31", agreementNumber: "AGR-2700-B" } }
    const both = agreementAdapter.toPatchBody(record, ended, context())
    assert.deepEqual(both, { number: "AGR-2700-B", validTo: "2027-01-01" })
    assert.ok(AgreementPatch.safeParse(both).success)
    assert.equal(agreementAdapter.toPatchBody(record, record, context()), null)
  })

  test("a patch is refused for a project moved, a customer the store does not hold, or a product named on the agreement form", () => {
    const record = agreementAdapter.toRecord(agr2408, context())
    const moved: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, projectId: "project-harbor" } }
    assert.deepEqual(agreementAdapter.toPatchBody(record, moved, context()), { path: "projectId", message: "An agreement stays in its project" })
    const lost: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, customerId: "company-nowhere" } }
    assert.deepEqual(agreementAdapter.toPatchBody(record, lost, context()), { path: "customerId", message: "Pick a customer the API holds" })
    const subscribed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, productId: "product-res-240" } }
    assert.deepEqual(agreementAdapter.toPatchBody(record, subscribed, context()), { path: "productId", message: INITIAL_SUBSCRIPTION_REFUSAL }, "the same rule on the edit as on the create")
  })

  test("through the store's write, a create posts and the API's 409 for an inactive customer comes back as its sentence", async () => {
    const made = madeAgreement(AGREEMENT_FORM)
    const created: Agreement = { ...agrDraft, id: "019995e0-0000-7000-8000-0000000000a1", number: "AGR-3001", notes: "Signed at the housing fair", priceListId: null, validTo: "2027-01-01" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/agreements/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), agreementsModule, current, made, { fixtures: agreementFixtures, state, now: NOW })
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].url, "http://api.test/agreements")
    assert.ok(AgreementCreate.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, created.id)
    assert.equal(outcome.record.name, "AGR-3001 · Østerbro Housing")
    assert.equal(outcome.record.status, "Draft")

    const refused = scripted([() => problem(409, "The customer is inactive; an agreement needs an active customer")])
    const answer = await writeRecord(clientOver(refused.fetch), agreementsModule, current, made, { fixtures: agreementFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), "The customer is inactive; an agreement needs an active customer")
  })

  test("the update patches the row's own route", async () => {
    const { fetch, calls } = scripted([() => json({ ...agrDraft, status: "active" })])
    const answer = await agreementAdapter.update(clientOver(fetch), agrDraft.id, { status: "active" })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/agreements/${agrDraft.id}`])
    assert.deepEqual(bodyOf(calls[0]), { status: "active" })
    assert.equal(answer.status, "active")
  })
})

describe("a subscription", () => {
  test("is a row under its agreement's web id, its product and its place as id chips, its status a reading of its period on the project's day", () => {
    const record = subscriptionAdapter.toRecord(sub1, context(resolveLoaded))
    assert.equal(record.id, `subscription-${sub1.id}`)
    assert.equal(record.name, `AGR-2408 · product-${PRODUCT}`)
    assert.equal(record.context, "Østerbro Housing · same payer", "the agreement's customer and payer, the column the module shows")
    assert.equal(record.status, "Active")
    assert.equal(record.value, "2026-01-01 – 2026-12-31")
    assert.equal(record.recordKind, SUBSCRIPTION_RECORD_KIND)
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.deepEqual(record.facts, {
      Kind: "Subscription",
      Agreement: "AGR-2408",
      Product: `product-${PRODUCT}`,
      Property: `property-${PROPERTY}`,
      Quantity: "1",
      "Valid from": "2026-01-01",
      "Valid to": "2026-12-31",
    })
    assert.deepEqual(record.related, ["AGR-2408 · Østerbro Housing", `product-${PRODUCT}`, `property-${PROPERTY}`])
    assert.deepEqual(record.submittedValues, {
      agreementId: "agreement-2408",
      productId: `product-${PRODUCT}`,
      propertyId: `property-${PROPERTY}`,
      quantity: "1",
      validFrom: "2026-01-01",
      validTo: "2026-12-31",
    })
    assert.equal(subscriptionAdapter.statuses, undefined, "no status is on the wire, so every move is refused")
    assert.ok(!spellsStatus(agreementsModule, record, "Expired"))
    assert.ok(subscriptionAdapter.owns(record))
    assert.ok(!agreementAdapter.owns(record))
  })

  test("at a shared collection point it names the point; one not yet in force is Pending and one that ended is Expired", () => {
    const pending = subscriptionAdapter.toRecord(sub2, context(resolveLoaded))
    assert.equal(pending.status, "Pending")
    assert.equal(pending.value, "2026-11-01 – open")
    assert.equal(pending.facts.Property, undefined)
    assert.equal(pending.facts["Shared collection point"], `shared-point-${POINT}`)
    assert.equal(pending.facts.Quantity, "2")
    assert.equal(pending.submittedValues?.propertyId, undefined)
    assert.equal(pending.submittedValues?.sharedPointId, `shared-point-${POINT}`)
    assert.equal(pending.submittedValues?.validTo, undefined)
    assert.equal(subscriptionAdapter.toRecord(subEnded, context(resolveLoaded)).status, "Expired")
  })

  test("names its product by the row the store knows once the products module is switched, and its agreement by id when the agreements are not loaded", () => {
    const productRecord = { ...customerRecords[0], id: "product-res-240", name: "Residual waste · 240L bin" }
    const withProducts: ServerRecordsState = new Map([...loadedState, ["commercial.products", loaded({ records: [productRecord], serverIds: new Map([[productRecord.id, PRODUCT]]) }, 1)]])
    const record = subscriptionAdapter.toRecord(sub1, context(resolverOver(withProducts)))
    assert.equal(record.name, "AGR-2408 · Residual waste · 240L bin")
    assert.equal(record.facts.Product, "Residual waste · 240L bin")
    assert.equal(record.submittedValues?.productId, "product-res-240")
    const orphan = subscriptionAdapter.toRecord(sub1, context())
    assert.equal(orphan.submittedValues?.agreementId, `agreement-${agr2408.id}`)
    assert.equal(orphan.facts.Agreement, `agreement-${agr2408.id}`)
    assert.equal(orphan.name, `agreement-${agr2408.id} · product-${PRODUCT}`)
  })

  test("the form's record becomes a SubscriptionCreate the contract accepts, posted under the agreement's server id: the chips as ids, the end as the first day out", () => {
    const write = subscriptionAdapter.toCreateBody?.(madeSubscription(SUBSCRIPTION_FORM), context(resolveLoaded)) as { agreementId: string; body: unknown }
    assert.equal(write.agreementId, agr2408.id)
    assert.deepEqual(write.body, { productId: PRODUCT, propertyId: PROPERTY, quantity: 2, validFrom: "2026-10-01", validTo: "2027-01-01" })
    assert.ok(SubscriptionCreate.safeParse(write.body).success)
    const bare = subscriptionAdapter.toCreateBody?.(madeSubscription({ ...SUBSCRIPTION_FORM, productId: PRODUCT.toUpperCase(), propertyId: "", sharedPointId: POINT, quantity: "", validTo: "" }), context(resolveLoaded)) as { body: unknown }
    assert.deepEqual(bare.body, { productId: PRODUCT, sharedCollectionPointId: POINT, validFrom: "2026-10-01" }, "a bare id is taken as the row's, a blank quantity leaves the API's default")
    assert.ok(SubscriptionCreate.safeParse(bare.body).success)
  })

  test("names its product through the store's resolver once the products module is switched", () => {
    const productRecord = { ...customerRecords[0], id: "product-res-240", name: "Residual waste · 240L bin" }
    const withProducts: ServerRecordsState = new Map([...loadedState, ["commercial.products", loaded({ records: [productRecord], serverIds: new Map([[productRecord.id, PRODUCT]]) }, 1)]])
    const write = subscriptionAdapter.toCreateBody?.(madeSubscription({ ...SUBSCRIPTION_FORM, productId: "product-res-240" }), context(resolverOver(withProducts))) as { body: { productId: string } }
    assert.equal(write.body.productId, PRODUCT)
  })

  test("is refused here, naming the field, for an agreement or a product the API does not hold, a place that is not one, a quantity that is no count, or no start", () => {
    const made = (values: Partial<typeof SUBSCRIPTION_FORM>) => subscriptionAdapter.toCreateBody?.(madeSubscription({ ...SUBSCRIPTION_FORM, ...values }), context(resolveLoaded))
    assert.deepEqual(made({ agreementId: "agreement-nowhere" }), { path: "agreementId", message: "Pick an agreement the API holds" })
    assert.deepEqual(
      made({ agreementId: "agreements-agreement-1700000000000" }),
      { path: "agreementId", message: "The agreement is not on the API yet: wait for it to be saved, then try again" },
      "an agreement the workspace minted whose create has not answered is told to wait, not that the API lacks it",
    )
    assert.deepEqual(made({ productId: "product-res-240" }), { path: "productId", message: "Pick a product the API holds" })
    assert.deepEqual(made({ productId: "" }), { path: "productId", message: "Pick a product the API holds" })
    assert.deepEqual(made({ propertyId: "", sharedPointId: "" }), { path: "propertyId", message: ONE_PLACE })
    assert.deepEqual(made({ sharedPointId: `shared-point-${POINT}` }), { path: "propertyId", message: ONE_PLACE }, "both places named is not one place")
    assert.deepEqual(made({ propertyId: "property-parkvej-18" }), { path: "propertyId", message: "Pick a property the API holds" })
    assert.deepEqual(made({ propertyId: "", sharedPointId: "shared-point-kongens-nytorv" }), { path: "sharedPointId", message: "Pick a shared collection point the API holds" })
    assert.deepEqual(made({ quantity: "0" }), { path: "quantity", message: "A quantity is a whole number, 1 or more" })
    assert.deepEqual(made({ quantity: "1.5" }), { path: "quantity", message: "A quantity is a whole number, 1 or more" })
    assert.deepEqual(made({ validFrom: "" }), { path: "validFrom", message: "A subscription needs the first day it is in force" })
  })

  test("a patch carries the quantity and the period alone — a cleared end as null — and the product, the place and the agreement do not move", () => {
    const record = subscriptionAdapter.toRecord(sub1, context(resolveLoaded))
    const more: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, quantity: "3" } }
    const body = subscriptionAdapter.toPatchBody(record, more, context(resolveLoaded))
    assert.deepEqual(body, { quantity: 3 })
    assert.ok(SubscriptionPatch.safeParse(body).success)
    const reopened: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, validTo: "", validFrom: "2026-02-01" } }
    const period = subscriptionAdapter.toPatchBody(record, reopened, context(resolveLoaded))
    assert.deepEqual(period, { validFrom: "2026-02-01", validTo: null })
    assert.ok(SubscriptionPatch.safeParse(period).success)
    assert.equal(subscriptionAdapter.toPatchBody(record, record, context(resolveLoaded)), null)
    const miscounted: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, quantity: "0" } }
    assert.deepEqual(subscriptionAdapter.toPatchBody(record, miscounted, context(resolveLoaded)), { path: "quantity", message: "A quantity is a whole number, 1 or more" })
    const resold: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, productId: `product-${POINT}` } }
    assert.deepEqual(subscriptionAdapter.toPatchBody(record, resold, context(resolveLoaded)), { path: "productId", message: "A subscription keeps its product: end this one and add another" })
    const relocated: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, propertyId: "", sharedPointId: `shared-point-${POINT}` } }
    assert.deepEqual(subscriptionAdapter.toPatchBody(record, relocated, context(resolveLoaded)), { path: "propertyId", message: "A subscription keeps its place: end this one and add another" })
    const reassigned: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, agreementId: `agreement-${agr2188.id}` } }
    assert.deepEqual(subscriptionAdapter.toPatchBody(record, reassigned, context(resolveLoaded)), { path: "agreementId", message: "A subscription stays under its agreement" })
  })

  test("an edit of the row the workspace minted — its product and place the bare ids the form took — moves nothing but what changed", () => {
    // The store's row, as the API answered it, and the optimistic row the
    // sheet still holds, whose typed values are the form's own: the same
    // product and place, spelled as a bare id rather than a chip.
    const stored = subscriptionAdapter.toRecord({ ...sub1, quantity: 2, validFrom: "2026-10-01" }, context(resolveLoaded))
    const typedBare = { ...SUBSCRIPTION_FORM, productId: PRODUCT, propertyId: PROPERTY.toUpperCase() }
    const minted: BusinessRecord = { ...stored, id: "agreements-subscription-1700000000000", submittedValues: { ...typedBare, quantity: "3" } }
    const body = subscriptionAdapter.toPatchBody(stored, minted, context(resolveLoaded))
    assert.deepEqual(body, { quantity: 3 })
    const relocated: BusinessRecord = { ...minted, submittedValues: { ...typedBare, propertyId: "", sharedPointId: POINT } }
    assert.deepEqual(subscriptionAdapter.toPatchBody(stored, relocated, context(resolveLoaded)), { path: "propertyId", message: "A subscription keeps its place: end this one and add another" })
  })

  test("through the store's write, a create posts under the agreement and a change patches the subscription's own route", async () => {
    const made = madeSubscription(SUBSCRIPTION_FORM)
    const created: Subscription = { ...sub1, id: "019995e0-0000-7000-8000-0000000000b1", quantity: 2, validFrom: "2026-10-01" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/subscriptions/${created.id}` })])
    const current = loadedState.get("customers.agreements")
    if (current === undefined) throw new Error("the agreements are not loaded")
    const outcome = await writeRecord(clientOver(fetch), agreementsModule, current, made, { fixtures: agreementFixtures, state: loadedState, now: NOW })
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].url, `http://api.test/agreements/${agr2408.id}/subscriptions`)
    assert.deepEqual(bodyOf(calls[0]), { productId: PRODUCT, propertyId: PROPERTY, quantity: 2, validFrom: "2026-10-01", validTo: "2027-01-01" })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, created.id)
    assert.equal(outcome.record.name, `AGR-2408 · product-${PRODUCT}`)
    assert.equal(outcome.record.facts.Quantity, "2")

    const refused = scripted([() => problem(409, "The product is draft; only an active product can be subscribed to")])
    const answer = await writeRecord(clientOver(refused.fetch), agreementsModule, current, made, { fixtures: agreementFixtures, state: loadedState, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), "The product is draft; only an active product can be subscribed to")

    const patched = scripted([() => json({ ...sub1, quantity: 3 })])
    const answer2 = await subscriptionAdapter.update(clientOver(patched.fetch), sub1.id, { quantity: 3 })
    assert.deepEqual(patched.calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/subscriptions/${sub1.id}`])
    assert.equal(answer2.quantity, 3)
  })
})
