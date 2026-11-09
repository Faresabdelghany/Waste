// The Billing Run as the office asks for it and reads it (Issue #112 §3,
// §5; ADR-0005): "a controlled batch that converts eligible billable events
// into invoices" (CONTEXT.md). `POST /billing-runs` runs one, synchronously,
// a batch of payers at a time in short transactions of its own (#329), so its
// guard is `identify`, which ends the request's transaction before the
// handler; `POST /billing-runs/preview` runs the same
// selection and grouping and writes nothing; `GET /billing-runs` lists the
// runs and `GET /billing-runs/:id` reads one with the payers it excluded and
// the invoices it issued. No patch and no delete: a run is the record of
// what it did, frozen once `completed`.
//
// The run itself — `runBilling`, `selectBilling`, `previewBilling`, the
// ceiling and its sentence — is a command under `@waste/db/commands/
// billing-runs` since part B (Issue #112): the worker's `finance.run-billing`
// runs the same function on its cadence with `null` for the person, so a run
// is one thing whichever process asks for it. The header there says what a
// run selects, locks, groups, numbers, writes and publishes; this module is
// the four routes over it, each bounded by the tenant and `inProjects`, the
// grant `commercial.billing`, `view` to read and to preview, `create` to run,
// and the command's refusal — another run of the project under way, an event
// another run invoiced under this one — a `Refused` the API's error handler
// answers as a 409 (problem.ts, `refusalProblem`).
import { BillingRun, BillingRunCreate, BillingRunDetail, BillingRunListQuery, BillingRunPreview } from "@waste/contracts/billing"
import { Page } from "@waste/contracts/pagination"
import { BILLING_RUN_MAX_EVENTS, grouped, previewBilling, runBilling } from "@waste/db/commands/billing-runs"
import { billingRun } from "@waste/db/schema/finance"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { exclusionOf, runColumns, runDetailOf, runOf } from "@waste/db/shapes/billing-runs"

import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem } from "../problem"
import { findRun, noSuchRun, runScope } from "./billing-shapes"
import { created, describeCreated, describeJson, IdParam } from "./shared"

const MODULE = "commercial.billing"

const RunPage = Page(BillingRun)

const RUN_RULES =
  "A run is for a closed period: its `periodTo` is the project's today at the latest (400 at `periodTo`, `A run's period ends by today`), so a recurring charge is billed in advance from the period after a closed one, and a hire (M14 of #293) charges no day still to come. The selection is every `pickup`, `ticket`, `manual` and `reversal` event of the project whose `serviceDate` lies in the period, both days inclusive, and whose reading is `ready` — priced, not held for review, not cancelled, on no invoice line, not reversed (a reversed original stays on its invoice; the reversal is what is selected). A blocked event is never invoiced and never re-evaluated here; `reprice` is its door. A `held` event (M14 of #293) is passed over until the office releases it, and then goes to the next run that reaches it — its own period's, or a later one's catch-up within twelve months; a project that holds its hires and jobs (`holdForReview`) has each priced hire the run mints written held, and the preview counts those as held, not ready. The events are grouped by payer (`agreement.payerCustomerId`) and currency, one invoice per group, and a payer whose events in the period are all passed over is an exclusion with the count and the reason — `all-events-blocked`, `all-events-held`, or `all-events-blocked-or-held` where some are each — so no customer is silently skipped; a payer whose own ready events alone are more than " +
  grouped(BILLING_RUN_MAX_EVENTS) +
  ", more than one batch takes (#329), is excluded alone, `too-many-events`, rather than split across invoices. No status gates the payer: an invoice records delivered work, and a customer gone inactive is invoiced for it. A run catches up too (#447): the ready events from before the period that no line names and that a completed run of the project already reached — released from a hold, repriced or recorded after their own period's run — back to twelve months before `periodFrom`, by service date, a recurring charge or a hire by a charge period that ended before the period's reach, each invoiced once, on its payer's invoice beside the period's own. An event whose period no run has covered waits for that period's own run. The period's own come first in each batch: the catch-up takes, oldest first, only the room they leave, and the rest wait for the next run."

export function billingRunRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/billing-runs",
      {
        operationId: "listBillingRuns",
        summary: "The billing runs of the caller's projects",
        description:
          "One page of runs, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` is one of the three; `from` and `to` a window over `periodFrom`, both inclusive (`to` on or after `from`). Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: BillingRunListQuery,
        invalid: ["a filter is malformed", "the window runs backwards", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of runs.", RunPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, status, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(runColumns)
          .from(billingRun)
          .where(
            and(
              runScope(principal),
              projectId === undefined ? undefined : eq(billingRun.projectId, projectId),
              status === undefined ? undefined : eq(billingRun.status, status),
              from === undefined ? undefined : gte(billingRun.periodFrom, from),
              to === undefined ? undefined : lte(billingRun.periodFrom, to),
              after === undefined ? undefined : gt(billingRun.id, after),
            ),
          )
          .orderBy(asc(billingRun.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(runOf), limit))
      },
    )
    .post(
      "/billing-runs",
      {
        operationId: "createBillingRun",
        summary: "Run billing for a project over a period",
        description:
          "Runs billing synchronously for a project the caller works in (400 at `projectId` otherwise) over the service dates `periodFrom` to `periodTo` (`periodTo` on or after `periodFrom`, 400 at `periodTo`), a batch of payers at a time (#329), each batch a transaction of its own, so a project of any size completes. " +
          RUN_RULES +
          ` The run is one row and several transactions: the start writes it \`requested\` and mints the recurring charges and the hires; each batch takes the next payers in id order whose own ready events fit ${grouped(BILLING_RUN_MAX_EVENTS)} together, issues their invoices and touches the row; the finish writes the exclusions and the row \`completed\` with its counts and totals. A run is resumable rather than all-or-nothing: a failure rolls back the batch it happened in, the batches before it stand, and the row stays \`requested\` until a run over the same period finishes it — that run answers the resumed row, never invoicing a payer twice, since a payer the run already invoiced or excluded is done. While another run of the project over another period is \`requested\` and was touched within fifteen minutes, this one is refused (409, \`A billing run of this project over 2026-10-01 – 2026-10-31 is under way; run again once it has completed\`); one untouched longer is a run whose process died, written \`failed\` with what it issued, and this one starts. Every transaction takes the project's row lock, so two runs of one project take turns batch by batch. The events selected are read \`for update\`, so a cancellation sent while the run is invoicing them waits for it and is then refused as invoiced (409), and no event is both invoiced and cancelled. For each group the run takes the next number of the company's series (\`INV-<n>\`, unbroken: a batch that fails rolls its numbers back with its rows), writes the invoice — \`issuedOn\` today on the project's clock, \`dueOn\` the payer's terms on — its own \`paymentTermsDays\`, else the project's (#291 C4) — its \`paymentReference\` frozen from its number under the project's scheme (null under \`none\`), the period, the totals summed from the lines — and its lines in a fixed order, agreement number, service date, product name, event id, each line one event with the product's invoice name (or its name) and the service date as its frozen text and the event's amounts, a reversal a negative line, and emits one \`invoice-issued\` per invoice in the batch's transaction, carrying the invoice with its lines as \`GET /invoices/{id}\` answers it. The run's row is written \`completed\` with its counts and its totals over every currency summed as integers; a run with nothing ready is a completed run of zero invoices. An event another run invoiced under this one is the backstop the project's lock makes unreachable (409, \`An event in the selection was invoiced by another run; run again\`).`,
        module: MODULE,
        action: "create",
        transaction: false,
        body: BillingRunCreate,
        invalid: ["the body is missing a field, names a member the server owns, runs its period backwards or past the project's today, or names a project this account does not work in — each at the field that is wrong"],
        responses: {
          201: describeCreated("The run as completed, with its exclusions and the ids of the invoices it issued.", BillingRunDetail),
          409: describeProblem("Another run of the project, over another period, is under way, or another run invoiced an event of the selection; the detail says which."),
        },
      },
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        // Each of the run's transactions under the company's fence, written by the caller (#329).
        const { run, exclusions, invoiceIds } = await runBilling(c.get("transact"), {
          companyId: principal.companyId,
          projectId: body.projectId,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo,
          note: body.note ?? null,
          requestedBy: principal.user.id,
          newId,
          now,
        })
        const detail: BillingRunDetail = { ...runOf(run), exclusions: exclusions.map(exclusionOf), invoiceIds }
        return created(c, "/billing-runs", detail)
      },
    )
    .post(
      "/billing-runs/preview",
      {
        operationId: "previewBillingRun",
        summary: "What a run over a period would do, without doing it",
        description:
          "The dry run: the same body as `POST /billing-runs` — a POST because the body is a `BillingRunCreate` — the same selection and grouping, and nothing written: no run, no invoice, no number taken, no event emitted. Answers the count of ready events, the count of invoices a run would issue, the totals per currency, the payers a run would exclude with the reason and how many of their events it found, the earlier events it would catch up as their lines (`catchUp`, oldest first, counted in the totals), and how many it would leave for a later run (`catchUpDeferredCount`). " +
          RUN_RULES +
          " The whole period is read at once, with nothing written and nothing locked, so it answers a run of any size as the run's batches would together.",
        module: MODULE,
        action: "view",
        body: BillingRunCreate,
        invalid: ["the body is missing a field, names a member the server owns, runs its period backwards or past the project's today, or names a project this account does not work in — each at the field that is wrong"],
        responses: {
          200: describeJson("The counts, the totals per currency and the exclusions a run would produce.", BillingRunPreview),
        },
      },
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope = { companyId: principal.companyId, projectId: body.projectId }
        return c.json(await previewBilling(c.get("tx"), scope, body, now))
      },
    )
    .get(
      "/billing-runs/:id",
      {
        operationId: "getBillingRun",
        summary: "One billing run with its exclusions and its invoices",
        description:
          "One run of a project the caller works in, as completed: the period, who asked, the counts and the totals, the payers it excluded with the reason and how many of their events it found, and the ids of the invoices it issued in numbering order. A run of another company, or of a project this account does not work in, is a run that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The run, its exclusions and its invoice ids.", BillingRunDetail),
          404: describeProblem("No billing run with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findRun(tx, principal, id)
        if (row === undefined) throw noSuchRun(id)
        return c.json(await runDetailOf(tx, principal.companyId, row))
      },
    )
}
