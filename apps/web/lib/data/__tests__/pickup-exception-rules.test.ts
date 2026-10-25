// Settings › Commercial › Exception charges' form (M5 of #293): a project's
// charge rules as a form a person fills, the create and patch bodies it
// becomes — held to the contracts — refused where the API would refuse
// them, at the field, and the sentences the pane reads a rule in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Product } from "@waste/contracts/catalogue"
import { PickupExceptionRule, PickupExceptionRuleCreate, PickupExceptionRulePatch, REASON_AND_CODE as CONTRACTS_REASON_AND_CODE, type ContaminantCode } from "@waste/contracts/pickup-exceptions"
import { PICKUP_EXCEPTION_REASONS } from "@waste/domain/execution/vocabulary"

import { allowanceSentence, ANY, codeOffered, FREE_COUNT_MAX, FREE_COUNT_SENTENCE, LADDER_MAX, LADDER_SENTENCE, ladderProductOptions, ladderSentence, LAST_DAY_SENTENCE, newRuleForm, REASON_AND_CODE, RULE_OUTCOME_OPTIONS, RULE_REASON_OPTIONS, ruleAccessOf, ruleCodeOptions, ruleCreateBodyOf, ruleFormOf, ruleMatchSentence, rulePatchBodyOf, rulesInOrder, START_SENTENCE, WINDOW_DAYS_MAX, WINDOW_SENTENCE, withPick, type RuleForm } from "../pickup-exception-rules"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER_PROJECT = "01a0d3a5-e5e0-7000-8000-000000000002"
const FEE = "01a0d3a5-e5e0-7000-8000-0000000000f1"
const SECOND_FEE = "01a0d3a5-e5e0-7000-8000-0000000000f2"
const CODE = "01a0d3a5-e5e0-7000-8000-0000000000c1"
const RULE = "01a0d3a5-e5e0-7000-8000-0000000000a1"
const STAMP = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }

const rule = (values: Partial<PickupExceptionRule> = {}): PickupExceptionRule => ({
  id: RULE,
  ...STAMP,
  projectId: PROJECT,
  outcome: "skipped",
  reason: "contamination",
  contaminantCodeId: null,
  freeCount: 1,
  windowDays: 365,
  ladder: [FEE, SECOND_FEE],
  validFrom: "2026-01-01",
  validTo: null,
  ...values,
})

const form = (values: Partial<RuleForm> = {}): RuleForm => ({ ...newRuleForm("2026-03-01"), ladder: [FEE], ...values })

const product = (id: string, values: Partial<Product> = {}): Product => ({
  id,
  ...STAMP,
  projectId: PROJECT,
  name: id === FEE ? "Contamination fee" : "Second contamination fee",
  kind: "additional-service",
  status: "active",
  unit: "job",
  containerTypeId: null,
  wasteFractionId: null,
  serviceFrequencyId: null,
  invoiceName: null,
  invoiceCode: null,
  vatPercent: 25,
  freeDays: null,
  ...values,
})

const code = (id: string, status: ContaminantCode["status"]): ContaminantCode => ({ id, ...STAMP, code: `code-${status}`, name: `Code ${status}`, status, wasteFractionIds: [] })

describe("the pickers", () => {
  test("offer the three outcomes a rule governs, and any reason first, then the customer's four in the vocabulary's order", () => {
    assert.deepEqual(RULE_OUTCOME_OPTIONS.map((option) => option.value), ["skipped", "failed", "completed"])
    assert.deepEqual(RULE_REASON_OPTIONS[0], { value: ANY, label: "Any of the customer's reasons" })
    assert.deepEqual(RULE_REASON_OPTIONS.slice(1).map((option) => option.value), [...PICKUP_EXCEPTION_REASONS])
    assert.equal(RULE_REASON_OPTIONS.find((option) => option.value === "not-presented")?.label, "Not presented")
  })

  test("a code is offered to a tagged collection, and to a skip or a failure for contamination or any reason", () => {
    assert.equal(codeOffered({ outcome: "completed", reason: ANY }), true)
    assert.equal(codeOffered({ outcome: "skipped", reason: ANY }), true)
    assert.equal(codeOffered({ outcome: "failed", reason: "contamination" }), true)
    assert.equal(codeOffered({ outcome: "skipped", reason: "not-presented" }), false)
  })

  test("a tagged collection drops the reason, and a reason that takes no code drops the code", () => {
    assert.equal(withPick(form({ reason: "inaccessible" }), { outcome: "completed" }).reason, ANY)
    assert.equal(withPick(form({ contaminantCodeId: CODE }), { reason: "not-presented" }).contaminantCodeId, ANY)
    assert.equal(withPick(form({ contaminantCodeId: CODE }), { reason: "contamination" }).contaminantCodeId, CODE)
  })

  test("a step may charge the project's active additional services sold per job, and on an edit the steps it already charges", () => {
    const products = [
      product(FEE),
      product(SECOND_FEE, { status: "inactive" }),
      product("01a0d3a5-e5e0-7000-8000-0000000000f3", { unit: "pickup" }),
      product("01a0d3a5-e5e0-7000-8000-0000000000f4", { kind: "container-collection" }),
      product("01a0d3a5-e5e0-7000-8000-0000000000f5", { projectId: OTHER_PROJECT }),
    ]
    assert.deepEqual(ladderProductOptions(products, PROJECT).map((option) => option.id), [FEE])
    assert.deepEqual(ladderProductOptions(products, PROJECT, [SECOND_FEE]).map((option) => option.id), [FEE, SECOND_FEE])
  })

  test("a rule may narrow to an active code, and on an edit to the one it names", () => {
    const retired = code("01a0d3a5-e5e0-7000-8000-0000000000c2", "inactive")
    assert.deepEqual(ruleCodeOptions([code(CODE, "active"), retired]).map((option) => option.id), [CODE])
    assert.deepEqual(ruleCodeOptions([code(CODE, "active"), retired], retired.id).map((option) => option.id), [CODE, retired.id])
  })
})

describe("a new rule's body", () => {
  test("is the contracts' create, any reason and any code as null and an open end left out", () => {
    const body = ruleCreateBodyOf(PROJECT, form())
    assert.deepEqual(body, { projectId: PROJECT, outcome: "skipped", reason: null, contaminantCodeId: null, freeCount: 1, windowDays: 365, ladder: [FEE], validFrom: "2026-03-01" })
    assert.equal(PickupExceptionRuleCreate.safeParse(body).success, true)
  })

  test("names the reason, the code, the ladder in order and the end as the first day out", () => {
    const body = ruleCreateBodyOf(PROJECT, form({ outcome: "failed", reason: "contamination", contaminantCodeId: CODE, freeCount: "0", windowDays: "90", ladder: [FEE, SECOND_FEE, FEE], lastDay: "2026-12-31" }))
    assert.deepEqual(body, { projectId: PROJECT, outcome: "failed", reason: "contamination", contaminantCodeId: CODE, freeCount: 0, windowDays: 90, ladder: [FEE, SECOND_FEE, FEE], validFrom: "2026-03-01", validTo: "2027-01-01" })
    assert.equal(PickupExceptionRuleCreate.safeParse(body).success, true)
  })

  test("a tagged collection's rule names no reason", () => {
    const body = ruleCreateBodyOf(PROJECT, form({ outcome: "completed", contaminantCodeId: CODE }))
    assert.equal(PickupExceptionRuleCreate.safeParse(body).success, true)
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ outcome: "completed", reason: "contamination" })), { field: "reason", message: REASON_AND_CODE })
  })

  test("is refused where the contracts refuse it, in their sentence at the reason", () => {
    const refused = form({ reason: "inaccessible", contaminantCodeId: CODE })
    assert.deepEqual(ruleCreateBodyOf(PROJECT, refused), { field: "reason", message: REASON_AND_CODE })
    const wire = PickupExceptionRuleCreate.safeParse({ projectId: PROJECT, outcome: "skipped", reason: "inaccessible", contaminantCodeId: CODE, freeCount: 1, windowDays: 1, ladder: [FEE], validFrom: "2026-03-01" })
    assert.equal(wire.success, false)
    assert.deepEqual(wire.error?.issues.map((issue) => [issue.path.join("."), issue.message]), [["reason", REASON_AND_CODE]])
    assert.equal(REASON_AND_CODE, CONTRACTS_REASON_AND_CODE)
  })

  test("refuses each number outside the contracts' bounds at its field, as the contracts do", () => {
    for (const typed of ["-1", "1.5", "", "x", String(FREE_COUNT_MAX + 1)]) assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ freeCount: typed })), { field: "freeCount", message: FREE_COUNT_SENTENCE }, typed)
    for (const typed of ["0", "", String(WINDOW_DAYS_MAX + 1)]) assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ windowDays: typed })), { field: "windowDays", message: WINDOW_SENTENCE }, typed)
    const edge = ruleCreateBodyOf(PROJECT, form({ freeCount: String(FREE_COUNT_MAX), windowDays: String(WINDOW_DAYS_MAX), ladder: Array.from({ length: LADDER_MAX }, () => FEE) }))
    assert.equal(PickupExceptionRuleCreate.safeParse(edge).success, true)
    const wire = (values: object) => PickupExceptionRuleCreate.safeParse({ projectId: PROJECT, outcome: "skipped", freeCount: 1, windowDays: 1, ladder: [FEE], validFrom: "2026-03-01", ...values }).success
    assert.equal(wire({ freeCount: FREE_COUNT_MAX + 1 }), false)
    assert.equal(wire({ windowDays: WINDOW_DAYS_MAX + 1 }), false)
    assert.equal(wire({ ladder: Array.from({ length: LADDER_MAX + 1 }, () => FEE) }), false)
  })

  test("refuses an empty ladder, one too long, and a step not picked, at the step", () => {
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ ladder: [] })), { field: "ladder", message: LADDER_SENTENCE })
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ ladder: Array.from({ length: LADDER_MAX + 1 }, () => FEE) })), { field: "ladder", message: LADDER_SENTENCE })
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ ladder: [FEE, ""] })), { field: "ladder", step: 1, message: LADDER_SENTENCE })
  })

  test("refuses a missing start, and a last day before it; a rule of one day ends on its first", () => {
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ validFrom: "" })), { field: "validFrom", message: START_SENTENCE })
    assert.deepEqual(ruleCreateBodyOf(PROJECT, form({ lastDay: "2026-02-28" })), { field: "lastDay", message: LAST_DAY_SENTENCE })
    const oneDay = ruleCreateBodyOf(PROJECT, form({ lastDay: "2026-03-01" }))
    assert.deepEqual(oneDay, { ...(ruleCreateBodyOf(PROJECT, form()) as object), validTo: "2026-03-02" })
    assert.equal(PickupExceptionRuleCreate.safeParse(oneDay).success, true)
  })
})

describe("an edit's patch", () => {
  test("opens on the rule as it stands, its end as the last day in", () => {
    assert.deepEqual(ruleFormOf(rule({ contaminantCodeId: CODE, validTo: "2027-01-01" })), {
      outcome: "skipped",
      reason: "contamination",
      contaminantCodeId: CODE,
      freeCount: "1",
      windowDays: "365",
      ladder: [FEE, SECOND_FEE],
      validFrom: "2026-01-01",
      lastDay: "2026-12-31",
    })
    assert.equal(ruleFormOf(rule({ reason: null })).reason, ANY)
  })

  test("is nothing where the form moved nothing", () => {
    assert.equal(rulePatchBodyOf(rule(), ruleFormOf(rule())), null)
    assert.equal(rulePatchBodyOf(rule({ validTo: "2027-01-01" }), ruleFormOf(rule({ validTo: "2027-01-01" }))), null)
  })

  test("names only what moved, the ladder whole, and is the contracts' patch", () => {
    const patch = rulePatchBodyOf(rule(), { ...ruleFormOf(rule()), freeCount: "2", ladder: [FEE] })
    assert.deepEqual(patch, { freeCount: 2, ladder: [FEE] })
    assert.equal(PickupExceptionRulePatch.safeParse(patch).success, true)
    assert.deepEqual(rulePatchBodyOf(rule(), { ...ruleFormOf(rule()), ladder: [SECOND_FEE, FEE] }), { ladder: [SECOND_FEE, FEE] })
  })

  test("ends a running rule on its last day, and reopens an ended one with null", () => {
    assert.deepEqual(rulePatchBodyOf(rule(), { ...ruleFormOf(rule()), lastDay: "2026-06-30" }), { validTo: "2026-07-01" })
    const reopened = rulePatchBodyOf(rule({ validTo: "2026-07-01" }), { ...ruleFormOf(rule({ validTo: "2026-07-01" })), lastDay: "" })
    assert.deepEqual(reopened, { validTo: null })
    assert.equal(PickupExceptionRulePatch.safeParse(reopened).success, true)
  })

  test("judges the last day against the rule's own start, and refuses as a create does", () => {
    assert.deepEqual(rulePatchBodyOf(rule(), { ...ruleFormOf(rule()), validFrom: "2030-01-01", lastDay: "2025-12-31" }), { field: "lastDay", message: LAST_DAY_SENTENCE })
    assert.deepEqual(rulePatchBodyOf(rule(), { ...ruleFormOf(rule()), windowDays: "0" }), { field: "windowDays", message: WINDOW_SENTENCE })
  })
})

describe("the sentences a rule is read in", () => {
  const names: Record<string, string> = { [FEE]: "Contamination fee", [SECOND_FEE]: "Second fee", [CODE]: "Glass in residual" }
  const name = (id: string) => names[id] ?? id

  test("say what it matches", () => {
    assert.equal(ruleMatchSentence(rule(), name), "Skipped for contamination")
    assert.equal(ruleMatchSentence(rule({ outcome: "failed", reason: null }), name), "Failed for any of the customer's reasons")
    assert.equal(ruleMatchSentence(rule({ reason: "not-presented" }), name), "Skipped for not presented")
    assert.equal(ruleMatchSentence(rule({ contaminantCodeId: CODE }), name), "Skipped for contamination, coded Glass in residual")
    assert.equal(ruleMatchSentence(rule({ outcome: "completed", reason: null, contaminantCodeId: CODE }), name), "Collected, tagged Glass in residual")
    assert.equal(ruleMatchSentence(rule({ outcome: "completed", reason: null }), name), "Collected, tagged with any code")
  })

  test("say what the ladder charges, the last step repeating", () => {
    assert.equal(ladderSentence([FEE], name), "Contamination fee each time")
    assert.equal(ladderSentence([FEE, SECOND_FEE], name), "1st Contamination fee · then Second fee each time")
    assert.equal(ladderSentence([FEE, FEE, FEE, SECOND_FEE], name), "1st Contamination fee · 2nd Contamination fee · 3rd Contamination fee · then Second fee each time")
  })

  test("say how many are free over how long", () => {
    assert.equal(allowanceSentence(rule()), "First one free · counted over 365 days")
    assert.equal(allowanceSentence(rule({ freeCount: 0, windowDays: 1 })), "None free · counted over 1 day")
    assert.equal(allowanceSentence(rule({ freeCount: 3, windowDays: 90 })), "First 3 free · counted over 90 days")
  })

  test("list the rules by outcome as the picker offers them, the latest start first", () => {
    const later = rule({ id: "01a0d3a5-e5e0-7000-8000-0000000000a2", validFrom: "2026-06-01" })
    const tagged = rule({ id: "01a0d3a5-e5e0-7000-8000-0000000000a3", outcome: "completed", reason: null })
    const failed = rule({ id: "01a0d3a5-e5e0-7000-8000-0000000000a4", outcome: "failed" })
    assert.deepEqual(rulesInOrder([tagged, rule(), failed, later]).map((each) => each.id), [later.id, RULE, failed.id, tagged.id])
  })

  test("a rule read off the wire parses as the contracts' rule", () => {
    assert.equal(PickupExceptionRule.safeParse(rule()).success, true)
  })
})

describe("the role", () => {
  test("reads and writes the rules under the price rows' grants, and the names under the products' and master data's", () => {
    const access = ruleAccessOf([
      { moduleKey: "commercial.price-rows", actions: ["view", "create"] },
      { moduleKey: "configure.master", actions: ["view"] },
    ])
    assert.deepEqual(access, { view: true, create: true, edit: false, products: false, codes: true })
    assert.deepEqual(ruleAccessOf(undefined), { view: false, create: false, edit: false, products: false, codes: false })
  })
})
