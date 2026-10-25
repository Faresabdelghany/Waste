// Customers › Applications on the web (M7 of #293): the words the module
// reads an Application and its Decision in, the decide form, and the body it
// becomes — refused at the field where the API would refuse it, in the
// domain's sentences — the commands a row's status offers, and the decision
// letter a decided one prints. The adapter is lib/api/records/applications.ts;
// the rules are @waste/domain/registry/applications'.
import type { ApplicationDecide } from "@waste/contracts/applications"
import { APPEAL_TEXT_NEEDED, appealTextNeeded, decisionPeriodRefusal, moveOf, type ApplicationCommand } from "@waste/domain/registry/applications"
import { APPLICATION_CHANNELS, APPLICATION_KINDS, APPLICATION_STATUSES, DECISION_OUTCOMES, type ApplicationKind, type DecisionOutcome } from "@waste/domain/registry/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import type { LocalRefusal } from "../api/records/adapter"
import type { BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"

/** Where the Applications live: the customers' workspace, the module the API's grant names. */
export const APPLICATIONS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "applications" }

/** What a person calls each kind. */
export const KIND_LABELS: Readonly<Record<ApplicationKind, string>> = {
  exemption: "Exemption",
  pause: "Pause",
  "longer-interval": "Longer interval",
  "home-composting": "Home composting",
  "shared-bin": "Shared bin",
  "assisted-collection": "Assisted collection",
  "fee-correction": "Fee correction",
}

const CHANNEL_LABELS: Readonly<Record<(typeof APPLICATION_CHANNELS)[number], string>> = { phone: "Phone", email: "Email", letter: "Letter", counter: "At the counter", portal: "Portal" }
const OUTCOME_LABELS: Readonly<Record<DecisionOutcome, string>> = { granted: "Granted", "partly-granted": "Partly granted", refused: "Refused" }

export const KIND_OPTIONS: readonly BusinessFormOption[] = APPLICATION_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))
export const CHANNEL_OPTIONS: readonly BusinessFormOption[] = APPLICATION_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }))
export const OUTCOME_OPTIONS: readonly BusinessFormOption[] = DECISION_OUTCOMES.map((outcome) => ({ value: outcome, label: OUTCOME_LABELS[outcome] }))

export const channelLabel = (channel: string): string => CHANNEL_LABELS[channel as keyof typeof CHANNEL_LABELS] ?? channel
export const outcomeLabel = (outcome: string): string => OUTCOME_LABELS[outcome as DecisionOutcome] ?? outcome
export const kindLabel = (kind: string): string => KIND_LABELS[kind as ApplicationKind] ?? kind

/** The decide dialog: the outcome, what it holds the customer to, the grant's first and last day in force, and how to appeal anything less than a grant in full. */
export const DECIDE_FORM: BusinessFormSchema = {
  key: "customers.applications.decide",
  mode: "create",
  recordKind: "Decision",
  title: "Decide the application",
  description: "The office's verdict. A grant is in force from its first day; a refusal has no period; anything less than a grant in full tells the customer how to appeal it.",
  submitLabel: "Record decision",
  nameField: "outcome",
  contextFieldIds: [],
  sections: [
    {
      id: "decision",
      title: "Decision",
      fields: [
        { id: "outcome", label: "Outcome", type: "select", required: true, defaultValue: "granted", options: OUTCOME_OPTIONS },
        { id: "conditions", label: "Conditions or reasons", type: "textarea", description: "What a grant holds the customer to, or why it was refused." },
        { id: "validFrom", label: "First day in force", type: "date", visibleWhen: { fieldId: "outcome", oneOf: ["granted", "partly-granted"] }, requiredWhen: { fieldId: "outcome", oneOf: ["granted", "partly-granted"] } },
        { id: "lastDay", label: "Last day in force", type: "date", visibleWhen: { fieldId: "outcome", oneOf: ["granted", "partly-granted"] }, description: "Blank for a grant until it is ended." },
        { id: "appealText", label: "How to appeal", type: "textarea", visibleWhen: { fieldId: "outcome", oneOf: ["partly-granted", "refused"] }, requiredWhen: { fieldId: "outcome", oneOf: ["partly-granted", "refused"] } },
      ],
    },
  ],
  execution: { kind: "create-record", initialStatus: "Decided", completionMessage: "Decision recorded." },
}

export const LAST_DAY_SENTENCE = "The last day in force comes on or after the first"
export const NOT_A_DAY = "Pick a day from the calendar"

/** A field's text, undefined where it is blank. */
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)
/** A day as a date field holds it, `YYYY-MM-DD`; undefined for anything else. */
export const dayOf = (value: unknown): string | undefined => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined)

/** A grant's period as the office reads it, by its last day in force where the wire's `validTo` is the first day out (ADR-0005): "From 2026-11-09", "2026-11-09 to 2026-12-31". */
export function periodText(validFrom: string, validTo: string | null): string {
  return validTo === null ? `From ${validFrom}` : `${validFrom} to ${addDays(validTo, -1)}`
}

/** The body the decide form becomes, or the field the API would refuse and why: a day the field does not hold, the period by the outcome, the end after the start, the appeal text where it is needed. A refusal's period fields are dropped, since the form hides them. */
export function decideBodyOf(values: BusinessFormValues): ApplicationDecide | LocalRefusal {
  const outcome = (DECISION_OUTCOMES as readonly string[]).includes(String(values.outcome)) ? (values.outcome as DecisionOutcome) : undefined
  if (outcome === undefined) return { path: "outcome", message: "Pick the outcome" }
  const granting = outcome !== "refused"
  for (const field of ["validFrom", "lastDay"] as const) {
    if (granting && textOf(values[field]) !== undefined && dayOf(values[field]) === undefined) return { path: field, message: NOT_A_DAY }
  }
  const validFrom = granting ? (dayOf(values.validFrom) ?? null) : null
  const lastDay = granting ? (dayOf(values.lastDay) ?? null) : null
  const period = decisionPeriodRefusal({ outcome, validFrom, validTo: null })
  if (period !== null) return period
  if (lastDay !== null && validFrom !== null && lastDay < validFrom) return { path: "lastDay", message: LAST_DAY_SENTENCE }
  const appealText = textOf(values.appealText) ?? null
  if (appealTextNeeded(outcome) && appealText === null) return { path: "appealText", message: APPEAL_TEXT_NEEDED }
  const conditions = textOf(values.conditions) ?? null
  return {
    outcome,
    ...(conditions === null ? {} : { conditions }),
    ...(validFrom === null ? {} : { validFrom }),
    // The last day in force, as the form spells it, is the wire's first day out (ADR-0005). The domain's addDays, not planning.ts's
    // firstDayOut: the records module reaches the form schemas, which import this file's options, and the cycle meets them uninitialised.
    ...(lastDay === null ? {} : { validTo: addDays(lastDay, 1) }),
    ...(appealTextNeeded(outcome) ? { appealText } : {}),
  }
}

/**
 * What the record carries beside the form's values for its commands and its
 * letter: the wire status, the server's id (what the letter's address names,
 * since the store's web id of a row made this session is that session's
 * alone), and the latest Decision as JSON, empty while undecided.
 */
export const APPLICATION_STATUS_KEY = "status"
export const APPLICATION_SERVER_ID_KEY = "applicationId"
export const DECISION_KEY = "latestDecision"

/** The latest Decision as the record carries it: its outcome, period, words, and the day it was made on the project's clock. */
export type RecordedDecision = { id: string; outcome: DecisionOutcome; conditions: string | null; validFrom: string | null; validTo: string | null; appealText: string | null; decidedOn: string }

/** The record's latest Decision, or null while undecided (or for a value this file did not write). */
export function recordedDecisionOf(record: Pick<BusinessRecord, "submittedValues">): RecordedDecision | null {
  const raw = record.submittedValues?.[DECISION_KEY]
  if (typeof raw !== "string" || raw === "") return null
  try {
    const decision = JSON.parse(raw) as RecordedDecision
    return DECISION_OUTCOMES.includes(decision.outcome) ? decision : null
  } catch {
    return null
  }
}

const statusOf = (record: Pick<BusinessRecord, "submittedValues">) => APPLICATION_STATUSES.find((candidate) => candidate === record.submittedValues?.[APPLICATION_STATUS_KEY])

/** Whether the generic Edit corrects the row: an undecided Application, received or in review, as the API's patch takes it. */
export function applicationCorrectable(record: Pick<BusinessRecord, "submittedValues">): boolean {
  const status = statusOf(record)
  return status === "received" || status === "in-review"
}

/** Whether the row's letter prints: a decided Application, never one reopened on an appeal, whose Decision is being reconsidered. */
export function letterOffered(record: Pick<BusinessRecord, "submittedValues">): boolean {
  return statusOf(record) === "decided" && recordedDecisionOf(record) !== null
}

const COMMAND_ORDER: readonly ApplicationCommand[] = ["review", "decide", "withdraw", "reopen"]

/** One command a row offers: its button's words and what the toast says once the API took it. */
export type ApplicationOffer = { command: ApplicationCommand; label: string; done: string }

/** The commands a row's status moves it by, in the domain's moves: a withdrawal after an appeal withdraws the appeal. */
export function applicationCommandsOffered(record: Pick<BusinessRecord, "submittedValues">): ApplicationOffer[] {
  const status = statusOf(record)
  if (status === undefined) return []
  const decided = recordedDecisionOf(record) !== null
  const words: Record<ApplicationCommand, Omit<ApplicationOffer, "command">> = {
    review: { label: "Take into review", done: "Taken into review" },
    decide: { label: "Decide", done: "Decision recorded" },
    withdraw: decided ? { label: "Withdraw appeal", done: "Appeal withdrawn; the decision stands" } : { label: "Withdraw", done: "Application withdrawn" },
    reopen: { label: "Reopen on appeal", done: "Reopened on appeal" },
  }
  return COMMAND_ORDER.filter((command) => moveOf(status, command, decided) !== null).map((command) => ({ command, ...words[command] }))
}

/** Where a decided Application's letter prints, by its server id. */
export const decisionLetterHref = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/letter`

/** A decision letter, as the page prints it: from the company to the customer, about one Application and its latest Decision. */
export type DecisionLetter = {
  sender: string
  recipient: string
  address: string | null
  date: string
  subject: string
  paragraphs: string[]
  conditions: { heading: string; text: string } | null
  appeal: string | null
}

const VERDICTS: Readonly<Record<DecisionOutcome, string>> = { granted: "Your application is granted.", "partly-granted": "Your application is granted in part.", refused: "Your application is refused." }

/**
 * The letter a decided Application prints, from its recorded Decision and
 * its own values; null for one with no Decision. The names — the customer,
 * the place — are the record's, as the module read them. The period is
 * spelled by its last day in force, as every form here spells it; a grant's
 * conditions are what it holds the customer to, a refusal's are its reasons,
 * and anything less than a grant in full ends with how to appeal it.
 */
export function decisionLetterOf(record: Pick<BusinessRecord, "facts" | "submittedValues">, parties: { company: string; address: string | null }): DecisionLetter | null {
  const decision = recordedDecisionOf(record)
  if (decision === null) return null
  const values = record.submittedValues ?? {}
  const facts = record.facts ?? {}
  const place = facts.Property ?? facts["Shared point"]
  const kind = kindLabel(String(values.kind))
  const period = decision.validFrom === null ? [] : [decision.validTo === null ? `The decision is in force from ${decision.validFrom}.` : `The decision is in force from ${decision.validFrom} up to and including ${addDays(decision.validTo, -1)}.`]
  return {
    sender: parties.company,
    recipient: facts.Customer ?? "",
    address: parties.address,
    date: decision.decidedOn,
    subject: `Decision on application ${String(values.number)}: ${kind}`,
    paragraphs: [`We received your application for ${kind.toLowerCase()} on ${String(values.receivedOn)}${place === undefined || place === "" ? "" : `, about ${place}`}.`, VERDICTS[decision.outcome], ...period],
    conditions: decision.conditions === null ? null : { heading: decision.outcome === "refused" ? "Reasons" : "Conditions", text: decision.conditions },
    appeal: decision.appealText,
  }
}
