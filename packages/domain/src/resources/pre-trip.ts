// Pre-trip inspection (O13 of #290): a vehicle type's checklist, a driver's
// answers to it before or during the day, and what a failed item makes of
// the vehicle. A vehicle type carries its checklist — the items a driver
// looks at, in order, each `critical` or not — and a `pre-trip-check`
// (execution/commands.ts) answers every item once: passed, or a defect with
// what the driver saw. The answers are judged against the list the vehicle's
// type holds as the command is applied (`judgeCheck`), so a device cannot
// leave an item unanswered or answer one the list does not hold, and the check
// keeps a copy of each item's label and weight beside its answer, since the
// list is the office's to change and the check is what was looked at.
//
// A failed item is a Vehicle Defect. Any defect opens the office one ticket
// for the check (`defectTicket`), and a critical one takes the vehicle out
// of service — its status `maintenance`, which the start rule already refuses
// a route on — until the office mends it and sets it active again. A minor
// one leaves the vehicle on the road and is the ticket's alone.

/** The most items a vehicle type's checklist carries: a walk-round, not an audit. */
export const CHECKLIST_MAX = 50

/** One item of a vehicle type's checklist, as the rules read it. */
export type ChecklistItem = { id: string; label: string; critical: boolean }

/** One answer of a check, as the command carries it. */
export type CheckAnswer = { itemId: string; passed: boolean; note?: string }

/** One answer as the check keeps it: the item's label and weight copied beside what the driver said. */
export type CheckedItem = { itemId: string; label: string; critical: boolean; passed: boolean; note: string | null }

/** What a check of a vehicle comes to: its answers in the checklist's order, its defects, and whether a critical one takes the vehicle out of service. */
export type CheckVerdict = { items: CheckedItem[]; defects: CheckedItem[]; grounds: boolean }

/** Where an answer will not do, and why: the path inside the body. */
export type CheckIssue = { path: string; message: string }

/** What an answer naming no item of the list is told. */
export const NOT_ON_THE_CHECKLIST = "Not an item of this vehicle's checklist"
/** What a check that leaves an item unanswered is told. */
export const unanswered = (label: string): string => `Answer every item of the checklist: ${label} is not answered`
/** What a check answering one item twice is told. */
export const ANSWERED_TWICE = "Answer each item of the checklist once"

/**
 * The answers against the checklist the vehicle's type holds: every item
 * answered exactly once, nothing else answered. The first answer that will
 * not do is the issue, at its place in the body; else the verdict.
 */
export function judgeCheck(checklist: readonly ChecklistItem[], answers: readonly CheckAnswer[]): CheckVerdict | CheckIssue {
  const byId = new Map(checklist.map((item) => [item.id, item]))
  const seen = new Set<string>()
  for (const [index, answer] of answers.entries()) {
    if (!byId.has(answer.itemId)) return { path: `body.items.${index}.itemId`, message: NOT_ON_THE_CHECKLIST }
    if (seen.has(answer.itemId)) return { path: `body.items.${index}.itemId`, message: ANSWERED_TWICE }
    seen.add(answer.itemId)
  }
  const missing = checklist.find((item) => !seen.has(item.id))
  if (missing !== undefined) return { path: "body.items", message: unanswered(missing.label) }
  const answered = new Map(answers.map((answer) => [answer.itemId, answer]))
  const items = checklist.map((item): CheckedItem => {
    const answer = answered.get(item.id)!
    return { itemId: item.id, label: item.label, critical: item.critical, passed: answer.passed, note: answer.note ?? null }
  })
  const defects = items.filter((item) => !item.passed)
  return { items, defects, grounds: defects.some((item) => item.critical) }
}

/** Whether `judgeCheck` answered an issue rather than a verdict. */
export const isCheckIssue = (judged: CheckVerdict | CheckIssue): judged is CheckIssue => "path" in judged

/** A defect as a line of the ticket: "Brakes (critical): pulls to the left". */
const defectLine = (defect: Pick<CheckedItem, "label" | "critical" | "note">): string => `${defect.label}${defect.critical ? " (critical)" : ""}${defect.note === null ? "" : `: ${defect.note}`}`

/**
 * The office's ticket for a check that found defects: one per check, high
 * where a critical defect took the vehicle out of service, medium otherwise,
 * saying what was found, by whom, on which route and when.
 */
export function defectTicket(facts: { vehicleLabel: string; driverName: string; routeLabel: string; checkedAt: string; defects: readonly Pick<CheckedItem, "label" | "critical" | "note">[]; grounds: boolean }): {
  kind: "vehicle-defect"
  priority: "high" | "medium"
  subject: string
  description: string
} {
  const count = facts.defects.length === 1 ? "a defect" : `${facts.defects.length} defects`
  const outcome = facts.grounds
    ? `${facts.vehicleLabel} is set to maintenance and cannot start a route until it is mended and set active again.`
    : `${facts.vehicleLabel} stays in service; mend the defects at the next opportunity.`
  return {
    kind: "vehicle-defect",
    priority: facts.grounds ? "high" : "medium",
    subject: `Pre-trip check found ${count} on ${facts.vehicleLabel}`,
    description: `${facts.driverName} checked ${facts.vehicleLabel} for route ${facts.routeLabel} at ${facts.checkedAt} and found:\n${facts.defects.map((defect) => `- ${defectLine(defect)}`).join("\n")}\n\n${outcome}`,
  }
}
