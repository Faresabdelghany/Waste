// The Billing Run as the office asks for it and reads it (Issue #112 §3,
// §5; ADR-0005): "a controlled batch that converts eligible billable events
// into invoices" (CONTEXT.md). `POST /billing-runs` runs one, synchronously
// in the request's transaction; `POST /billing-runs/preview` runs the same
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
// and the command's refusal — too many ready events, an event another run
// invoiced under this one — answered as the 409 it would have been through
// `refusedByCommand`.
import { BillingRun, BillingRunCreate, BillingRunDetail, BillingRunListQuery, BillingRunPreview } from "@waste/contracts/billing"
import { Page } from "@waste/contracts/pagination"
import { BILLING_RUN_MAX_EVENTS, grouped, previewBilling, runBilling } from "@waste/db/commands/billing-runs"
import { billingRun } from "@waste/db/schema/finance"
import { PAYMENT_TERMS_DAYS } from "@waste/domain/finance/money"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, validate } from "../problem"
import { exclusionOf, findRun, noSuchRun, runColumns, runDetailOf, runOf, runScope } from "./billing-shapes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, refusedByCommand } from "./shared"

export { BILLING_RUN_MAX_EVENTS, previewBilling, runBilling, selectBilling, tooManyEvents, type BillingPeriod, type RunBillingInput, type Selection, type SelectionOptions } from "@waste/db/commands/billing-runs"

const MODULE = "commercial.billing"

const RunPage = Page(BillingRun)

const problems = (action: "view" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

const RUN_RULES =
  "The selection is every `pickup`, `ticket`, `manual` and `reversal` event of the project whose `serviceDate` lies in the period, both days inclusive, and whose reading is `ready` — priced, not cancelled, on no invoice line, not reversed (a reversed original stays on its invoice; the reversal is what is selected). A blocked event is never invoiced and never re-evaluated here; `reprice` is its door. The events are grouped by payer (`agreement.payerCustomerId`) and currency, one invoice per group, and a payer whose events in the period are all blocked is an exclusion with the reason `all-events-blocked` and the count, so no customer is silently skipped. No status gates the payer: an invoice records delivered work, and a customer gone inactive is invoiced for it."

export function billingRunRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/billing-runs",
      describeRoute({
        operationId: "listBillingRuns",
        summary: "The billing runs of the caller's projects",
        description:
          "One page of runs, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` is one of the three; `from` and `to` a window over `periodFrom`, both inclusive (`to` on or after `from`). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of runs.", RunPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, or `projectId` is not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BillingRunListQuery),
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
      describeRoute({
        operationId: "createBillingRun",
        summary: "Run billing for a project over a period",
        description:
          "Runs billing synchronously, in the request's transaction, for a project the caller works in (400 at `projectId` otherwise) over the service dates `periodFrom` to `periodTo` (`periodTo` on or after `periodFrom`, 400 at `periodTo`). " +
          RUN_RULES +
          ` A selection above ${grouped(BILLING_RUN_MAX_EVENTS)} ready events is refused (409, \`5 214 ready events fall in the period; narrow it — a run is one transaction\`). Under the project's row lock, so two runs of one project take turns and the second finds only what the first left; two runs over overlapping periods are allowed for the same reason. The events selected are read \`for update\`, so a cancellation sent while the run is invoicing them waits for it and is then refused as invoiced (409), and no event is both invoiced and cancelled. For each group the run takes the next number of the company's series (\`INV-<n>\`, unbroken: a run that fails rolls its numbers back with its rows), writes the invoice — \`issuedOn\` today on the project's clock, \`dueOn\` ${PAYMENT_TERMS_DAYS} days on, the period, the totals summed from the lines — and its lines in a fixed order, agreement number, service date, product name, event id, each line one event with the product's invoice name (or its name) and the service date as its frozen text and the event's amounts, a reversal a negative line, and emits one \`invoice-issued\` per invoice in the same transaction, carrying the invoice with its lines as \`GET /invoices/{id}\` answers it. The run's row is written \`completed\` with its counts and its totals over every currency summed as integers; a run with nothing ready is a completed run of zero invoices. An event another run invoiced under this one is the backstop the project's lock makes unreachable (409, \`An event in the selection was invoiced by another run; run again\`).`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The run as completed, with its exclusions and the ids of the invoices it issued.", BillingRunDetail),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards, or names a project this account does not work in — each at the field that is wrong."),
          ...problems("create"),
          409: describeProblem("More ready events fall in the period than one run takes, or another run invoiced an event of the selection; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BillingRunCreate),
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const { run, exclusions, invoiceIds } = await refusedByCommand(() =>
          runBilling(tx, {
            companyId: principal.companyId,
            projectId: body.projectId,
            periodFrom: body.periodFrom,
            periodTo: body.periodTo,
            note: body.note ?? null,
            requestedBy: principal.user.id,
            newId,
            now,
          }),
        )
        const detail: BillingRunDetail = { ...runOf(run), exclusions: exclusions.map(exclusionOf), invoiceIds }
        return created(c, "/billing-runs", detail)
      },
    )
    .post(
      "/billing-runs/preview",
      describeRoute({
        operationId: "previewBillingRun",
        summary: "What a run over a period would do, without doing it",
        description:
          "The dry run: the same body as `POST /billing-runs` — a POST because the body is a `BillingRunCreate` — the same selection and grouping, and nothing written: no run, no invoice, no number taken, no event emitted. Answers the count of ready events, the count of invoices a run would issue, the totals per currency, and the payers a run would exclude with the reason and how many of their events it found. " +
          RUN_RULES +
          ` A selection above ${grouped(BILLING_RUN_MAX_EVENTS)} ready events is refused as the run refuses it (409).`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The counts, the totals per currency and the exclusions a run would produce.", BillingRunPreview),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards, or names a project this account does not work in — each at the field that is wrong."),
          ...problems("view"),
          409: describeProblem("More ready events fall in the period than one run takes."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("json", BillingRunCreate),
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        return c.json(await refusedByCommand(() => previewBilling(c.get("tx"), { companyId: principal.companyId, projectId: body.projectId }, body)))
      },
    )
    .get(
      "/billing-runs/:id",
      describeRoute({
        operationId: "getBillingRun",
        summary: "One billing run with its exclusions and its invoices",
        description:
          "One run of a project the caller works in, as completed: the period, who asked, the counts and the totals, the payers it excluded with the reason and how many of their events it found, and the ids of the invoices it issued in numbering order. A run of another company, or of a project this account does not work in, is a run that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The run, its exclusions and its invoice ids.", BillingRunDetail),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
          404: describeProblem("No billing run with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
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
