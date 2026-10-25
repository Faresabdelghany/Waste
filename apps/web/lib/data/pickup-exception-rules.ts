// Settings › Commercial › Exception charges (M5 of #293): a project's charge
// rules for Pickup Exceptions — the outcome a rule governs, the customer's
// reason and the contaminant code it narrows to, how many matching exceptions
// in its window cost nothing, and the ladder of products charged by
// occurrence once they are spent, the last repeating — as a form a person
// fills, and the bodies `POST /pickup-exception-rules` and `PATCH
// /pickup-exception-rules/:id` take. The pane reads and writes the API
// directly (components/settings/pickup-exception-charges-settings.tsx), as
// the ticket SLA's does: a rule is a project's configuration, not a module's
// record. A rule's outcome, reason, code and start are its key, so an edit
// moves the free count, the window, the ladder and the end alone — end a rule
// and add another. A form the API would refuse is refused here first, at the
// field, in the API's sentence.
import type { ContaminantCode, PickupExceptionRule, PickupExceptionRuleCreate, PickupExceptionRulePatch } from "@waste/contracts/pickup-exceptions"
import type { Product } from "@waste/contracts/catalogue"
import { PICKUP_EXCEPTION_REASONS, type PickupOutcome } from "@waste/domain/execution/vocabulary"

import { allows, type Grants } from "../api/grants"
import { statusLabel } from "../api/records/adapter"
import { firstDayOut, lastDayIn } from "../api/records/planning"

/** The pane, offered on the Pilot alone: the rules are the API's. */
export const PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID = "pickup-exception-charges"

/** The reason and code pickers' value for any: the wire's null. */
export const ANY = "any"

/** The bounds the contracts hold a rule to, spelled again since the web imports no zod; a test holds them to the contracts. */
export const FREE_COUNT_MAX = 100
export const WINDOW_DAYS_MAX = 3660
export const LADDER_MAX = 10

export type RuleOption = { value: string; label: string }

/** The outcomes a rule governs: a stop missed for the customer, or one collected and tagged with a code. */
export const RULE_OUTCOME_OPTIONS: readonly RuleOption[] = [
  { value: "skipped", label: "Skipped" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Collected, tagged with a code" },
]

export const RULE_REASON_OPTIONS: readonly RuleOption[] = [{ value: ANY, label: "Any of the customer's reasons" }, ...PICKUP_EXCEPTION_REASONS.map((reason) => ({ value: reason, label: statusLabel(reason) }))]

export const FREE_COUNT_SENTENCE = `Give the free count as a whole number from 0 to ${FREE_COUNT_MAX}`
export const WINDOW_SENTENCE = `Give the window as a whole number of days from 1 to ${WINDOW_DAYS_MAX}`
export const LADDER_SENTENCE = `Charge between 1 and ${LADDER_MAX} products, picking one on every step`
export const START_SENTENCE = "Give the first day the rule is in force"
export const LAST_DAY_SENTENCE = "The last day in force comes on or after the first"
/** The contracts' `REASON_AND_CODE`, spelled again; a test holds the two equal. */
export const REASON_AND_CODE = "A tagged collection's rule names no reason, and a code goes with contamination or any reason"

/** A rule as the form holds it: the picks and the numbers as typed, the ladder's steps by product id ("" for a step not picked yet), the end as the last day in. */
export type RuleForm = {
  outcome: string
  reason: string
  contaminantCodeId: string
  freeCount: string
  windowDays: string
  ladder: string[]
  validFrom: string
  lastDay: string
}

export type RuleField = keyof RuleForm
/** What the form refuses before the API sees it: the field, the step where it is the ladder's, and why. */
export type RuleRefusal = { field: RuleField; step?: number; message: string }

export const isRuleRefusal = (value: object): value is RuleRefusal => "field" in value && "message" in value

/** A new rule's form: a skip for any of the customer's reasons, one free over a year, starting on the project's day. */
export const newRuleForm = (today: string): RuleForm => ({ outcome: "skipped", reason: ANY, contaminantCodeId: ANY, freeCount: "1", windowDays: "365", ladder: [""], validFrom: today, lastDay: "" })

/** A rule's form as it stands, for its edit. */
export const ruleFormOf = (rule: PickupExceptionRule): RuleForm => ({
  outcome: rule.outcome,
  reason: rule.reason ?? ANY,
  contaminantCodeId: rule.contaminantCodeId ?? ANY,
  freeCount: String(rule.freeCount),
  windowDays: String(rule.windowDays),
  ladder: [...rule.ladder],
  validFrom: rule.validFrom,
  lastDay: rule.validTo === null ? "" : lastDayIn(rule.validTo),
})

/** Whether a rule of the form's outcome and reason may narrow to a code: a tagged collection's, or a skip or a failure for contamination or any reason. */
export const codeOffered = (form: Pick<RuleForm, "outcome" | "reason">): boolean => form.outcome === "completed" || form.reason === ANY || form.reason === "contamination"

/** The form after a pick that moves what the others may say: a tagged collection names no reason, and a reason other than contamination no code. */
export function withPick(form: RuleForm, values: Partial<RuleForm>): RuleForm {
  const next = { ...form, ...values }
  const reason = next.outcome === "completed" ? ANY : next.reason
  return { ...next, reason, contaminantCodeId: codeOffered({ outcome: next.outcome, reason }) ? next.contaminantCodeId : ANY }
}

const wholeIn = (typed: string, min: number, max: number): number | null => {
  const trimmed = typed.trim()
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return value >= min && value <= max ? value : null
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The parts a create and an edit share: the free count, the window, the ladder and the end, or the first field the API would refuse. */
function termsOf(form: RuleForm): { freeCount: number; windowDays: number; ladder: string[]; validTo: string | null } | RuleRefusal {
  const freeCount = wholeIn(form.freeCount, 0, FREE_COUNT_MAX)
  if (freeCount === null) return { field: "freeCount", message: FREE_COUNT_SENTENCE }
  const windowDays = wholeIn(form.windowDays, 1, WINDOW_DAYS_MAX)
  if (windowDays === null) return { field: "windowDays", message: WINDOW_SENTENCE }
  if (form.ladder.length === 0 || form.ladder.length > LADDER_MAX) return { field: "ladder", message: LADDER_SENTENCE }
  const unpicked = form.ladder.findIndex((id) => id === "")
  if (unpicked !== -1) return { field: "ladder", step: unpicked, message: LADDER_SENTENCE }
  const lastDay = form.lastDay.trim()
  if (lastDay !== "" && (!ISO_DAY.test(lastDay) || lastDay < form.validFrom)) return { field: "lastDay", message: LAST_DAY_SENTENCE }
  return { freeCount, windowDays, ladder: [...form.ladder], validTo: lastDay === "" ? null : firstDayOut(lastDay) }
}

/** The body a new rule's form becomes, or the first field the API would refuse. */
export function ruleCreateBodyOf(projectId: string, form: RuleForm): PickupExceptionRuleCreate | RuleRefusal {
  const outcome = form.outcome as PickupOutcome
  const reason = form.reason === ANY ? null : (form.reason as PickupExceptionRuleCreate["reason"])
  const contaminantCodeId = form.contaminantCodeId === ANY ? null : form.contaminantCodeId
  if ((outcome === "completed" && reason !== null) || (contaminantCodeId !== null && reason !== null && reason !== "contamination")) return { field: "reason", message: REASON_AND_CODE }
  if (!ISO_DAY.test(form.validFrom.trim())) return { field: "validFrom", message: START_SENTENCE }
  const terms = termsOf({ ...form, validFrom: form.validFrom.trim() })
  if (isRuleRefusal(terms)) return terms
  return { projectId, outcome, reason, contaminantCodeId, freeCount: terms.freeCount, windowDays: terms.windowDays, ladder: terms.ladder, validFrom: form.validFrom.trim(), ...(terms.validTo === null ? {} : { validTo: terms.validTo }) }
}

/** The patch an edited form becomes — the members it moved alone, the ladder whole where any step moved — null where it moved nothing, or the first field the API would refuse. */
export function rulePatchBodyOf(rule: PickupExceptionRule, form: RuleForm): PickupExceptionRulePatch | RuleRefusal | null {
  const terms = termsOf({ ...form, validFrom: rule.validFrom })
  if (isRuleRefusal(terms)) return terms
  const ladderMoved = terms.ladder.length !== rule.ladder.length || terms.ladder.some((id, index) => id !== rule.ladder[index])
  const patch: PickupExceptionRulePatch = {
    ...(terms.freeCount === rule.freeCount ? {} : { freeCount: terms.freeCount }),
    ...(terms.windowDays === rule.windowDays ? {} : { windowDays: terms.windowDays }),
    ...(ladderMoved ? { ladder: terms.ladder } : {}),
    ...(terms.validTo === rule.validTo ? {} : { validTo: terms.validTo }),
  }
  return Object.keys(patch).length === 0 ? null : patch
}

/** The products a ladder's step may charge: the project's additional services sold per job that are active, and on an edit the steps the rule already charges, whatever their status now. */
export function ladderProductOptions(products: readonly Product[], projectId: string, kept: readonly string[] = []): Product[] {
  return products.filter((product) => product.projectId === projectId && product.kind === "additional-service" && product.unit === "job" && (product.status === "active" || kept.includes(product.id)))
}

/** The codes a rule may narrow to: the active ones, and on an edit the one it already names. */
export const ruleCodeOptions = (codes: readonly ContaminantCode[], kept: string | null = null): ContaminantCode[] => codes.filter((code) => code.status === "active" || code.id === kept)

const ORDINALS = ["1st", "2nd", "3rd"]
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`

/** What a rule matches, in a sentence: "Skipped for contamination", "Failed for any of the customer's reasons", "Collected, tagged Glass in residual". */
export function ruleMatchSentence(rule: Pick<PickupExceptionRule, "outcome" | "reason" | "contaminantCodeId">, codeName: (id: string) => string): string {
  const code = rule.contaminantCodeId === null ? null : codeName(rule.contaminantCodeId)
  if (rule.outcome === "completed") return code === null ? "Collected, tagged with any code" : `Collected, tagged ${code}`
  const outcome = statusLabel(rule.outcome)
  const reason = rule.reason === null ? "for any of the customer's reasons" : `for ${statusLabel(rule.reason).toLowerCase()}`
  return code === null ? `${outcome} ${reason}` : `${outcome} ${reason}, coded ${code}`
}

/** What a ladder charges, in a sentence: "Contamination fee each time", or "1st Fee A · 2nd Fee B · then Fee B each time". */
export function ladderSentence(ladder: readonly string[], productName: (id: string) => string): string {
  if (ladder.length === 1) return `${productName(ladder[0])} each time`
  const steps = ladder.slice(0, -1).map((id, index) => `${ordinal(index + 1)} ${productName(id)}`)
  return [...steps, `then ${productName(ladder[ladder.length - 1])} each time`].join(" · ")
}

/** What the free count and window say: "First one free in 365 days", "None free in 90 days". */
export function allowanceSentence(rule: Pick<PickupExceptionRule, "freeCount" | "windowDays">): string {
  const days = rule.windowDays === 1 ? "1 day" : `${rule.windowDays} days`
  if (rule.freeCount === 0) return `None free · counted over ${days}`
  return `${rule.freeCount === 1 ? "First one" : `First ${rule.freeCount}`} free · counted over ${days}`
}

/** The rules in the order the pane lists them: by outcome as the picker offers them, then the latest start first. */
export function rulesInOrder(rules: readonly PickupExceptionRule[]): PickupExceptionRule[] {
  const rank = (outcome: string) => RULE_OUTCOME_OPTIONS.findIndex((option) => option.value === outcome)
  return [...rules].sort((a, b) => rank(a.outcome) - rank(b.outcome) || (a.validFrom === b.validFrom ? a.id.localeCompare(b.id) : a.validFrom < b.validFrom ? 1 : -1))
}

/** What the person's role lets them do with the rules — the price rows' module, the API's grant for them — and whether it reads the products and the codes the rules name. */
export const ruleAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, "commercial.price-rows", "view"),
  create: allows(grants, "commercial.price-rows", "create"),
  edit: allows(grants, "commercial.price-rows", "edit"),
  products: allows(grants, "commercial.products", "view"),
  codes: allows(grants, "configure.master", "view"),
})
