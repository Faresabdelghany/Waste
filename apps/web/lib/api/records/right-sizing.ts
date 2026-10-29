// Customers › Right-sizing on the API (M23b of #293): the proposals,
// `right-sizing-proposal-<uuid>` from the start
// (`@waste/contracts/right-sizing`, routes apps/api/src/routes/right-sizing.ts).
// A proposal is the run's, never the office's: no create and no patch. An
// open one is approved — a size from a day with its product, which changes
// the subscription, so the agreements are read again (`touches`); a
// frequency as a decision alone — or dismissed with why. Propose now runs the
// night's run over the caller's projects through the client.
import type { RightSizingProposal, RightSizingRun } from "@waste/contracts/right-sizing"
import { changesTheProduct } from "@waste/domain/inspections/right-sizing"

import { AGREEMENTS_MODULE, PRODUCT_PREFIX, SUBSCRIPTION_PREFIX } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { DIRECTION_LABELS, evidenceSentence, RIGHT_SIZING_MODULE, RIGHT_SIZING_PREFIX, RIGHT_SIZING_RECORD_KIND, STATUS_LABELS } from "@/lib/data/right-sizing"

import { command, get, listAll, post, type ApiClient } from "../client"
import { inheritedPresentation, said, stampFacts, webIdOf, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectTimezoneOf, shownOn } from "./clock"
import { refusal } from "./places"
import { nameVia, webIdVia } from "./references"

/** The commands an open proposal's details offer. */
export const APPROVE_PROPOSAL = "approve"
export const DISMISS_PROPOSAL = "dismiss"



/** The commands a proposal's details offer: Approve and Dismiss while it is open, none once decided. */
export const proposalCommandsOffered = (record: { submittedValues?: Record<string, unknown> }): string[] => (record.submittedValues?.status === "open" ? [APPROVE_PROPOSAL, DISMISS_PROPOSAL] : [])

/** Whether a proposal's approve changes the product, and so asks a day and a product. */
export const approveChangesTheProduct = (record: { submittedValues?: Record<string, unknown> }): boolean => {
  const direction = record.submittedValues?.direction
  return direction === "smaller" || direction === "bigger"
}

export function toProposalRecord(proposal: RightSizingProposal, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(proposal.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", proposal.projectId)
  const timezone = projectTimezoneOf({ projectIds: [projectWebId] }, context)
  const subscription = nameVia(context, SUBSCRIPTION_PREFIX, proposal.subscriptionId)
  const product = nameVia(context, PRODUCT_PREFIX, proposal.productId)
  const suggested = proposal.suggestedProductId === null ? undefined : nameVia(context, PRODUCT_PREFIX, proposal.suggestedProductId)
  const direction = DIRECTION_LABELS[proposal.direction]
  return {
    id: webIdOf(RIGHT_SIZING_PREFIX, proposal.id),
    name: `${subscription} · ${direction.toLowerCase()}`,
    context: suggested === undefined ? direction : `${product} → ${suggested}`,
    status: STATUS_LABELS[proposal.status],
    ...inheritedPresentation(undefined),
    ...stampFacts(proposal, context.now),
    value: evidenceSentence(proposal.evidence),
    description:
      proposal.status === "dismissed"
        ? `Dismissed: ${proposal.dismissNote ?? ""}`
        : proposal.status === "approved"
          ? proposal.changedOn === null
            ? "Approved: the office changes the collections itself."
            : `Approved: the new product from ${proposal.changedOn}.`
          : `The drivers found it ${evidenceSentence(proposal.evidence)}.`,
    facts: {
      Subscription: subscription,
      Product: product,
      Proposed: direction,
      ...(suggested === undefined ? {} : { "Suggested product": suggested }),
      Estimates: evidenceSentence(proposal.evidence),
      "Newest estimate": shownOn(proposal.evidenceThrough, timezone),
      ...(proposal.decidedAt === null ? {} : { Decided: shownOn(proposal.decidedAt, timezone) }),
      ...(proposal.changedOn === null ? {} : { "Changed from": proposal.changedOn }),
      ...(proposal.dismissNote === null ? {} : { Dismissed: proposal.dismissNote }),
      ...(project?.name === undefined ? {} : { Project: project.name }),
    },
    related: [subscription],
    allowedTransitions: [],
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: RIGHT_SIZING_RECORD_KIND,
    submittedValues: {
      status: proposal.status,
      direction: proposal.direction,
      ...(proposal.suggestedProductId === null ? {} : { suggestedProductId: webIdVia(context, PRODUCT_PREFIX, proposal.suggestedProductId) }),
    },
  }
}

export const rightSizingAdapter: ResourceAdapter<RightSizingProposal> = {
  prefix: RIGHT_SIZING_PREFIX,
  auditTable: "right_sizing_proposal",
  owns: (record) => record.id.startsWith(`${RIGHT_SIZING_PREFIX}-`),
  // A proposal's status moves by its commands alone.
  statuses: undefined,
  list: (client) => listAll<RightSizingProposal>(client, "/right-sizing-proposals"),
  read: (client, serverId) => get<RightSizingProposal>(client, `/right-sizing-proposals/${serverId}`),
  toRecord: toProposalRecord,
  toPatchBody: () => refusal("status", "A proposal is the run's: approve it or dismiss it"),
  // Never reached: every patch is refused above, since the wire has no patch route for a proposal.
  update: () => Promise.reject(new Error("A right-sizing proposal has no patch route")),
  commands: {
    [APPROVE_PROPOSAL]: {
      toBody: (input, record, context) => {
        if (!changesTheProduct(record.submittedValues?.direction as never)) return {}
        const on = said(input, "on")
        if (on === undefined) return refusal("on", "Pick the first day of the new product")
        const productWebId = said(input, "productId")
        const productId = productWebId === undefined ? undefined : context.resolve.serverIdOf(productWebId)
        if (productId === undefined) return refusal("productId", "Pick a product the API holds")
        return { on, productId }
      },
      run: (client, serverId, body) => command<RightSizingProposal>(client, `/right-sizing-proposals/${serverId}/approve`, body),
      refused: (record) => `${record.name} was not approved`,
      // A size's approve is the subscription's change: the agreements module reads it.
      touches: [`${AGREEMENTS_MODULE.workspaceId}.${AGREEMENTS_MODULE.moduleId}`],
    },
    [DISMISS_PROPOSAL]: {
      toBody: (input) => {
        const note = said(input, "note")
        return note === undefined ? refusal("note", "Say why the proposal is not taken") : { note }
      },
      run: (client, serverId, body) => command<RightSizingProposal>(client, `/right-sizing-proposals/${serverId}/dismiss`, body),
      refused: (record) => `${record.name} was not dismissed`,
    },
  },
}

/** Propose now: the night's run over the caller's projects; how many it proposed. */
export const runRightSizing = async (client: ApiClient): Promise<number> => (await post<RightSizingRun>(client, "/right-sizing-proposals/run", {})).body.proposed

/** Customers › Right-sizing: read after the agreements and the products its rows name. */
export const rightSizingModule: ServerModule = { workspaceId: RIGHT_SIZING_MODULE.workspaceId, moduleId: RIGHT_SIZING_MODULE.moduleId, resources: [rightSizingAdapter] }
