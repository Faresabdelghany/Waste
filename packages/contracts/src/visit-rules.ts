// The wire of a project's Visit Rules (Issue #393, M4 of #293): how its
// recycling centres' visits are charged, effective-dated per project
// (ADR-0005), one in force at a time. A household's free visits per calendar
// year and the ladder after them, the last step repeating — "1st free, then
// 70, then 620" is one free visit and two steps; the free fractions whose
// visits are neither counted nor charged; a business's per-visit product and
// the annual-access product whose subscription includes its visits; and the
// threshold and window that flag a Property as a likely trade. The routes are
// apps/api/src/routes/visit-rules.ts, under `commercial.products` as the
// ticket charges are; the rules are
// @waste/domain/visits/charges.
import { eachOnce } from "@waste/domain/requests"
import { EACH_FREE_FRACTION_ONCE, FREE_FRACTIONS_MAX, FREE_VISITS, TRADE_THRESHOLD, TRADE_TOGETHER, TRADE_WINDOW_DAYS, tradeTogether, VISIT_LADDER_MAX } from "@waste/domain/visits/charges"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { NonNegativeInt, PositiveInt, stamped } from "./resource"
import { effectiveDated, effectiveDatedBodies } from "./validity"

/** The ladder: the per-visit products charged once the free visits are spent, the last repeating; empty includes every visit. */
const Ladder = z.array(Id).max(VISIT_LADDER_MAX)

const FreeFractionIds = z
  .array(Id)
  .max(FREE_FRACTIONS_MAX)
  .refine((ids) => eachOnce(ids), { message: EACH_FREE_FRACTION_ONCE })

/** A household's free visits per calendar year. */
const FreeVisits = NonNegativeInt.max(FREE_VISITS.max)
const TradeThreshold = PositiveInt.max(TRADE_THRESHOLD.max)
const TradeWindowDays = PositiveInt.max(TRADE_WINDOW_DAYS.max)

const tradeTogetherAt = { message: TRADE_TOGETHER, path: ["tradeWindowDays"] }

export const VisitRule = effectiveDated(
  z.object({
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
  }),
)
export type VisitRule = z.infer<typeof VisitRule>

/** A patch takes everything but the project and the start: the ladder and the free fractions replaced whole, a null end reopening the rule. */
const visitRuleBodies = effectiveDatedBodies(
  {
    projectId: Id,
    freeVisits: FreeVisits.default(0),
    ladder: Ladder.default([]),
    freeFractionIds: FreeFractionIds.default([]),
    businessVisitProductId: Id.nullable().optional(),
    annualAccessProductId: Id.nullable().optional(),
    tradeThreshold: TradeThreshold.nullable().optional(),
    tradeWindowDays: TradeWindowDays.nullable().optional(),
  },
  { keys: ["projectId", "validFrom"] },
)

export const VisitRuleCreate = visitRuleBodies.create.refine(tradeTogether, tradeTogetherAt)
export type VisitRuleCreate = z.infer<typeof VisitRuleCreate>

export const VisitRulePatch = visitRuleBodies.patch
export type VisitRulePatch = z.infer<typeof VisitRulePatch>

/** A page of rules: one project's, in force on a day where `validOn` says. */
export const VisitRuleListQuery = ProjectScopedListQuery.extend({ validOn: IsoDate.optional() })
export type VisitRuleListQuery = z.infer<typeof VisitRuleListQuery>
