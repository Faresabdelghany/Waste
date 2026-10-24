// Service provider prices and settlements on the prototype's records (Issue
// #186, slice 11 of #81, for #148): what a provider is paid per unit of a
// product under its assignment (`@waste/contracts/service-provider-prices`,
// routes apps/api/src/routes/service-provider-prices.ts) as
// `commercial.service-provider-prices`, and what it is paid over a period
// (`settlements.ts`, routes settlements.ts) as `commercial.settlements`,
// retitled "Settlements" as the glossary has it. The contracts are imported
// as types only, so no zod reaches the bundle.
//
// A price names its assignment — the provider and the area at once, rows of
// the service areas module loaded before — and its product; its bid is the
// contract's and locked, and its fee moves by indexation alone: Apply index is
// a create of this module that names the row it indexes (`POST /service-
// provider-prices/:id/index`), whose answer is the chain's next row from the
// day it applies, the indexed row ended on it (the surface reads the module
// again). An edit moves the notes and the end alone. Money is minor units on
// the wire, in the project's currency.
//
// A settlement settles an assignment's period: opened over it, then moved by
// its three commands — calculate, close, reopen with the reason the history
// keeps — and offered only where the domain's `settlementTransition` moves it
// (a stay is the API's answer to a retry, not an offer; #182's decision 5).
// Its lines settle billable events, each priced by the provider price in force
// on the event's service date; a line no price covers blocks close, which the
// record says. Nothing else changes on a settlement: every patch is refused.
//
// Ids, rule (b) of #81's plan closing with this slice: `provider-price-<uuid>`
// and `settlement-<uuid>`; no fixture lends its id.
import type { ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import type { Settlement, SettlementDetail, SettlementEvent } from "@waste/contracts/settlements"
import { SETTLEMENT_COMMANDS, settlementTransition, type SettlementCommand } from "@waste/domain/finance/transitions"
import { INDEX_BASES, type SettlementStatus } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import { formatMinor, majorOf, minorOf } from "@/lib/commercial/money"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { isProductRecord, PRODUCT_PREFIX, UNIT_SUFFIX } from "@/lib/data/commercial"
import {
  ASSIGNMENT_PREFIX,
  INDEXED_PRICE_RECORD_KIND,
  isAssignmentRecord,
  isProviderPriceRecord,
  isSettlementRecord,
  periodReading,
  PROVIDER_PRICE_PREFIX,
  PROVIDER_PRICE_RECORD_KIND,
  PROVIDER_PRICES_MODULE,
  SETTLEMENT_PREFIX,
  SETTLEMENT_RECORD_KIND,
  SETTLEMENTS_MODULE,
} from "@/lib/data/provider-money"

import { command, create, get, listAll, patch } from "../client"
import { inheritedPresentation, patchOf, said, stampFacts, statusLabel, typed, webIdOf, type Client, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { firstDayOut, lastDayIn } from "./planning"
import { projectDay } from "./pricing"
import { referenced, refusal } from "./places"
import { nameVia, referencedServerId } from "./references"

/** What a change that is no index or no whole percent with at most two decimals is told. */
export const INDEX_REFUSAL = "Give the change as a percent with at most two decimals, such as 5 or -1.25"
const PRICE_KEY_REFUSAL = "The fee moves by Apply index and the bid never: end this price and add another for anything else"

/** The assignment a record names under `key`, loaded: its server id and its record; undefined where the store holds none. */
function assignmentOf(record: BusinessRecord, key: string, context: MappingContext): { serverId: string; record: BusinessRecord } | undefined {
  const webId = typed(record, key)
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  const assignment = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  return serverId === undefined || assignment === undefined || !isAssignmentRecord(assignment) ? undefined : { serverId, record: assignment }
}

/** The currency and the timezone of the project a record or an assignment is in, from the organisation the store loaded. */
function projectFacts(projectWebId: string | undefined, context: MappingContext): { currency?: string; timezone?: string } {
  const serverId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
  const project = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  return project === undefined ? {} : { currency: typed(project, "currency"), timezone: typed(project, "timezone") }
}

/** The assignment's name and provider as a row names them: "CA-Ø-2 · NordRen ApS", "NordRen ApS"; the id chip where the store holds none. */
function assignmentNames(serverId: string, context: MappingContext): { name: string; provider: string; area?: string } {
  const record = context.resolve.byServerId(serverId)
  if (record === undefined) {
    const chip = webIdOf(ASSIGNMENT_PREFIX, serverId)
    return { name: chip, provider: chip }
  }
  return { name: record.name, provider: record.facts["Service provider"] ?? record.name, area: record.facts["Service area"] }
}

// ---------------------------------------------------------------------------
// Service provider prices
// ---------------------------------------------------------------------------

/**
 * A change typed as a percent, as basis points: `5` is 500, `-1.25` is -125.
 * NaN for anything else. No float: the digits are read as integers.
 */
export function basisPointsOf(text: string): number {
  const match = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(text.trim())
  if (match === null) return Number.NaN
  const [, sign, whole, fraction = ""] = match
  const points = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0")
  return sign === "-" ? -points : points
}

/** Basis points as a signed percent: 500 is `+5%`, -125 is `-1.25%`. */
const percentLabel = (points: number) => `${points < 0 ? "-" : "+"}${(Math.abs(points) / 100).toFixed(2).replace(/\.?0+$/, "")}%`

/** What Apply index's create carries: the row it indexes, and the body the contract accepts; a chain's first row is its body alone. */
type IndexWrite = { indexes: string; body: unknown }

export const providerPriceAdapter: ResourceAdapter<ServiceProviderPrice> = {
  prefix: PROVIDER_PRICE_PREFIX,
  owns: isProviderPriceRecord,
  // No status on the wire: the record's is a reading of its period.
  statuses: undefined,
  list: (client) => listAll<ServiceProviderPrice>(client, "/service-provider-prices"),
  read: (client, serverId) => get<ServiceProviderPrice>(client, `/service-provider-prices/${serverId}`),
  toRecord: (price, context) => {
    const assignment = assignmentNames(price.serviceAreaAssignmentId, context)
    const assignmentRecord = context.resolve.byServerId(price.serviceAreaAssignmentId)
    const assignmentWebId = assignmentRecord?.id ?? webIdOf(ASSIGNMENT_PREFIX, price.serviceAreaAssignmentId)
    const providerWebId = assignmentRecord === undefined ? undefined : typed(assignmentRecord, "serviceProviderId")
    const product = referenced(context, PRODUCT_PREFIX, price.productId)
    const productRecord = context.resolve.byServerId(price.productId)
    const unit = PRODUCT_UNITS.find((candidate) => candidate === (productRecord === undefined ? undefined : typed(productRecord, "priceUnit")))
    const productName = product.name ?? product.webId
    const project = referenced(context, "project", price.projectId)
    const lastDay = price.validTo === null ? undefined : lastDayIn(price.validTo)
    const money = (minor: number) => formatMinor(minor, price.currency)
    const index = price.indexLabel === null || price.indexBasisPoints === null ? undefined : `${price.indexLabel} ${percentLabel(price.indexBasisPoints)} on the ${price.indexBase === "current-fee" ? "current fee" : "bid"}`
    return {
      id: webIdOf(PROVIDER_PRICE_PREFIX, price.id),
      name: `${productName} · ${assignment.provider}`,
      context: assignment.name,
      status: periodReading(price.validFrom, price.validTo, projectDay(price.projectId, context)),
      ...inheritedPresentation(undefined),
      ...stampFacts(price, context.now),
      value: `${money(price.unitPriceMinor)}${unit === undefined ? "" : UNIT_SUFFIX[unit]}`,
      description: `What ${assignment.provider} is paid per ${unit ?? "unit"} of ${productName} under ${assignment.name}.`,
      facts: {
        Product: productName,
        "Service provider": assignment.provider,
        ...(assignment.area === undefined ? {} : { "Service area": assignment.area }),
        Bid: money(price.bidMinor),
        Fee: money(price.unitPriceMinor),
        Currency: price.currency,
        ...(index === undefined ? {} : { Index: index }),
        "Valid from": price.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
        ...(price.notes === null ? {} : { Notes: price.notes }),
      },
      related: [assignment.name, productName],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      // Its assignment's provider: the provider page lists its prices by it.
      ...(providerWebId === undefined ? {} : { serviceProviderId: providerWebId }),
      recordKind: PROVIDER_PRICE_RECORD_KIND,
      submittedValues: {
        serviceAreaAssignmentId: assignmentWebId,
        productId: product.webId,
        bid: majorOf(price.bidMinor, price.currency),
        fee: majorOf(price.unitPriceMinor, price.currency),
        ...(price.notes === null ? {} : { notes: price.notes }),
        validFrom: price.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
        ...(price.indexedFromId === null ? {} : { indexedFromId: webIdOf(PROVIDER_PRICE_PREFIX, price.indexedFromId) }),
      },
    }
  },
  toCreateBody: (record, context) => {
    // Apply index: the next row of the chain, posted under the row it indexes.
    if (record.recordKind === INDEXED_PRICE_RECORD_KIND) {
      const indexedWebId = typed(record, "indexesPriceId")
      const indexes = indexedWebId === undefined ? undefined : referencedServerId(indexedWebId, PROVIDER_PRICE_PREFIX, context, { owns: isProviderPriceRecord })
      if (indexes === undefined) return refusal("indexesPriceId", "Pick a service provider price the API holds")
      const label = typed(record, "label")
      if (label === undefined) return refusal("label", "Name the index: CPI, fuel")
      const basisPoints = basisPointsOf(typed(record, "percent") ?? "")
      if (Number.isNaN(basisPoints)) return refusal("percent", INDEX_REFUSAL)
      const base = INDEX_BASES.find((candidate) => candidate === typed(record, "base"))
      if (base === undefined) return refusal("base", "Pick what the change multiplies: the bid or the current fee")
      const appliedFrom = typed(record, "appliedFrom")
      if (appliedFrom === undefined) return refusal("appliedFrom", "Give the first day the new fee holds")
      const write: IndexWrite = { indexes, body: { label, basisPoints, base, appliedFrom } }
      return write
    }
    const assignment = assignmentOf(record, "serviceAreaAssignmentId", context)
    if (assignment === undefined) return refusal("serviceAreaAssignmentId", "Pick a service area assignment the API holds")
    const productWebId = typed(record, "productId")
    const productId = productWebId === undefined ? undefined : referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
    if (productId === undefined) return refusal("productId", "Pick a product the API holds")
    const currency = projectFacts(assignment.record.projectIds?.[0], context).currency
    if (currency === undefined) return refusal("serviceAreaAssignmentId", "The assignment's project is not one the store holds")
    const amount = (key: string) => {
      const text = typed(record, key)
      return text === undefined ? undefined : minorOf(text, currency)
    }
    const bidMinor = amount("bid")
    if (bidMinor === undefined || Number.isNaN(bidMinor)) return refusal("bid", `An amount in ${currency}, such as ${majorOf(1850, currency)}`)
    const unitPriceMinor = amount("fee")
    if (Number.isNaN(unitPriceMinor)) return refusal("fee", `An amount in ${currency}, such as ${majorOf(1850, currency)}`)
    const validFrom = typed(record, "validFrom")
    if (validFrom === undefined) return refusal("validFrom", "A price needs the first day it holds")
    // Left open, it ends with its assignment, as the form's hint says: the API refuses an open end under a bounded assignment.
    const lastDay = typed(record, "validTo") ?? typed(assignment.record, "validTo")
    const notes = typed(record, "notes")
    return {
      serviceAreaAssignmentId: assignment.serverId,
      productId,
      bidMinor,
      // The fee is the bid when blank: a price starts at what was bid.
      ...(unitPriceMinor === undefined ? {} : { unitPriceMinor }),
      ...(notes === undefined ? {} : { notes }),
      validFrom,
      ...(lastDay === undefined ? {} : { validTo: firstDayOut(lastDay) }),
    }
  },
  toPatchBody: (before, after) => {
    for (const key of ["fee", "bid", "productId", "serviceAreaAssignmentId", "validFrom"]) {
      if (typed(before, key) !== typed(after, key)) return refusal(key, PRICE_KEY_REFUSAL)
    }
    return patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return { notes: typed(record, "notes") ?? null, validTo: lastDay === undefined ? null : firstDayOut(lastDay) }
    })
  },
  create: (client, body) => {
    const write = body as Partial<IndexWrite>
    if (write.indexes !== undefined) return create<ServiceProviderPrice>(client, `/service-provider-prices/${write.indexes}/index`, write.body).then((created) => created.body)
    return create<ServiceProviderPrice>(client, "/service-provider-prices", body).then((created) => created.body)
  },
  update: (client, serverId, body) => patch<ServiceProviderPrice>(client, `/service-provider-prices/${serverId}`, body),
}

/** Price Engine › Service Provider Prices. */
export const providerPricesModule: ServerModule = { workspaceId: PROVIDER_PRICES_MODULE.workspaceId, moduleId: PROVIDER_PRICES_MODULE.moduleId, resources: [providerPriceAdapter] }

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

/** The commands a settlement's details offer: those the machine moves it by from its status, never a stay or a refusal. */
export function settlementCommandsOffered(status: SettlementStatus): SettlementCommand[] {
  return SETTLEMENT_COMMANDS.filter((name) => settlementTransition(status, name, "").kind === "move")
}

/** `GET /settlements/:id`: the settlement with its lines, by event. */
export function settlementDetail(client: Client, serverId: string): Promise<SettlementDetail> {
  return get<SettlementDetail>(client, `/settlements/${serverId}`)
}

/** `GET /settlements/:id/events`: the settlement's history, oldest first. */
export function settlementHistory(client: Client, serverId: string): Promise<SettlementEvent[]> {
  return listAll<SettlementEvent>(client, `/settlements/${serverId}/events`)
}

/** What a patch of a settlement is told: it moves by its commands. */
export const SETTLEMENT_MOVES_BY_COMMAND = "A settlement moves by its commands: calculate, close, reopen"

const PAST: Readonly<Record<SettlementCommand, string>> = { calculate: "calculated", close: "closed", reopen: "reopened" }

export const settlementAdapter: ResourceAdapter<Settlement | SettlementDetail> = {
  prefix: SETTLEMENT_PREFIX,
  owns: isSettlementRecord,
  // Its status moves by command alone.
  statuses: undefined,
  list: (client) => listAll<SettlementDetail>(client, "/settlements"),
  read: (client, serverId) => settlementDetail(client, serverId),
  toRecord: (settlement, context) => {
    const assignment = assignmentNames(settlement.serviceAreaAssignmentId, context)
    const assignmentWebId = context.resolve.byServerId(settlement.serviceAreaAssignmentId)?.id ?? webIdOf(ASSIGNMENT_PREFIX, settlement.serviceAreaAssignmentId)
    const project = referenced(context, "project", settlement.projectId)
    const timezone = projectFacts(project.webId, context).timezone
    const lastDay = lastDayIn(settlement.validTo)
    const period = `${settlement.validFrom} – ${lastDay}`
    const unpriced = "lines" in settlement ? settlement.lines.filter((line) => line.serviceProviderPriceId === null).length : 0
    const money = (minor: number) => formatMinor(minor, settlement.currency)
    return {
      id: webIdOf(SETTLEMENT_PREFIX, settlement.id),
      name: `${assignment.provider} · ${period}`,
      context: assignment.name,
      status: statusLabel(settlement.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(settlement, context.now),
      value: money(settlement.netMinor),
      description: `What ${assignment.provider} is paid for ${assignment.name} over ${period}.`,
      facts: {
        ...(assignment.area === undefined ? {} : { "Service area": assignment.area }),
        "Service provider": assignment.provider,
        Period: period,
        Lines: String(settlement.lineCount),
        ...(unpriced === 0 ? {} : { "Unpriced lines": `${unpriced}: no provider price covers its product on its day, which blocks close` }),
        Net: money(settlement.netMinor),
        Currency: settlement.currency,
        ...(settlement.calculatedAt === null ? {} : { Calculated: shownOn(settlement.calculatedAt, timezone) }),
        ...(settlement.closedAt === null ? {} : { Closed: `${shownOn(settlement.closedAt, timezone)}${settlement.closedBy === null ? "" : ` · ${nameVia(context, "user", settlement.closedBy)}`}` }),
      },
      related: [assignment.name],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: SETTLEMENT_RECORD_KIND,
      submittedValues: { serviceAreaAssignmentId: assignmentWebId, status: settlement.status, validFrom: settlement.validFrom, validTo: lastDay },
    }
  },
  toCreateBody: (record, context) => {
    const assignment = assignmentOf(record, "serviceAreaAssignmentId", context)
    if (assignment === undefined) return refusal("serviceAreaAssignmentId", "Pick a service area assignment the API holds")
    const validFrom = typed(record, "validFrom")
    if (validFrom === undefined) return refusal("validFrom", "A settlement settles a period: give its first day")
    const lastDay = typed(record, "validTo")
    if (lastDay === undefined) return refusal("validTo", "A settlement settles a period: give its last day")
    return { serviceAreaAssignmentId: assignment.serverId, validFrom, validTo: firstDayOut(lastDay) }
  },
  toPatchBody: () => refusal("status", SETTLEMENT_MOVES_BY_COMMAND),
  create: (client, body) => create<SettlementDetail>(client, "/settlements", body).then((created) => created.body),
  // Never reached: every patch is refused above, since the wire has no patch route for a settlement.
  update: () => Promise.reject(new Error("A settlement has no patch route")),
  commands: Object.fromEntries(
    SETTLEMENT_COMMANDS.map((name) => [
      name,
      {
        toBody: (input: Readonly<Record<string, unknown>>) => {
          if (name !== "reopen") return {}
          const reason = said(input, "reason")
          return reason === undefined ? refusal("reason", "Say why the settlement is reopened: the history keeps it") : { reason }
        },
        run: (client: Client, serverId: string, body: unknown) => command<SettlementDetail>(client, `/settlements/${serverId}/${name}`, body),
        refused: (record: Pick<BusinessRecord, "name">) => `${record.name} was not ${PAST[name]}`,
      },
    ]),
  ),
}

/** Price Engine › Settlements. */
export const settlementsModule: ServerModule = { workspaceId: SETTLEMENTS_MODULE.workspaceId, moduleId: SETTLEMENTS_MODULE.moduleId, resources: [settlementAdapter] }
