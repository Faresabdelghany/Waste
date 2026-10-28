// Operate › Site visits on the API (#393, M4 of #293): the ledger of
// arrivals at a project's recycling centres, `site-visit-<uuid>` from the
// start, newest first over a window of days. A visit names its site, its
// Property or its Customer and Agreement, its fractions and the attendant
// through the store's resolver; it is admitted or refused with the reason,
// and what it was charged at when it was recorded. The ledger is written by
// the attendant's check-in (`/check-in`, lib/api/site-visits.ts) and the
// gate, never by a form: the adapter makes no row and refuses every patch,
// and a mistake is voided with why — `void` — never edited or deleted. The
// words are lib/data/site-visits.ts'; the routes
// apps/api/src/routes/site-visits.ts.
import type { SiteVisit } from "@waste/contracts/site-visits"

import { AGREEMENT_PREFIX, PROPERTY_PREFIX } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { PRODUCT_PREFIX } from "@/lib/data/commercial"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"
import { chargeBasisSentence, IDENTIFICATION_LABELS, OUTCOME_LABELS, REFUSAL_LABELS, SITE_VISITS_MODULE, SOURCE_LABELS, VISIT_VOIDED_KEY, visitStatusOf } from "@/lib/data/site-visits"

import { command, get, listAll, type ApiClient } from "../client"
import { inheritedPresentation, ofKind, stampFacts, webIdOf, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayAndTimeOn, projectTimezoneOf } from "./clock"
import { refusal } from "./places"
import { nameVia, webIdVia } from "./references"

export const SITE_VISIT_PREFIX = "site-visit"
export const SITE_VISIT_RECORD_KIND = "Site visit"
const CUSTOMER_PREFIX = "customer"
const SITE_PREFIX = "drop-off"
const FRACTION_PREFIX = MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix

/** How far back the ledger is read, by the visit's day: older visits are the reports' and the audit's, not the desk's. */
export const SITE_VISITS_WINDOW_DAYS = 90

/** The first day the ledger is read from, `from` on its list. */
export function siteVisitsWindowFrom(now = new Date()): string {
  const from = new Date(now.getTime())
  from.setUTCDate(from.getUTCDate() - SITE_VISITS_WINDOW_DAYS)
  return from.toISOString().slice(0, 10)
}

/** Who or what the visit was identified as: the plate or the card as read, or the Property found by its address. */
function identifierOf(visit: SiteVisit, context: MappingContext): string {
  if (visit.identifierValue !== null) return visit.identifierValue
  return visit.propertyId === null ? "" : nameVia(context, PROPERTY_PREFIX, visit.propertyId)
}

/** What the visit was charged at, as the ledger's column reads it; a refused visit is charged nothing. */
function chargeOf(visit: SiteVisit, context: MappingContext): string {
  if (visit.charge === null) return "Not charged"
  const basis = chargeBasisSentence(visit.charge.basis, visit.charge.n)
  return visit.charge.productId === null ? basis : `${basis}: ${nameVia(context, PRODUCT_PREFIX, visit.charge.productId)}`
}

export function toSiteVisitRecord(visit: SiteVisit, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(visit.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", visit.projectId)
  const site = nameVia(context, SITE_PREFIX, visit.siteId)
  const identifier = identifierOf(visit, context)
  const when = dayAndTimeOn(visit.occurredAt, projectTimezoneOf({ projectIds: [projectWebId] }, context))
  const brought = visit.wasteFractionIds.map((id) => nameVia(context, FRACTION_PREFIX, id))
  const charge = chargeOf(visit, context)
  const reference = (prefix: string, serverId: string | null) => (serverId === null ? "" : webIdVia(context, prefix, serverId))
  const facts: Record<string, string> = {
    Site: site,
    When: when,
    Day: visit.serviceDate,
    "Identified by": IDENTIFICATION_LABELS[visit.identification],
    ...(visit.identifierValue === null ? {} : { [IDENTIFICATION_LABELS[visit.identification]]: visit.identifierValue }),
    ...(visit.propertyId === null ? {} : { Property: nameVia(context, PROPERTY_PREFIX, visit.propertyId) }),
    ...(visit.customerId === null ? {} : { Customer: nameVia(context, CUSTOMER_PREFIX, visit.customerId) }),
    ...(visit.agreementId === null ? {} : { Agreement: nameVia(context, AGREEMENT_PREFIX, visit.agreementId) }),
    Brought: brought.length === 0 ? "Nothing recorded" : brought.join(", "),
    Outcome: OUTCOME_LABELS[visit.outcome],
    ...(visit.refusalReason === null ? {} : { "Refused because": REFUSAL_LABELS[visit.refusalReason] }),
    Charge: charge,
    Source: SOURCE_LABELS[visit.source],
    ...(visit.recordedBy === null ? {} : { "Checked in by": nameVia(context, "user", visit.recordedBy) }),
    ...(visit.note === null ? {} : { Note: visit.note }),
    ...(visit.voidReason === null ? {} : { "Voided because": visit.voidReason }),
    ...(project?.name === undefined ? {} : { Project: project.name }),
  }
  return {
    id: webIdOf(SITE_VISIT_PREFIX, visit.id),
    name: `${identifier === "" ? "Visitor" : identifier} · ${when}`,
    context: `${site} · ${identifier}`,
    status: visitStatusOf(visit),
    ...inheritedPresentation(undefined),
    ...stampFacts(visit, context.now),
    value: charge,
    description: brought.length === 0 ? "Nothing recorded" : brought.join(", "),
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: SITE_VISIT_RECORD_KIND,
    submittedValues: {
      projectId: projectWebId,
      siteId: reference(SITE_PREFIX, visit.siteId),
      propertyId: reference(PROPERTY_PREFIX, visit.propertyId),
      customerId: reference(CUSTOMER_PREFIX, visit.customerId),
      agreementId: reference(AGREEMENT_PREFIX, visit.agreementId),
      serviceDate: visit.serviceDate,
      outcome: visit.outcome,
      [VISIT_VOIDED_KEY]: visit.voidedAt !== null,
    },
  }
}

/** The ledger is written by the check-in and the gate alone. */
export const LEDGER_KEPT = "A site visit is a ledger entry: void it with why, and check the visitor in again"

export const VOID_VISIT = "void"

export const SITE_VISIT_COMMANDS: Readonly<Record<string, RecordCommand<SiteVisit>>> = {
  [VOID_VISIT]: {
    toBody: (input) => {
      const reason = typeof input.reason === "string" ? input.reason.trim() : ""
      return reason === "" ? refusal("reason", "Say why the visit is voided") : { reason }
    },
    run: (client, serverId, body) => command<SiteVisit>(client, `/site-visits/${serverId}/void`, body),
    // No `touches`: the Finance consumer cancels or reverses the visit's charge on its own time, after the void's answer.
    refused: (record) => `${record.name} was not voided`,
  },
}

export const siteVisitAdapter: ResourceAdapter<SiteVisit> = {
  prefix: SITE_VISIT_PREFIX,
  auditTable: "site_visit",
  owns: ofKind(SITE_VISIT_PREFIX, [SITE_VISIT_RECORD_KIND]),
  statuses: undefined,
  list: (client: ApiClient) => listAll<SiteVisit>(client, "/site-visits", { from: siteVisitsWindowFrom() }),
  toRecord: toSiteVisitRecord,
  toPatchBody: () => refusal("note", LEDGER_KEPT),
  update: () => Promise.reject(new Error(LEDGER_KEPT)),
  read: (client, serverId) => get<SiteVisit>(client, `/site-visits/${serverId}`),
  commands: SITE_VISIT_COMMANDS,
}

/** Operate › Site visits: read after the places, the master data, the properties, the customers, the agreements, the products and the accounts its rows name. */
export const siteVisitsModule: ServerModule = {
  workspaceId: SITE_VISITS_MODULE.workspaceId,
  moduleId: SITE_VISITS_MODULE.moduleId,
  resources: [siteVisitAdapter],
}
