import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CODE_WITH_CONTAMINATION, PickupCorrection } from "../pickups"
import {
  ContaminantCode,
  ContaminantCodeCreate,
  ContaminantCodeFractionsSet,
  ContaminantCodePatch,
  PICKUP_EXCEPTION_HISTORY_MAX,
  PickupException,
  PickupExceptionHistory,
  PickupExceptionRule,
  PickupExceptionRuleCreate,
  PickupExceptionRulePatch,
  REASON_AND_CODE,
} from "../pickup-exceptions"

const ID = "01a0d2a4-a280-7001-8000-000000000001"
const OTHER = "01a0d2a4-a280-7001-8000-000000000002"
const STAMPS = { id: ID, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }
const paths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => result.error?.issues.map((issue) => issue.path.join(".")) ?? []

describe("ContaminantCode", () => {
  test("is a slug, a name, a status and the fractions it applies to; a create defaults to active and every fraction", () => {
    const code = { ...STAMPS, code: "plastic-in-organic", name: "Plastic in organic waste", status: "active", wasteFractionIds: [OTHER] }
    assert.deepEqual(ContaminantCode.parse(code), code)
    assert.deepEqual(ContaminantCodeCreate.parse({ code: "food-in-paper", name: "Food in paper" }), { code: "food-in-paper", name: "Food in paper", status: "active", wasteFractionIds: [] })
    assert.deepEqual(paths(ContaminantCodeCreate.safeParse({ code: "Food In Paper", name: "x" })), ["code"], "the slug is lowercase")
    assert.deepEqual(paths(ContaminantCodeCreate.safeParse({ code: "x", name: "x", wasteFractionIds: [OTHER, OTHER] })), ["wasteFractionIds"], "each fraction once")
  })

  test("a patch moves the name and the status, never the code; the fractions are a set of their own", () => {
    assert.deepEqual(ContaminantCodePatch.parse({ status: "inactive" }), { status: "inactive" })
    assert.equal(ContaminantCodePatch.safeParse({ code: "other" }).success, false, "the code is the slug the system quotes")
    assert.equal(ContaminantCodePatch.safeParse({ wasteFractionIds: [] }).success, false, "the fractions are PUT whole")
    assert.equal(ContaminantCodePatch.safeParse({}).success, false, "a patch changes something")
    assert.deepEqual(ContaminantCodeFractionsSet.parse({ wasteFractionIds: [] }), { wasteFractionIds: [] }, "empty is every fraction")
  })
})

describe("PickupExceptionRule", () => {
  const create = { projectId: ID, outcome: "failed", reason: "contamination", freeCount: 1, windowDays: 365, ladder: [OTHER], validFrom: "2026-11-01" }

  test("is a project's effective-dated rule: the outcome, reason and code it governs, the free count, the window and the ladder", () => {
    const rule = { ...STAMPS, ...create, contaminantCodeId: null, validTo: null }
    assert.deepEqual(PickupExceptionRule.parse(rule), rule)
    assert.deepEqual(PickupExceptionRuleCreate.parse(create), create)
    assert.equal(PickupExceptionRuleCreate.safeParse({ ...create, reason: "capacity" }).success, false, "the operator's own miss is no exception")
    assert.deepEqual(paths(PickupExceptionRuleCreate.safeParse({ ...create, ladder: [] })), ["ladder"], "a ladder has a step")
    assert.deepEqual(paths(PickupExceptionRuleCreate.safeParse({ ...create, windowDays: 0 })), ["windowDays"])
    assert.deepEqual(paths(PickupExceptionRuleCreate.safeParse({ ...create, validTo: "2026-11-01" })), ["validTo"], "a period ends after it starts")
  })

  test("a tagged collection's rule names no reason, and a code goes with contamination or any reason", () => {
    const refused = (values: Record<string, unknown>) => PickupExceptionRuleCreate.safeParse({ ...create, ...values }).error?.issues.map((issue) => issue.message)
    assert.deepEqual(refused({ outcome: "completed" }), [REASON_AND_CODE])
    assert.deepEqual(refused({ reason: "not-presented", contaminantCodeId: OTHER }), [REASON_AND_CODE])
    assert.equal(PickupExceptionRuleCreate.safeParse({ ...create, outcome: "completed", reason: null, contaminantCodeId: OTHER }).success, true)
    assert.equal(PickupExceptionRuleCreate.safeParse({ ...create, reason: null, contaminantCodeId: OTHER }).success, true)
  })

  test("a patch moves the free count, the window, the ladder and the end, never the key or the start", () => {
    assert.deepEqual(PickupExceptionRulePatch.parse({ freeCount: 0, validTo: null }), { freeCount: 0, validTo: null })
    for (const key of ["outcome", "reason", "contaminantCodeId", "validFrom", "projectId"]) {
      assert.equal(PickupExceptionRulePatch.safeParse({ [key]: null }).success, false, key)
    }
  })
})

describe("the exception history", () => {
  test("names the stop, what it was missed or tagged for, its evidence and the rules' judgement, null where none governs it", () => {
    const exception = {
      pickupId: ID,
      routeId: OTHER,
      projectId: ID,
      serviceDate: "2026-10-05",
      status: "failed",
      reason: "contamination",
      contaminantCodeId: OTHER,
      origin: "generation",
      service: "empty",
      propertyId: OTHER,
      sharedCollectionPointId: null,
      evidenceProofId: ID,
      judgement: { ruleId: ID, index: 1, free: false, productId: OTHER },
    }
    assert.deepEqual(PickupException.parse(exception), exception)
    assert.deepEqual(PickupException.parse({ ...exception, judgement: null }).judgement, null)
    assert.equal(PickupExceptionHistory.safeParse({ items: Array(PICKUP_EXCEPTION_HISTORY_MAX + 1).fill(exception), truncated: true }).success, false, "a history is bounded")
  })
})

describe("the correction's code", () => {
  test("tags a stop missed for contamination, or one collected all the same, and nothing else", () => {
    assert.equal(PickupCorrection.safeParse({ outcome: "failed", reason: "contamination", note: "Bags of plastic", contaminantCodeId: ID }).success, true)
    assert.equal(PickupCorrection.safeParse({ outcome: "completed", note: "Emptied, but plastic in it", contaminantCodeId: ID }).success, true)
    assert.equal(PickupCorrection.safeParse({ outcome: "failed", reason: "inaccessible", note: "x", contaminantCodeId: null }).success, true, "null leaves it untagged")
    const refused = PickupCorrection.safeParse({ outcome: "failed", reason: "inaccessible", note: "x", contaminantCodeId: ID })
    assert.deepEqual(refused.error?.issues.map((issue) => [issue.path.join("."), issue.message]), [["contaminantCodeId", CODE_WITH_CONTAMINATION]])
  })
})
