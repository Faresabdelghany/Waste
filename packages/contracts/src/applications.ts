// Applications and their Decisions on the wire (M7 of #293,
// @waste/domain/registry/applications). The routes are
// apps/api/src/routes/applications.ts.
//
// An Application is a customer's written request to change how they are
// served or billed, of one of APPLICATION_KINDS; its subject is the customer
// and, where it names them, one place — a property or a shared collection
// point — and a subscription. The office creates it as it arrives and moves
// it by command: `review`, `decide`, `withdraw`, and `reopen` on an appeal.
// A Decision is appended by each `decide`, the latest the one in force, and
// rides on the Application; the whole history is
// `GET /applications/{id}/decisions`. A grant names its first day in force
// and, where it ends, its first day out (ADR-0005); a refusal is in force
// for no period; anything less than a grant in full says how to appeal. That
// a grant is in force, upcoming or expired is a reading of its period
// against a day, never a status: a list asks for the grants in force with
// `inForceOn`.
import { appealTextNeeded, APPEAL_TEXT_NEEDED, decisionPeriodRefusal } from "@waste/domain/registry/applications"
import { APPLICATION_CHANNELS, APPLICATION_KINDS, APPLICATION_STATUSES, DECISION_OUTCOMES } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, PositiveInt, somethingToChange, stamped } from "./resource"
import { Paragraph } from "./text"
import { endsAfterItStarts, validityOrdered } from "./validity"

export const ApplicationKind = z.enum(APPLICATION_KINDS)
export type ApplicationKind = z.infer<typeof ApplicationKind>
export const ApplicationStatus = z.enum(APPLICATION_STATUSES)
export type ApplicationStatus = z.infer<typeof ApplicationStatus>
export const ApplicationChannel = z.enum(APPLICATION_CHANNELS)
export type ApplicationChannel = z.infer<typeof ApplicationChannel>
export const DecisionOutcome = z.enum(DECISION_OUTCOMES)
export type DecisionOutcome = z.infer<typeof DecisionOutcome>

/** What an Application naming both a property and a shared collection point is told, at the shared point. */
export const ONE_PLACE = "An application names a property or a shared collection point, not both"
const onePlace = (body: { propertyId?: string | null; sharedCollectionPointId?: string | null }) => body.propertyId == null || body.sharedCollectionPointId == null
const onePlaceAt = { message: ONE_PLACE, path: ["sharedCollectionPointId"] }

export const Decision = z.object({
  id: Id,
  applicationId: Id,
  outcome: DecisionOutcome,
  /** What the grant holds the customer to, or why it was refused. */
  conditions: Paragraph.nullable(),
  /** The first day a grant is in force; null for a refusal. */
  validFrom: IsoDate.nullable(),
  /** A grant's first day out of force; null while it runs, and for a refusal. */
  validTo: IsoDate.nullable(),
  /** How to appeal; given for anything less than a grant in full. */
  appealText: Paragraph.nullable(),
  decidedBy: Id,
  decidedAt: IsoDateTime,
})
export type Decision = z.infer<typeof Decision>

export const Application = z.object({
  ...stamped,
  projectId: Id,
  /** The company's running count, what a decision letter quotes. */
  number: PositiveInt,
  kind: ApplicationKind,
  status: ApplicationStatus,
  channel: ApplicationChannel,
  receivedOn: IsoDate,
  customerId: Id,
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  subscriptionId: Id.nullable(),
  /** What the customer asks, in their own words or the office's note of them. */
  statement: Paragraph,
  /** The latest Decision, the one in force; null until the first `decide`. A reopened Application keeps it until it is decided again. */
  decision: Decision.nullable(),
})
export type Application = z.infer<typeof Application>

export const ApplicationCreate = z
  .strictObject({
    projectId: Id,
    kind: ApplicationKind,
    channel: ApplicationChannel,
    receivedOn: IsoDate,
    customerId: Id,
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    subscriptionId: Id.nullable().optional(),
    statement: Paragraph,
  })
  .refine(onePlace, onePlaceAt)
export type ApplicationCreate = z.infer<typeof ApplicationCreate>

/** What the office may correct while the Application is undecided; the project and the customer are its own — another customer's request is another Application. */
export const ApplicationPatch = z
  .strictObject({
    kind: ApplicationKind.optional(),
    channel: ApplicationChannel.optional(),
    receivedOn: IsoDate.optional(),
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    subscriptionId: Id.nullable().optional(),
    statement: Paragraph.optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(onePlace, onePlaceAt)
export type ApplicationPatch = z.infer<typeof ApplicationPatch>

/** `POST /applications/{id}/decide`: the outcome, what it holds the customer to, its period, and how to appeal it. */
export const ApplicationDecide = z
  .strictObject({
    outcome: DecisionOutcome,
    conditions: Paragraph.nullable().optional(),
    validFrom: IsoDate.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
    appealText: Paragraph.nullable().optional(),
  })
  .superRefine((body, context) => {
    const refused = decisionPeriodRefusal({ outcome: body.outcome, validFrom: body.validFrom ?? null, validTo: body.validTo ?? null })
    if (refused !== null) context.addIssue({ code: "custom", message: refused.message, path: [refused.path] })
    if (appealTextNeeded(body.outcome) && body.appealText == null) context.addIssue({ code: "custom", message: APPEAL_TEXT_NEEDED, path: ["appealText"] })
  })
  .refine(validityOrdered, endsAfterItStarts)
export type ApplicationDecide = z.infer<typeof ApplicationDecide>

/** A page of Applications: one project's or every one of the caller's, one customer's, kind's or status's, or the grants in force on a day. */
export const ApplicationListQuery = ProjectScopedListQuery.extend({
  customerId: Id.optional(),
  kind: ApplicationKind.optional(),
  status: ApplicationStatus.optional(),
  /** The Applications decided as a grant, whole or in part, whose period holds the day. */
  inForceOn: IsoDate.optional(),
})
export type ApplicationListQuery = z.infer<typeof ApplicationListQuery>

/** `GET /applications/{id}/decisions`: every Decision, oldest first. */
export const DecisionHistory = z.object({ items: z.array(Decision) })
export type DecisionHistory = z.infer<typeof DecisionHistory>
