// The wire of the Pickup Exceptions (Issue #293, M5a): a company's
// contaminant codes, a project's charge rules with their ladders, and a
// place's exception history as the rules judge it now
// (@waste/domain/execution/pickup-exceptions). The routes are
// apps/api/src/routes/pickup-exceptions.ts.
//
// A code is master data, its `code` a stable slug like a fraction's key and
// its fractions a set: named on the create, replaced whole through `PUT
// /contaminant-codes/{id}/fractions`, as a station's are. A rule is
// effective-dated per project (ADR-0005): its outcome, reason and code are
// its key and its start its period's, so a patch moves the free count, the
// window, the ladder and the end alone — end the rule and add another, as a
// price row. A ladder names the project's products by charged occurrence,
// the last repeating.
import { CONTAMINANT_CODE_FRACTIONS_MAX, PICKUP_EXCEPTION_FREE_COUNT_MAX, PICKUP_EXCEPTION_HISTORY_MAX, PICKUP_EXCEPTION_LADDER_MAX, PICKUP_EXCEPTION_WINDOW_DAYS, REASON_AND_CODE, reasonAndCode } from "@waste/domain/execution/pickup-exceptions"
import { CONTAMINANT_CODE_STATUSES, PICKUP_EXCEPTION_REASONS } from "@waste/domain/execution/vocabulary"
import { EACH_FRACTION_ONCE } from "@waste/domain/registry/catalogue"
import { eachOnce } from "@waste/domain/requests"
import * as z from "zod"

import { IsoDate } from "./dates"
import { PickupOrigin, PickupOutcome, PickupReason, PickupService, PickupStatus } from "./execution"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { NonNegativeInt, PositiveInt, resourceBodies, stamped } from "./resource"
import { Label, Slug } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

/** A contaminant code's: in use, or retired from new tags while the stops tagged with it keep it. */
export const ContaminantCodeStatus = z.enum(CONTAMINANT_CODE_STATUSES)
export type ContaminantCodeStatus = z.infer<typeof ContaminantCodeStatus>

/** A reason the customer caused, which a rule may narrow to. */
export const PickupExceptionReason = z.enum(PICKUP_EXCEPTION_REASONS)
export type PickupExceptionReason = z.infer<typeof PickupExceptionReason>

/** The fractions a code applies to: each once, at most every fraction a company would keep. */
const FractionIds = z.array(Id).max(CONTAMINANT_CODE_FRACTIONS_MAX).refine((ids) => eachOnce(ids), { message: EACH_FRACTION_ONCE })

export const ContaminantCode = z.object({
  ...stamped,
  /** The stable slug a report and an integration quote; unique per company. */
  code: Slug(),
  /** What a person reads; unique per company. */
  name: Label,
  status: ContaminantCodeStatus,
  /** The fractions it applies to; none is every fraction. */
  wasteFractionIds: z.array(Id),
})
export type ContaminantCode = z.infer<typeof ContaminantCode>

/** A patch takes the name and the status: the code is the slug the rest of the system quotes, and a code that needs another one is another code; the fractions are a set, `PUT …/fractions`. */
const contaminantCodeBodies = resourceBodies(
  {
    code: Slug(),
    name: Label,
    status: ContaminantCodeStatus.default("active"),
    wasteFractionIds: FractionIds.default([]),
  },
  { createOnly: { code: true, wasteFractionIds: true } },
)

export const ContaminantCodeCreate = contaminantCodeBodies.create
export type ContaminantCodeCreate = z.infer<typeof ContaminantCodeCreate>

export const ContaminantCodePatch = contaminantCodeBodies.patch
export type ContaminantCodePatch = z.infer<typeof ContaminantCodePatch>

/** `PUT /contaminant-codes/:id/fractions`: the whole set; empty is every fraction. */
export const ContaminantCodeFractionsSet = z.strictObject({ wasteFractionIds: FractionIds })
export type ContaminantCodeFractionsSet = z.infer<typeof ContaminantCodeFractionsSet>

export const ContaminantCodeListQuery = PageRequest.extend({ status: ContaminantCodeStatus.optional() })
export type ContaminantCodeListQuery = z.infer<typeof ContaminantCodeListQuery>

/** A rule's ladder: the products charged by occurrence, the last repeating; a product may stand on two steps. */
const Ladder = z.array(Id).min(1).max(PICKUP_EXCEPTION_LADDER_MAX)

/** How many matching exceptions in the window cost nothing: 0 charges the first. */
const FreeCount = NonNegativeInt.max(PICKUP_EXCEPTION_FREE_COUNT_MAX)

/** The days before a stop's service date its earlier exceptions are counted over. */
const WindowDays = PositiveInt.max(PICKUP_EXCEPTION_WINDOW_DAYS.max)

const reasonAndCodeAt = { message: REASON_AND_CODE, path: ["reason"] }

export const PickupExceptionRule = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    outcome: PickupOutcome,
    /** Null for any of the customer's reasons, and on a tagged collection's rule. */
    reason: PickupExceptionReason.nullable(),
    /** Null for any code, or none. */
    contaminantCodeId: Id.nullable(),
    freeCount: FreeCount,
    windowDays: WindowDays,
    /** The products charged by occurrence once the free count is spent, the last repeating. */
    ladder: Ladder,
  }),
)
export type PickupExceptionRule = z.infer<typeof PickupExceptionRule>

/** A patch takes the free count, the window, the ladder replaced whole, and the end, a null reopening the rule; the outcome, reason and code are the rule's key and its start its period's — end it and add another. */
const pickupExceptionRuleBodies = effectiveDatedBodies(
  {
    projectId: Id,
    outcome: PickupOutcome,
    reason: PickupExceptionReason.nullable().optional(),
    contaminantCodeId: Id.nullable().optional(),
    freeCount: FreeCount,
    windowDays: WindowDays,
    ladder: Ladder,
  },
  { createOnly: { projectId: true, outcome: true, reason: true, contaminantCodeId: true, validFrom: true } },
)

export const PickupExceptionRuleCreate = pickupExceptionRuleBodies.create.refine(reasonAndCode, reasonAndCodeAt)
export type PickupExceptionRuleCreate = z.infer<typeof PickupExceptionRuleCreate>

export const PickupExceptionRulePatch = pickupExceptionRuleBodies.patch
export type PickupExceptionRulePatch = z.infer<typeof PickupExceptionRulePatch>

export const PickupExceptionRuleListQuery = ProjectScopedListQuery.extend({ validOn: IsoDate.optional() })
export type PickupExceptionRuleListQuery = z.infer<typeof PickupExceptionRuleListQuery>

/** What the rules in force say of an exception now: the rule, the earlier matching exceptions at its place, and the ladder's product, null while free. */
export const PickupExceptionJudgement = z.object({
  ruleId: Id,
  index: NonNegativeInt,
  free: z.boolean(),
  productId: Id.nullable(),
})
export type PickupExceptionJudgement = z.infer<typeof PickupExceptionJudgement>

/** One Pickup Exception at a place: the stop, what it was missed or tagged for, the proof that recorded it, and what the rules say of it now. */
export const PickupException = z.object({
  pickupId: Id,
  routeId: Id,
  projectId: Id,
  serviceDate: IsoDate,
  status: PickupStatus,
  reason: PickupReason.nullable(),
  contaminantCodeId: Id.nullable(),
  origin: PickupOrigin,
  service: PickupService,
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  /** The latest proof recording the outcome — the driver's, or the office's correction; null where none was recorded. */
  evidenceProofId: Id.nullable(),
  /** Null where no rule governs it, or it is no chargeable exception: the office's stop or a work order. */
  judgement: PickupExceptionJudgement.nullable(),
})
export type PickupException = z.infer<typeof PickupException>

/** A place's exception history: newest service date first, from `from` on, at most `PICKUP_EXCEPTION_HISTORY_MAX`, and whether more were left out. */
export const PickupExceptionHistory = z.object({
  items: z.array(PickupException).max(PICKUP_EXCEPTION_HISTORY_MAX),
  truncated: z.boolean(),
})
export type PickupExceptionHistory = z.infer<typeof PickupExceptionHistory>

export const PickupExceptionHistoryQuery = z.strictObject({
  /** The first service date read; absent reads the 365 days before the project's today. */
  from: IsoDate.optional(),
})
export type PickupExceptionHistoryQuery = z.infer<typeof PickupExceptionHistoryQuery>
