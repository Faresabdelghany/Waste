// Applications and their Decisions (M7 of #293). An Application is a
// customer's written request to change how they are served or billed — an
// exemption, a pause, a longer interval, home composting, a shared bin,
// assisted collection, a fee put right — and the office decides it: granted,
// in part, or refused. A grant is in force over a half-open period
// (ADR-0005) from its first day; a refusal is in force for no period. An
// appeal reopens the Application for review and the next Decision follows
// the last, so the history keeps both.
//
// The status moves by command alone (APPLICATION_MOVES). Withdrawing a
// reopened Application withdraws the appeal, not the request: it goes back to
// `decided` with the Decision it had (`moveOf`'s `decided`). Whether a grant is
// upcoming, in force or expired is a reading of its period against a day,
// never a status anyone has to remember to change.
import { addDays } from "../route-schemes/recurrence"
import type { ApplicationKind, ApplicationStatus, DecisionOutcome } from "./vocabulary"

/** The commands that move an Application. */
export type ApplicationCommand = "review" | "decide" | "withdraw" | "reopen"

/** What each command moves an Application from, and to. */
export const APPLICATION_MOVES: Readonly<Record<ApplicationCommand, { from: readonly ApplicationStatus[]; to: ApplicationStatus }>> = {
  review: { from: ["received"], to: "in-review" },
  decide: { from: ["received", "in-review"], to: "decided" },
  withdraw: { from: ["received", "in-review"], to: "withdrawn" },
  reopen: { from: ["decided"], to: "in-review" },
}

/** The status a command moves an Application to from where it stands, or null where it may not; `decided` says it already has a Decision, so a withdrawal is of an appeal and returns it to that Decision. */
export function moveOf(status: ApplicationStatus, command: ApplicationCommand, decided = false): ApplicationStatus | null {
  const move = APPLICATION_MOVES[command]
  if (!move.from.includes(status)) return null
  return command === "withdraw" && decided ? "decided" : move.to
}

/** A status in a sentence. */
const STATUS_WORDS: Readonly<Record<ApplicationStatus, string>> = { received: "received", "in-review": "in review", decided: "decided", withdrawn: "withdrawn" }

/** What a refused move is told: "Application 12 is decided; decide takes one received or in review". */
export function moveRefusal(label: string, status: ApplicationStatus, command: ApplicationCommand): string {
  return `${label} is ${STATUS_WORDS[status]}; ${command} takes one ${APPLICATION_MOVES[command].from.map((from) => STATUS_WORDS[from]).join(" or ")}`
}

/** A Decision as it is judged: its outcome and its period, both ends null for a refusal. */
export type DecisionPeriod = { outcome: DecisionOutcome; validFrom: string | null; validTo: string | null }

export const GRANT_STARTS = "A grant names the first day it is in force"
export const REFUSAL_HAS_NO_PERIOD = "A refusal is in force for no period: give it no first or last day"

/** The first field a Decision's period breaks for its outcome, or null. That the end comes after the start is the period's own rule (ADR-0005). */
export function decisionPeriodRefusal(decision: DecisionPeriod): { path: "validFrom" | "validTo"; message: string } | null {
  if (decision.outcome === "refused") {
    if (decision.validFrom !== null) return { path: "validFrom", message: REFUSAL_HAS_NO_PERIOD }
    if (decision.validTo !== null) return { path: "validTo", message: REFUSAL_HAS_NO_PERIOD }
    return null
  }
  return decision.validFrom === null ? { path: "validFrom", message: GRANT_STARTS } : null
}

export const APPEAL_TEXT_NEEDED = "A refusal or a partial grant tells the customer how to appeal it"

/** Whether a Decision of the outcome says how to appeal it: a grant in full needs no appeal text, anything less does. */
export const appealTextNeeded = (outcome: DecisionOutcome): boolean => outcome !== "granted"

/** A Decision against a day: a refusal, or a grant upcoming, in force, or expired from its first day out. */
export type DecisionStanding = "refused" | "upcoming" | "in-force" | "expired"

export function decisionStanding(decision: DecisionPeriod, day: string): DecisionStanding {
  if (decision.outcome === "refused" || decision.validFrom === null) return "refused"
  if (day < decision.validFrom) return "upcoming"
  if (decision.validTo !== null && day >= decision.validTo) return "expired"
  return "in-force"
}

const OUTCOME_WORDS: Readonly<Record<DecisionOutcome, string>> = { granted: "Granted", "partly-granted": "Partly granted", refused: "Refused" }

/** An Application as the office reads it on a day: its status, or a decided one's outcome and where its period stands, an expired one by its last day in force. */
export function applicationReading(status: ApplicationStatus, decision: DecisionPeriod | null, day: string): string {
  if (status !== "decided" || decision === null) return STATUS_WORDS[status].charAt(0).toUpperCase() + STATUS_WORDS[status].slice(1)
  const outcome = OUTCOME_WORDS[decision.outcome]
  switch (decisionStanding(decision, day)) {
    case "refused":
      return outcome
    case "upcoming":
      return `${outcome} · from ${decision.validFrom}`
    case "in-force":
      return `${outcome} · in force`
    case "expired":
      return `${outcome} · expired ${addDays(decision.validTo as string, -1)}`
  }
}

/** What a pause's grant reads: the Application's kind and subscription, and its Decision's outcome and period. */
export type PauseGrant = { kind: ApplicationKind; subscriptionId: string | null; decision: DecisionPeriod }

/** A subscription pause to write: the subscription and the half-open period (ADR-0005), null `validTo` until it is resumed. */
export type GrantedPause = { subscriptionId: string; validFrom: string; validTo: string | null }

/**
 * The subscription pause a decided Application puts in force (M11 of #293):
 * a grant, whole or in part, of a `pause` that names a subscription pauses it
 * over the granted period, cut to today on — an office pause begins today or
 * later, and a grant decided after its first day pauses the days to come, never
 * the days gone — and to the subscription's own period. Anything else, or a
 * period with nothing left, pauses nothing.
 */
export function pauseOfGrant(grant: PauseGrant, subscription: { validFrom: string; validTo: string | null }, today: string): GrantedPause | null {
  if (grant.kind !== "pause" || grant.subscriptionId === null) return null
  const { decision } = grant
  if (decision.outcome === "refused" || decision.validFrom === null) return null
  const validFrom = [decision.validFrom, subscription.validFrom, today].sort().at(-1) as string
  const ends = [decision.validTo, subscription.validTo].filter((end): end is string => end !== null).sort()
  const validTo = ends[0] ?? null
  if (validTo !== null && validTo <= validFrom) return null
  return { subscriptionId: grant.subscriptionId, validFrom, validTo }
}
