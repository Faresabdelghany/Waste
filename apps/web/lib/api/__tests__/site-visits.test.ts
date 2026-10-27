// Recycling-centre visits on the adapters (#393, M4 of #293): a credential
// becomes a record of `customers.site-access` — named by its number and
// label, its holder's, its status read on its project's day — and the row
// the register's dialog makes becomes the body the API's contracts accept,
// held here against their zod schemas; a patch moves the label and the end
// alone. A visit becomes a record of `operate.site-visits`, read over its
// window, its charge and its fractions in words; the ledger takes no patch,
// and Void says why. The check-in's calls go through the client.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AccessCredentialCreate, AccessCredentialPatch, SiteVisitCheckIn, type AccessCredential, type SiteVisit } from "@waste/contracts/site-visits"

import { COMMAND_SURFACES } from "@/components/waste/commands/command-surfaces"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { mintedRecord } from "../../data/containers"
import { CREDENTIAL_KIND_KEY, CREDENTIAL_VALUE_KEY, SITE_ACCESS_MODULE, SITE_VISITS_MODULE } from "../../data/site-visits"
import { isLocalRefusal, NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { ACCESS_CREDENTIAL_COMMANDS, accessCredentialAdapter, BLOCK_CREDENTIAL, CREDENTIAL_LAST_DAY_KEY, CREDENTIAL_RECORD_KIND, toAccessCredentialCreateBody, toAccessCredentialPatchBody, toAccessCredentialRecord } from "../records/site-access"
import { LEDGER_KEPT, SITE_VISIT_COMMANDS, siteVisitAdapter, siteVisitsWindowFrom, toSiteVisitRecord, VOID_VISIT } from "../records/site-visits"
import { checkInVisit, readFrequentVisitors, readVisitSites, searchVisitAddresses } from "../site-visits"
import { clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2027-03-04T12:00:00Z")
const STAMPS = { createdAt: "2027-03-01T09:00:00.000Z", updatedAt: "2027-03-01T09:30:00.000Z" }
const id = (n: number) => `01a0d2a4-a280-7060-8000-0000000000${String(n).padStart(2, "0")}`
const PROJECT = id(1)

/** A resolver that holds the project alone, as `project-<id>` named Copenhagen: every other row is named by its id chip, `<prefix>-<id>`. */
const holding: Resolver = {
  ...NOTHING_RESOLVED,
  byServerId: (serverId) => (serverId === PROJECT ? ({ id: `project-${PROJECT}`, name: "Copenhagen", submittedValues: { timezone: "Europe/Copenhagen" } } as unknown as BusinessRecord) : undefined),
  serverIdOf: (webId) => (webId === `project-${PROJECT}` ? PROJECT : undefined),
}
const context: MappingContext = { fixtures: [], resolve: holding, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const householdCard: AccessCredential = {
  id: id(2),
  ...STAMPS,
  projectId: PROJECT,
  kind: "card",
  value: "H100",
  label: "Garden card",
  customerId: null,
  agreementId: null,
  propertyId: id(3),
  blockedAt: null,
  blockedReason: null,
  validFrom: "2027-01-01",
  validTo: "2028-01-01",
}
const businessPlate: AccessCredential = { ...householdCard, id: id(4), kind: "plate", value: "VAN2", label: null, propertyId: null, customerId: id(5), agreementId: id(6), validTo: null }

describe("an access credential as a record", () => {
  test("is the register's on the API, `credential-<uuid>`, by its number and label, its status on its project's day", () => {
    assert.ok(isServerBacked(SITE_ACCESS_MODULE.workspaceId, SITE_ACCESS_MODULE.moduleId))
    const record = toAccessCredentialRecord(householdCard, context)
    assert.equal(record.id, `credential-${householdCard.id}`)
    assert.deepEqual([record.name, record.status, record.value], ["H100 · Garden card", "In force", "2027-01-01 to 2027-12-31"])
    assert.equal(record.facts?.Property, `property-${id(3)}`)
    assert.equal(record.submittedValues?.[CREDENTIAL_LAST_DAY_KEY], "2027-12-31", "the end as its last day in force")
    assert.ok(accessCredentialAdapter.owns(record))
    assert.ok(accessCredentialAdapter.owns({ ...record, id: "site-access-credential-1793088183182" }), "a row the dialog has just made, by its recordKind")

    const business = toAccessCredentialRecord(businessPlate, context)
    assert.deepEqual([business.facts?.Customer, business.facts?.Agreement], [`customer-${id(5)}`, `agreement-${id(6)}`])
    assert.equal(toAccessCredentialRecord({ ...businessPlate, blockedAt: "2027-03-02T10:00:00.000Z", blockedReason: "Card reported lost" }, context).status, "Blocked")
    assert.equal(toAccessCredentialRecord({ ...businessPlate, validTo: "2027-03-04" }, context).status, "Ended", "the first day out is today")
    assert.equal(toAccessCredentialRecord({ ...businessPlate, validFrom: "2027-04-01" }, context).status, "Upcoming")

    const surface = COMMAND_SURFACES["customers.site-access"]
    assert.ok(typeof surface.primary === "function" && surface.rowActions !== undefined, "its own dialog, blocked and edited in its details")
  })

  test("the dialog's row becomes the create the contract takes: a household's by its property, a business's by its customer and agreement", () => {
    const row = (values: Record<string, string>) =>
      mintedRecord({ id: "site-access-credential-1", name: "", status: "In force", recordKind: CREDENTIAL_RECORD_KIND, values: { projectId: `project-${PROJECT}`, validFrom: "2027-03-04", ...values } })
    const household = toAccessCredentialCreateBody(row({ [CREDENTIAL_KIND_KEY]: "plate", [CREDENTIAL_VALUE_KEY]: "ab-12 345", propertyId: `property-${id(3)}`, label: "Car" }), context)
    assert.deepEqual(household, { projectId: PROJECT, kind: "plate", value: "AB12345", propertyId: id(3), label: "Car", validFrom: "2027-03-04", validTo: null })
    assert.ok(AccessCredentialCreate.safeParse(household).success)

    const business = toAccessCredentialCreateBody(row({ [CREDENTIAL_KIND_KEY]: "card", [CREDENTIAL_VALUE_KEY]: "77", customerId: `customer-${id(5)}`, agreementId: `agreement-${id(6)}`, [CREDENTIAL_LAST_DAY_KEY]: "2027-12-31" }), context)
    assert.deepEqual(business, { projectId: PROJECT, kind: "card", value: "77", customerId: id(5), agreementId: id(6), label: null, validFrom: "2027-03-04", validTo: "2028-01-01" })
    assert.ok(AccessCredentialCreate.safeParse(business).success)

    const halfABusiness = toAccessCredentialCreateBody(row({ [CREDENTIAL_KIND_KEY]: "card", [CREDENTIAL_VALUE_KEY]: "77", customerId: `customer-${id(5)}` }), context)
    assert.ok(isLocalRefusal(halfABusiness) && halfABusiness.path === "agreementId")
    const backwards = toAccessCredentialCreateBody(row({ [CREDENTIAL_KIND_KEY]: "card", [CREDENTIAL_VALUE_KEY]: "77", propertyId: `property-${id(3)}`, [CREDENTIAL_LAST_DAY_KEY]: "2027-03-01" }), context)
    assert.ok(isLocalRefusal(backwards) && backwards.path === CREDENTIAL_LAST_DAY_KEY)
  })

  test("a patch moves the label and the end alone; the kind, the number and the holder are what it is", () => {
    const before = toAccessCredentialRecord(householdCard, context)
    const moved = (values: Record<string, string>) => ({ ...before, submittedValues: { ...before.submittedValues, ...values } })
    const ended = toAccessCredentialPatchBody(before, moved({ label: "", [CREDENTIAL_LAST_DAY_KEY]: "2027-06-30" }))
    assert.deepEqual(ended, { label: null, validTo: "2027-07-01" })
    assert.ok(AccessCredentialPatch.safeParse(ended).success)
    assert.deepEqual(toAccessCredentialPatchBody(before, moved({ [CREDENTIAL_LAST_DAY_KEY]: "" })), { validTo: null }, "a cleared day reopens it")
    assert.equal(toAccessCredentialPatchBody(before, before), null)
    const renumbered = toAccessCredentialPatchBody(before, moved({ [CREDENTIAL_VALUE_KEY]: "H200" }))
    assert.ok(isLocalRefusal(renumbered) && renumbered.path === CREDENTIAL_VALUE_KEY)
  })

  test("Block says why before the API sees it; Unblock sends nothing", async () => {
    const record = toAccessCredentialRecord(householdCard, context)
    const block = ACCESS_CREDENTIAL_COMMANDS[BLOCK_CREDENTIAL]
    assert.ok(isLocalRefusal(block.toBody?.({ reason: " " }, record, context)))
    assert.deepEqual(block.toBody?.({ reason: "Card reported lost" }, record, context), { reason: "Card reported lost" })
    const { fetch, calls } = scripted([() => json({ ...householdCard, blockedAt: NOW.toISOString(), blockedReason: "Card reported lost" })])
    await block.run(clientOver(fetch), householdCard.id, { reason: "Card reported lost" })
    assert.deepEqual([calls[0].init.method, calls[0].url], ["POST", `http://api.test/access-credentials/${householdCard.id}/block`])
  })
})

const admitted: SiteVisit = {
  id: id(10),
  ...STAMPS,
  projectId: PROJECT,
  siteId: id(11),
  occurredAt: "2027-03-04T10:15:00.000Z",
  serviceDate: "2027-03-04",
  source: "staff",
  externalId: null,
  identification: "plate",
  identifierValue: "AB12345",
  credentialId: id(12),
  propertyId: id(3),
  customerId: null,
  agreementId: id(13),
  outcome: "admitted",
  refusalReason: null,
  recordedBy: id(14),
  note: null,
  wasteFractionIds: [id(15), id(16)],
  charge: { basis: "ladder", n: 3, productId: id(17) },
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
}

describe("a site visit as a record", () => {
  test("is read over its window, newest first, and is the ledger's on the API, after the modules it names", async () => {
    assert.ok(isServerBacked(SITE_VISITS_MODULE.workspaceId, SITE_VISITS_MODULE.moduleId))
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    for (const named of ["resources.drop-off-points", "configure.master", "customers.properties", "customers.contacts", "customers.agreements", "commercial.products", "configure.access"]) {
      assert.ok(at(named) < at("operate.site-visits"), `${named} before the ledger`)
    }
    assert.ok(at("customers.agreements") < at("customers.site-access"))
    const { fetch, calls } = scripted([() => json({ items: [], nextCursor: null })])
    await siteVisitAdapter.list?.(clientOver(fetch))
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/site-visits?limit=200&from=${siteVisitsWindowFrom()}`],
    )
  })

  test("names its site, its visitor, its fractions and what it was charged at; a refused one is charged nothing, a voided one says so", () => {
    const record = toSiteVisitRecord(admitted, context)
    assert.equal(record.id, `site-visit-${admitted.id}`)
    assert.equal(record.status, "Admitted")
    assert.equal(record.value, `3rd visit this year: product-${id(17)}`)
    assert.equal(record.facts?.Brought, `fraction-${id(15)}, fraction-${id(16)}`)
    assert.equal(record.facts?.Plate, "AB12345")
    assert.equal(record.facts?.Site, `drop-off-${id(11)}`)
    assert.equal(record.context, `drop-off-${id(11)} · AB12345`)

    const refused = toSiteVisitRecord({ ...admitted, outcome: "refused", refusalReason: "credential-blocked", charge: null, wasteFractionIds: [] }, context)
    assert.deepEqual([refused.status, refused.value, refused.facts?.["Refused because"], refused.facts?.Brought], ["Refused", "Not charged", "Blocked", "Nothing recorded"])
    const voided = toSiteVisitRecord({ ...admitted, voidedAt: "2027-03-04T11:00:00.000Z", voidedBy: id(14), voidReason: "Wrong plate" }, context)
    assert.deepEqual([voided.status, voided.facts?.["Voided because"]], ["Voided", "Wrong plate"])
    const byAddress = toSiteVisitRecord({ ...admitted, identification: "property", identifierValue: null, credentialId: null }, context)
    assert.equal(byAddress.context, `drop-off-${id(11)} · property-${id(3)}`)
  })

  test("takes no patch, and Void says why", async () => {
    const record = toSiteVisitRecord(admitted, context)
    const patch = siteVisitAdapter.toPatchBody(record, { ...record, name: "Another" }, context)
    assert.ok(isLocalRefusal(patch) && patch.message === LEDGER_KEPT)
    assert.equal(siteVisitAdapter.toCreateBody, undefined, "the check-in writes the ledger, never a form")
    const voidVisit = SITE_VISIT_COMMANDS[VOID_VISIT]
    assert.ok(isLocalRefusal(voidVisit.toBody?.({}, record, context)))
    const { fetch, calls } = scripted([() => json({ ...admitted, voidedAt: NOW.toISOString(), voidReason: "Wrong plate" })])
    await voidVisit.run(clientOver(fetch), admitted.id, { reason: "Wrong plate" })
    assert.deepEqual([calls[0].init.method, calls[0].url], ["POST", `http://api.test/site-visits/${admitted.id}/void`])
    const surface = COMMAND_SURFACES["operate.site-visits"]
    assert.ok(typeof surface.primary === "function" && surface.rowActions !== undefined, "the check-in and the Likely trades, and Void in its details")
  })
})

describe("the check-in's calls", () => {
  test("read the sites and the addresses by project, check a visitor in, and read the likely trades", async () => {
    const site = { id: id(11), projectId: PROJECT, code: "NRC", name: "Nordhavn Recycling Centre", wasteFractions: [{ id: id(15), name: "Garden waste" }] }
    const { fetch, calls } = scripted([
      () => json({ items: [site] }),
      () => json({ items: [{ propertyId: id(3), projectId: PROJECT, name: "Parkvej 1", address: "Parkvej 1, 2100" }] }),
      () => json({ visit: admitted, charge: null }, 201),
      () => json({ projectId: PROJECT, on: "2027-03-04", ruleId: null, threshold: null, windowDays: null, items: [] }),
    ])
    const client = clientOver(fetch)
    assert.deepEqual(await readVisitSites(client, PROJECT), [site])
    assert.equal((await searchVisitAddresses(client, PROJECT, "park vej")).length, 1)
    const body = { siteId: id(11), identifier: { kind: "plate" as const, value: "AB12345" }, wasteFractionIds: [id(15)] }
    assert.ok(SiteVisitCheckIn.safeParse(body).success)
    assert.equal((await checkInVisit(client, body)).visit.id, admitted.id)
    assert.equal((await readFrequentVisitors(client, PROJECT)).items.length, 0)
    assert.deepEqual(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
      [
        `GET http://api.test/site-visits/sites?projectId=${PROJECT}`,
        `GET http://api.test/site-visits/addresses?projectId=${PROJECT}&q=park+vej`,
        "POST http://api.test/site-visits",
        `GET http://api.test/site-visits/frequent?projectId=${PROJECT}`,
      ],
    )
  })
})
