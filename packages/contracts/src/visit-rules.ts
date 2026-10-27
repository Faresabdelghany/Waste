// The wire of a project's Visit Rules (Issue #393, M4 of #293): how its
// recycling centres' visits are charged, effective-dated per project
// (ADR-0005), one in force at a time. A household's free visits per calendar
// year and the ladder after them, the last step repeating — "1st free, then
// 70, then 620" is one free visit and two steps; the free fractions whose
// visits are neither counted nor charged; a business's per-visit product and
// the annual-access product whose subscription includes its visits; and the
// threshold and window that flag a Property as a likely trade. The routes are
// apps/api/src/routes/visit-rules.ts, under `commercial.products` as the
// ticket and work order charges are; the rules are
// @waste/domain/visits/charges.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** The ladder: the per-visit products charged once the free visits are spent, the last repeating; empty includes every visit. */
const Ladder = z.array(Id).max(10)

/** What a rule's free fractions naming one twice is told. */
export const EACH_FREE_FRACTION_ONCE = eachOnceSentence("free fraction")

const FreeFractionIds = z
  .array(Id)
  .max(200)
  .refine((ids) => eachOnce(ids), { message: EACH_FREE_FRACTION_ONCE })

/** A household's free visits per calendar year: at most one a day. */
const FreeVisits = NonNegativeInt.max(366)
const TradeThreshold = PositiveInt.max(1000)
const TradeWindowDays = PositiveInt.max(366)

/** The likely-trade threshold and its window go together, or neither. */
const tradeTogether = (rule: { tradeThreshold?: number | null; tradeWindowDays?: number | null }): boolean => (rule.tradeThreshold == null) === (rule.tradeWindowDays == null)
/** What a threshold without its window, or a window without its threshold, is told. */
export const TRADE_TOGETHER = "A likely trade is a threshold of visits in a window of days: give both, or neither"
const tradeTogetherAt = { message: TRADE_TOGETHER, path: ["tradeWindowDays"] }

export const VisitRule = z
  .object({
    ...stamped,
    projectId: Id,
    freeVisits: FreeVisits,
    ladder: Ladder,
    freeFractionIds: z.array(Id),
    /** What a business's visit is charged at without annual access; null charges nothing. */
    businessVisitProductId: Id.nullable(),
    /** The product sold by the month whose subscription under a business's Agreement includes its visits. */
    annualAccessProductId: Id.nullable(),
    tradeThreshold: TradeThreshold.nullable(),
    tradeWindowDays: TradeWindowDays.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type VisitRule = z.infer<typeof VisitRule>

export const VisitRuleCreate = z
  .strictObject({
    projectId: Id,
    freeVisits: FreeVisits.default(0),
    ladder: Ladder.default([]),
    freeFractionIds: FreeFractionIds.default([]),
    businessVisitProductId: Id.nullable().optional(),
    annualAccessProductId: Id.nullable().optional(),
    tradeThreshold: TradeThreshold.nullable().optional(),
    tradeWindowDays: TradeWindowDays.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
  .refine(tradeTogether, tradeTogetherAt)
export type VisitRuleCreate = z.infer<typeof VisitRuleCreate>

/** Everything but the project and the start: the ladder and the free fractions replaced whole. */
export const VisitRulePatch = z
  .strictObject({
    freeVisits: FreeVisits.optional(),
    ladder: Ladder.optional(),
    freeFractionIds: FreeFractionIds.optional(),
    businessVisitProductId: Id.nullable().optional(),
    annualAccessProductId: Id.nullable().optional(),
    tradeThreshold: TradeThreshold.nullable().optional(),
    tradeWindowDays: TradeWindowDays.nullable().optional(),
    /** Null reopens the rule; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type VisitRulePatch = z.infer<typeof VisitRulePatch>

/** A page of rules: one project's, in force on a day where `validOn` says. */
export const VisitRuleListQuery = ProjectScopedListQuery.extend({ validOn: IsoDate.optional() })
export type VisitRuleListQuery = z.infer<typeof VisitRuleListQuery>
