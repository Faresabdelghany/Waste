// Right-sizing proposals (M23b of #293, row 26.5), under
// `customers.right-sizing`: a subscription's container a size down or up,
// or its collections fewer or more, proposed from its drivers' fill
// estimates by `proposeRightSizing` (@waste/db/commands/right-sizing), which
// the worker runs nightly and `POST /right-sizing-proposals/run` runs for the
// caller's projects now.
//
// A proposal changes nothing on its own. Approve is the one way a size
// reaches the subscription, and touches money, so it also asks `edit` on
// `customers.agreements`, the grant the subscription's own change asks: in
// the request's one transaction, under the proposal's lock, it refuses a
// subscription changed since the proposal read it (stale evidence, a 409),
// then runs the subscription's change from the day named
// (`changeSubscription`, routes/agreements.ts) with the suggested product or
// the one the office names, and records the decision with the replacement.
// A frequency's approval records the decision alone: the office moves the
// container between collection groups itself, which is a scheme's edit
// (#411, decision c). Dismiss says why. A decided proposal is decided.
import { Page } from "@waste/contracts/pagination"
import { RightSizingApprove, RightSizingDismiss, RightSizingListQuery, RightSizingProposal, RightSizingRun, type RightSizingStatus } from "@waste/contracts/right-sizing"
import type { Tx } from "@waste/db/client"
import { proposeRightSizing } from "@waste/db/commands/right-sizing"
import { subscription } from "@waste/db/schema/agreements"
import { rightSizingProposal } from "@waste/db/schema/inspections"
import { changesTheProduct } from "@waste/domain/inspections/right-sizing"
import { and, eq } from "drizzle-orm"
import { instantOf, stampsOf } from "@waste/db/shapes/times"

import type { Principal } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { scoped } from "../scoped"
import { changeSubscription } from "./agreements"

const MODULE = "customers.right-sizing"
/** The grant a subscription's change asks, which an approve of a size asks too. */
const AGREEMENTS = "customers.agreements"

const ProposalPage = Page(RightSizingProposal)

/** What a decision on a decided proposal is told. */
export const alreadyDecided = (status: RightSizingStatus): string => `The proposal is already ${status}`
/** What an approve of a proposal whose subscription changed since is told. */
export const STALE_EVIDENCE = "The subscription changed since the proposal was made; its evidence is stale, and the next run proposes afresh"
/** What a size's approve without its day is told, at `on`. */
export const A_DAY_FOR_THE_CHANGE = "Say the day the change takes effect"
/** What a frequency's approve naming a day or a product is told. */
export const A_FREQUENCY_CHANGES_NO_PRODUCT = "A frequency's approval changes no product and takes no day: the office moves the container between collection groups itself"

const columns = {
  id: rightSizingProposal.id,
  projectId: rightSizingProposal.projectId,
  subscriptionId: rightSizingProposal.subscriptionId,
  productId: rightSizingProposal.productId,
  direction: rightSizingProposal.direction,
  suggestedProductId: rightSizingProposal.suggestedProductId,
  evidence: rightSizingProposal.evidence,
  evidenceThrough: rightSizingProposal.evidenceThrough,
  subscriptionUpdatedAt: rightSizingProposal.subscriptionUpdatedAt,
  status: rightSizingProposal.status,
  decidedAt: rightSizingProposal.decidedAt,
  decidedBy: rightSizingProposal.decidedBy,
  dismissNote: rightSizingProposal.dismissNote,
  changedOn: rightSizingProposal.changedOn,
  replacementSubscriptionId: rightSizingProposal.replacementSubscriptionId,
  createdAt: rightSizingProposal.createdAt,
  updatedAt: rightSizingProposal.updatedAt,
}

type Row = Pick<typeof rightSizingProposal.$inferSelect, keyof typeof columns>

function proposalOf(row: Row): RightSizingProposal {
  return {
    id: row.id,
    projectId: row.projectId,
    subscriptionId: row.subscriptionId,
    productId: row.productId,
    direction: row.direction,
    suggestedProductId: row.suggestedProductId,
    evidence: row.evidence,
    evidenceThrough: row.evidenceThrough.toISOString(),
    status: row.status,
    decidedAt: instantOf(row.decidedAt),
    decidedBy: row.decidedBy,
    dismissNote: row.dismissNote,
    changedOn: row.changedOn,
    replacementSubscriptionId: row.replacementSubscriptionId,
    ...stampsOf(row),
  }
}

const { scope: proposalScope, get: getProposal, locked: lockedProposal, list: listProposals } = scoped(rightSizingProposal, { noun: "right-sizing proposal", reach: "projects", columns })

/** An open proposal, locked: the path's row (404), then its state (409). */
async function openProposal(tx: Tx, principal: Principal, id: string): Promise<Row> {
  const current = await lockedProposal(tx, principal, id)
  if (current.status !== "open") throw problem(409, { detail: alreadyDecided(current.status) })
  return current
}

export function rightSizingRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/right-sizing-proposals",
      {
        operationId: "listRightSizingProposals",
        summary: "The right-sizing proposals",
        description: "One page of the right-sizing proposals of the projects the caller works in, oldest first. `projectId`, `subscriptionId` and `status` narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: RightSizingListQuery,
        invalid: ["a filter is malformed", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of proposals.", ProposalPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, subscriptionId, status } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const page = await listProposals(tx, principal, at, projectId === undefined ? undefined : eq(rightSizingProposal.projectId, projectId), subscriptionId === undefined ? undefined : eq(rightSizingProposal.subscriptionId, subscriptionId), status === undefined ? undefined : eq(rightSizingProposal.status, status))
        return c.json({ ...page, items: page.items.map(proposalOf) })
      },
    )
    .post(
      "/right-sizing-proposals/run",
      {
        operationId: "runRightSizing",
        summary: "Propose right-sizing now",
        description:
          "Runs what the worker runs nightly, over the projects the caller works in: each subscription in force on its project's day, with no open proposal and with estimates newer than its last proposal's, is judged on its containers' latest fill estimates, and proposed a size down or up — the product of the same project, kind, fraction and frequency the next size in the direction — or fewer or more collections where none is sold. Answers how many were proposed; nothing is changed but proposals.",
        module: MODULE,
        action: "create",
        responses: {
          200: describeJson("How many proposals the run made.", RightSizingRun),
        },
      },
      async (c) => {
        const principal = c.get("principal")
        const { proposed } = await proposeRightSizing(c.get("tx"), principal.companyId, now(), projectIdsOf(principal))
        return c.json({ proposed: proposed.length })
      },
    )
    .get(
      "/right-sizing-proposals/:id",
      {
        operationId: "getRightSizingProposal",
        summary: "One right-sizing proposal",
        description: "One proposal of a project the caller works in. A proposal of another company, or of a project this account does not work in, is one that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The proposal.", RightSizingProposal),
          404: describeProblem("No proposal with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getProposal(c.get("tx"), c.get("principal"), id)
        return c.json(proposalOf(row))
      },
    )
    .post(
      "/right-sizing-proposals/:id/approve",
      {
        operationId: "approveRightSizingProposal",
        summary: "Approve a right-sizing proposal",
        description: `Approves one open proposal, under its lock, in one transaction. A size (\`smaller\`, \`bigger\`) is applied as the subscription's change from \`on\` (400 at \`on\` without it) — \`POST /subscriptions/{id}/change\`'s rules and refusals throughout — with the suggested product, or \`productId\` where the office picks another; the proposal records the day and the subscription replacing it. A frequency (\`less-frequent\`, \`more-frequent\`) is recorded alone and takes neither field (400): the office moves the container between collection groups itself. Refused (409) on a decided proposal, and on a subscription changed since the proposal read it: ${STALE_EVIDENCE.toLowerCase()}. Asks \`edit\` on \`${AGREEMENTS}\` besides the module's, since a size changes what the customer pays.`,
        module: MODULE,
        action: "edit",
        also: [AGREEMENTS, "edit"],
        params: IdParam,
        body: RightSizingApprove,
        invalid: ["a size's approve names no day or a day outside the subscription", "a product that is not the project's", "a frequency's names either"],
        responses: {
          200: describeJson("The proposal as it now stands.", RightSizingProposal),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\` and on \`${AGREEMENTS}\`.`),
          404: describeProblem("No proposal with that id in the projects this account works in."),
          409: describeProblem(`The proposal is decided; ${STALE_EVIDENCE}; or the subscription's change refuses (a placement beginning later, a product not offered, the product already subscribed there).`),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await openProposal(tx, principal, id)
        const sized = changesTheProduct(current.direction)
        if (!sized && (body.on !== undefined || body.productId !== undefined)) throw invalidRequest("json", [{ path: body.on !== undefined ? "on" : "productId", message: A_FREQUENCY_CHANGES_NO_PRODUCT }])
        if (sized && body.on === undefined) throw invalidRequest("json", [{ path: "on", message: A_DAY_FOR_THE_CHANGE }])
        // The evidence was read against the subscription as it stood: any write to it since — a change, a patch, an end — makes it stale.
        const [stands] = await tx
          .select({ updatedAt: subscription.updatedAt })
          .from(subscription)
          .where(and(eq(subscription.companyId, principal.companyId), eq(subscription.id, current.subscriptionId)))
          .limit(1)
        if (stands === undefined || stands.updatedAt.getTime() !== current.subscriptionUpdatedAt.getTime()) throw problem(409, { detail: STALE_EVIDENCE })
        const replacement = sized ? await changeSubscription(tx, principal, current.subscriptionId, { on: body.on!, productId: body.productId ?? current.suggestedProductId! }) : undefined
        const [row] = await tx
          .update(rightSizingProposal)
          .set({ status: "approved", decidedAt: now(), decidedBy: principal.user.id, changedOn: replacement === undefined ? null : body.on!, replacementSubscriptionId: replacement?.id ?? null })
          .where(and(proposalScope(principal), eq(rightSizingProposal.id, id)))
          .returning(columns)
        return c.json(proposalOf(row))
      },
    )
    .post(
      "/right-sizing-proposals/:id/dismiss",
      {
        operationId: "dismissRightSizingProposal",
        summary: "Dismiss a right-sizing proposal",
        description: "Dismisses one open proposal with why, under its lock; nothing else changes. The subscription is proposed again only on newer estimates (409 on a decided proposal).",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: RightSizingDismiss,
        invalid: ["the body says no why"],
        responses: {
          200: describeJson("The proposal as it now stands.", RightSizingProposal),
          404: describeProblem("No proposal with that id in the projects this account works in."),
          409: describeProblem("The proposal is decided."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await openProposal(tx, principal, id)
        const [row] = await tx
          .update(rightSizingProposal)
          .set({ status: "dismissed", decidedAt: now(), decidedBy: principal.user.id, dismissNote: note })
          .where(and(proposalScope(principal), eq(rightSizingProposal.id, id)))
          .returning(columns)
        return c.json(proposalOf(row))
      },
    )
}
