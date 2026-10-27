// Recycling-centre visits on the web (#393, M4 of #293): the words and the
// bodies the office's surfaces and the attendant's check-in speak.
// Customers › Site access is the register of plates and cards
// (`/access-credentials`); Operate › Site visits the ledger, with Void and the
// Likely trades (`/site-visits`); `/check-in` the attendant's phone-first
// page (`POST /site-visits`, and the sites and the addresses it picks from);
// Settings › Commercial › Recycling-centre charges the project's Visit Rules
// (`/visit-rules`). The pure half lives here, so a test spells it; the
// adapters are lib/api/records/site-access.ts and site-visits.ts, the
// surfaces components/waste/commands/site-visit-surfaces.tsx, the page
// components/waste/check-in/, the pane
// components/settings/visit-rules-settings.tsx.
import type { AccessCredential, SiteVisit, SiteVisitCheckIn, SiteVisitCheckInAnswer, VisitChargeReading } from "@waste/contracts/site-visits"
import type { VisitRule, VisitRuleCreate, VisitRulePatch } from "@waste/contracts/visit-rules"
import type { BlockReason } from "@waste/domain/finance/vocabulary"
import { normaliseCredentialValue } from "@waste/domain/visits/charges"
import type { AccessCredentialKind, SiteVisitIdentification, SiteVisitOutcome, SiteVisitRefusalReason, SiteVisitSource, VisitChargeBasis } from "@waste/domain/visits/vocabulary"

import { allows, type Grants } from "@/lib/api/grants"
import { firstDayOut, lastDayIn } from "@/lib/api/records/planning"
import { formatMinor } from "@/lib/commercial/money"
import type { ModuleLocation } from "@/lib/data/business-modules"

/** Where the register is: Customers › Site access. */
export const SITE_ACCESS_MODULE = { workspaceId: "customers", moduleId: "site-access" } as const satisfies ModuleLocation

/** Where the ledger is: Operate › Site visits. */
export const SITE_VISITS_MODULE = { workspaceId: "operate", moduleId: "site-visits" } as const satisfies ModuleLocation

/** The attendant's phone-first page, where a Site attendant lands. */
export const CHECK_IN_PATH = "/check-in"

/** Settings › Commercial › Recycling-centre charges. */
export const VISIT_RULES_SETTINGS_PANE_ID = "commercial-visit-rules"

/** The record's keys the surfaces read beside the facts. */
export const CREDENTIAL_KIND_KEY = "kind"
export const CREDENTIAL_VALUE_KEY = "value"
export const CREDENTIAL_BLOCKED_KEY = "blocked"
export const VISIT_VOIDED_KEY = "voided"

export const CREDENTIAL_KIND_LABELS: Readonly<Record<AccessCredentialKind, string>> = { plate: "Plate", card: "Card" }
export const IDENTIFICATION_LABELS: Readonly<Record<SiteVisitIdentification, string>> = { plate: "Plate", card: "Card", property: "Address" }
export const SOURCE_LABELS: Readonly<Record<SiteVisitSource, string>> = { staff: "Attendant", gate: "Gate" }
export const OUTCOME_LABELS: Readonly<Record<SiteVisitOutcome, string>> = { admitted: "Admitted", refused: "Refused" }
export const REFUSAL_LABELS: Readonly<Record<SiteVisitRefusalReason, string>> = {
  "unknown-identifier": "Not registered",
  "not-fee-paying": "Not a fee-paying household",
  "credential-blocked": "Blocked",
}

/** What the attendant reads on a refused visit's card: why the visitor is turned away. */
export const REFUSAL_SENTENCES: Readonly<Record<SiteVisitRefusalReason, string>> = {
  "unknown-identifier": "No plate or card of that number is registered for this project's recycling centres.",
  "not-fee-paying": "The household pays for no collection at this address, so its visits are not covered.",
  "credential-blocked": "This plate or card is blocked. The office can say why.",
}

/** A visit's status as the ledger lists it: voided first, since a voided visit stays on the record. */
export const visitStatusOf = (visit: Pick<SiteVisit, "outcome" | "voidedAt">): string => (visit.voidedAt !== null ? "Voided" : OUTCOME_LABELS[visit.outcome])

/** A credential's status on a day: blocked first, then ended, not yet started, or in force. */
export function credentialStatusOf(credential: Pick<AccessCredential, "blockedAt" | "validFrom" | "validTo">, today: string): string {
  if (credential.blockedAt !== null) return "Blocked"
  if (credential.validTo !== null && credential.validTo <= today) return "Ended"
  if (credential.validFrom > today) return "Upcoming"
  return "In force"
}

/** "1st", "2nd", "3rd", "11th", "22nd": a visit's place in its year. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`
}

/** Why a visit costs nothing or what it costs, in a few words: the basis and the visit's place in its year. */
export function chargeBasisSentence(basis: VisitChargeBasis, n: number | null): string {
  const nth = n === null ? "" : `${ordinal(n)} visit this year`
  switch (basis) {
    case "no-rule":
      return "No Visit Rule in force: logged, charged nothing"
    case "free-fractions":
      return "Free fractions only: not counted, charged nothing"
    case "free-quota":
      return `${nth}: included`
    case "ladder":
      return nth
    case "annual-access":
      return "Business with annual access: included"
    case "per-visit":
      return "Business visit"
  }
}

/** A blocked charge's tail: why the visit's product has no price yet. */
const blockedTail = (blockReason: BlockReason | null, labels: Readonly<Record<BlockReason, string>>) => (blockReason === null ? "price not set yet" : `price not set yet (${labels[blockReason].toLowerCase()})`)

/** The answer card's line for an admitted visit — "3rd visit this year: 70,00 kr" — the price where its product has one under the visit's Agreement on its day. */
export function chargeSentence(charge: VisitChargeReading, blockLabels: Readonly<Record<BlockReason, string>>): string {
  const basis = chargeBasisSentence(charge.basis, charge.n)
  if (charge.productId === null) return basis
  if (charge.price === null) return `${basis}: ${blockedTail(charge.blockReason, blockLabels)}`
  return `${basis}: ${formatMinor(charge.price.netMinor + charge.price.vatMinor, charge.price.currency)}`
}

/** What the answer card says first: admitted or turned away, and why. */
export function answerHeadline(answer: Pick<SiteVisitCheckInAnswer, "visit">): { tone: "admitted" | "refused"; title: string; detail: string | null } {
  const { visit } = answer
  if (visit.outcome === "admitted") return { tone: "admitted", title: "Admitted", detail: null }
  const reason = visit.refusalReason ?? "unknown-identifier"
  return { tone: "refused", title: `Turned away: ${REFUSAL_LABELS[reason].toLowerCase()}`, detail: REFUSAL_SENTENCES[reason] }
}

// ---------------------------------------------------------------------------
// The check-in
// ---------------------------------------------------------------------------

/** How the attendant identifies the visitor: a plate or a card typed, or a Property found by its address. */
export type CheckInMode = AccessCredentialKind | "address"

export const CHECK_IN_MODES: readonly { value: CheckInMode; label: string }[] = [
  { value: "plate", label: "Plate" },
  { value: "card", label: "Card" },
  { value: "address", label: "Address" },
]

/** What the check-in holds once filled in. */
export type CheckInDraft = {
  siteId: string
  mode: CheckInMode
  /** The plate or the card as typed. */
  value: string
  /** The Property picked from the address search. */
  propertyId: string
  wasteFractionIds: readonly string[]
  note: string
}

/** `POST /site-visits` from the check-in, or the sentence that holds it back before the API sees it. */
export function checkInBodyOf(draft: CheckInDraft): SiteVisitCheckIn | string {
  if (draft.siteId === "") return "Pick the recycling centre you are at"
  const note = draft.note.trim()
  const rest = { wasteFractionIds: [...draft.wasteFractionIds], ...(note === "" ? {} : { note }) }
  if (draft.mode === "address") {
    if (draft.propertyId === "") return "Find the visitor's address and pick it"
    return { siteId: draft.siteId, identifier: { kind: "property", propertyId: draft.propertyId }, ...rest }
  }
  const value = normaliseCredentialValue(draft.value)
  if (value === "") return draft.mode === "plate" ? "Type the plate" : "Type the card number"
  return { siteId: draft.siteId, identifier: { kind: draft.mode, value }, ...rest }
}

/** The shortest address search the API takes. */
export const ADDRESS_QUERY_MIN = 2

/** The fractions picked, with one toggled: chips, each once. */
export const toggled = (picked: readonly string[], id: string): string[] => (picked.includes(id) ? picked.filter((candidate) => candidate !== id) : [...picked, id])

/** The site the device remembers, if the project still offers it; else the only one, else none. */
export function rememberedSite(sites: readonly { id: string }[], remembered: string | null): string {
  if (remembered !== null && sites.some((site) => site.id === remembered)) return remembered
  return sites.length === 1 ? sites[0].id : ""
}

// ---------------------------------------------------------------------------
// Visit Rules
// ---------------------------------------------------------------------------

/** What the person's role lets them do with the Visit Rules — the products' module, the API's grant for them — and whether it reads the fractions they name. */
export const visitRuleAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, "commercial.products", "view"),
  create: allows(grants, "commercial.products", "create"),
  edit: allows(grants, "commercial.products", "edit"),
  fractions: allows(grants, "configure.master", "view"),
})

/** The unit a ladder step and a business visit are sold in, and the annual access's. */
export const VISIT_UNIT = "visit"
export const ANNUAL_ACCESS_UNIT = "month"

/** A rule as its dialog edits it: every value a string, as the inputs hold them; the last day in force where the wire's `validTo` is the first day out. */
export type VisitRuleForm = {
  validFrom: string
  lastDay: string
  freeVisits: string
  /** The ladder's products, in order: the last repeats. */
  ladder: string[]
  freeFractionIds: string[]
  businessVisitProductId: string
  annualAccessProductId: string
  tradeThreshold: string
  tradeWindowDays: string
}

/** What a rule's dialog refuses, at the field it names. */
export type VisitRuleRefusal = { field: keyof VisitRuleForm; message: string }

export const isVisitRuleRefusal = (value: unknown): value is VisitRuleRefusal => typeof value === "object" && value !== null && "field" in value && "message" in value

/** No product picked: the select's value for "none". */
export const NO_PRODUCT = "none"

export const newVisitRuleForm = (today: string): VisitRuleForm => ({
  validFrom: today,
  lastDay: "",
  freeVisits: "0",
  ladder: [],
  freeFractionIds: [],
  businessVisitProductId: NO_PRODUCT,
  annualAccessProductId: NO_PRODUCT,
  tradeThreshold: "",
  tradeWindowDays: "",
})

export const visitRuleFormOf = (rule: VisitRule): VisitRuleForm => ({
  validFrom: rule.validFrom,
  lastDay: rule.validTo === null ? "" : lastDayIn(rule.validTo),
  freeVisits: String(rule.freeVisits),
  ladder: [...rule.ladder],
  freeFractionIds: [...rule.freeFractionIds],
  businessVisitProductId: rule.businessVisitProductId ?? NO_PRODUCT,
  annualAccessProductId: rule.annualAccessProductId ?? NO_PRODUCT,
  tradeThreshold: rule.tradeThreshold === null ? "" : String(rule.tradeThreshold),
  tradeWindowDays: rule.tradeWindowDays === null ? "" : String(rule.tradeWindowDays),
})

/** A whole number from `min` to `max` the form holds, or the refusal at its field. */
function wholeOf(form: VisitRuleForm, field: "freeVisits" | "tradeThreshold" | "tradeWindowDays", min: number, max: number, what: string): number | VisitRuleRefusal {
  const n = Number(form[field])
  return form[field].trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : { field, message: `Give ${what} as a whole number from ${min} to ${max}` }
}

/** The values both bodies share, or the first refusal. */
function valuesOf(form: VisitRuleForm): Omit<VisitRuleCreate, "projectId" | "validFrom" | "validTo"> & { validTo: string | null } | VisitRuleRefusal {
  const freeVisits = wholeOf(form, "freeVisits", 0, 366, "the free visits a year")
  if (isVisitRuleRefusal(freeVisits)) return freeVisits
  if (form.ladder.some((step) => step === "" || step === NO_PRODUCT)) return { field: "ladder", message: "Pick a product for each step, or remove it" }
  const trading = form.tradeThreshold.trim() !== "" || form.tradeWindowDays.trim() !== ""
  let tradeThreshold: number | null = null
  let tradeWindowDays: number | null = null
  if (trading) {
    const threshold = wholeOf(form, "tradeThreshold", 1, 1000, "the visits that flag a likely trade")
    if (isVisitRuleRefusal(threshold)) return threshold
    const window = wholeOf(form, "tradeWindowDays", 1, 366, "the window in days")
    if (isVisitRuleRefusal(window)) return window
    tradeThreshold = threshold
    tradeWindowDays = window
  }
  let validTo: string | null = null
  if (form.lastDay !== "") {
    if (form.lastDay < form.validFrom) return { field: "lastDay", message: "The last day in force comes on or after the first" }
    validTo = firstDayOut(form.lastDay)
  }
  const product = (id: string) => (id === NO_PRODUCT || id === "" ? null : id)
  return {
    freeVisits,
    ladder: [...form.ladder],
    freeFractionIds: [...form.freeFractionIds],
    businessVisitProductId: product(form.businessVisitProductId),
    annualAccessProductId: product(form.annualAccessProductId),
    tradeThreshold,
    tradeWindowDays,
    validTo,
  }
}

/** `POST /visit-rules`: the project, the period and the rule, or the first refusal. */
export function visitRuleCreateBodyOf(projectId: string, form: VisitRuleForm): VisitRuleCreate | VisitRuleRefusal {
  if (form.validFrom === "") return { field: "validFrom", message: "Pick the first day in force" }
  const values = valuesOf(form)
  if (isVisitRuleRefusal(values)) return values
  return { projectId, validFrom: form.validFrom, ...values }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, at) => value === b[at])
const sameSet = (a: readonly string[], b: readonly string[]) => sameList([...a].sort(), [...b].sort())

/** `PATCH /visit-rules/:id`: what moved — the ladder and the free fractions whole — null where nothing did, or the first refusal. The start is the rule's own. */
export function visitRulePatchBodyOf(rule: VisitRule, form: VisitRuleForm): VisitRulePatch | null | VisitRuleRefusal {
  const values = valuesOf({ ...form, validFrom: rule.validFrom })
  if (isVisitRuleRefusal(values)) return values
  const patch: VisitRulePatch = {}
  if (values.freeVisits !== rule.freeVisits) patch.freeVisits = values.freeVisits
  if (!sameList(values.ladder ?? [], rule.ladder)) patch.ladder = values.ladder
  if (!sameSet(values.freeFractionIds ?? [], rule.freeFractionIds)) patch.freeFractionIds = values.freeFractionIds
  if ((values.businessVisitProductId ?? null) !== rule.businessVisitProductId) patch.businessVisitProductId = values.businessVisitProductId ?? null
  if ((values.annualAccessProductId ?? null) !== rule.annualAccessProductId) patch.annualAccessProductId = values.annualAccessProductId ?? null
  if ((values.tradeThreshold ?? null) !== rule.tradeThreshold || (values.tradeWindowDays ?? null) !== rule.tradeWindowDays) {
    patch.tradeThreshold = values.tradeThreshold ?? null
    patch.tradeWindowDays = values.tradeWindowDays ?? null
  }
  if (values.validTo !== rule.validTo) patch.validTo = values.validTo
  return Object.keys(patch).length === 0 ? null : patch
}

/** "2 free, then Visit 70, then Visit 620 for every visit after": a household's year as the rule charges it. */
export function householdSentence(rule: Pick<VisitRule, "freeVisits" | "ladder">, productName: (id: string) => string): string {
  const free = rule.freeVisits === 0 ? "No free visits" : `${rule.freeVisits} free ${rule.freeVisits === 1 ? "visit" : "visits"} a year`
  if (rule.ladder.length === 0) return rule.freeVisits === 0 ? "Every visit included" : `${free}, then every visit included`
  const steps = rule.ladder.map(productName)
  return `${free}, then ${steps.join(", then ")}${steps.length === 1 ? " for each visit after" : " for every visit after"}`
}

/** "8 visits in 30 days", or none: the likely-trade threshold. */
export const tradeSentence = (rule: Pick<VisitRule, "tradeThreshold" | "tradeWindowDays">): string =>
  rule.tradeThreshold === null || rule.tradeWindowDays === null ? "Not flagged" : `${rule.tradeThreshold} ${rule.tradeThreshold === 1 ? "visit" : "visits"} in ${rule.tradeWindowDays} ${rule.tradeWindowDays === 1 ? "day" : "days"}`

/** A project's rules, latest start first. */
export const rulesInOrder = (rules: readonly VisitRule[]): VisitRule[] => [...rules].sort((a, b) => b.validFrom.localeCompare(a.validFrom))
