// Container drift between generation runs (issue #41). Pure data logic — no
// UI, store, or fixture dependencies.
//
// A rule group's stops are resolved against the container base at every
// generation (matching.ts, groups.ts): the scheme stores the Stop Matching
// Rule, never its result, so a container added to the Planning Area joins the
// next run without an edit — and a container moved, retired or re-classified
// leaves it just as silently. This module is the run's memory: what each rule
// group matched at the last run, kept beside the run before it on the scheme
// record, so the next run can say how far the set moved and the Attention
// badge can show what the last run found. The stamp is evidence of a run,
// like `lastGeneratedAt`; nothing reads it as a stop source.
//
// Storage. Two JSON values in submittedValues: `lastGenerationMatches` (the
// last run) and `previousGenerationMatches` (the run before it), each
// `{ [groupId]: { rule, containerIds } }` over the scheme's RULE groups only —
// a manual group's list is the scheme's own configuration and cannot drift.
// `rule` is the signature of what the group matched under (planning area,
// fractions, vehicle type, container types), so a set is compared only with a
// set matched under the same rule: an edit that changes the rule starts the
// comparison over instead of reading as container drift. Ids are matched by
// container ids because a count would only notice a change of size — a
// container swapped for another reshapes a route just as much.
//
// Drift. For a rule group present in both stamps under one rule, the shift is
// the symmetric difference of the two id sets (containers that joined plus
// containers that left) over the size of the previous set; a previous set of
// nothing counts as one, so containers appearing where none matched is a full
// shift. A shift strictly above CONTAINER_DRIFT_THRESHOLD_PERCENT (10 %) is a
// drift; exactly 10 % is not. The comparison is integer arithmetic
// (100 × changed > previous × 10), so 3 of 30 is never a drift by float noise.

import {
  IMPLICIT_GROUP_ID,
  type CollectionGroup,
  type CollectionGroupResolution,
  type ResolvedCollectionGroup,
} from "./groups"
import { stringValue } from "./validation"

/** The last run's matches per rule group, JSON under submittedValues. */
export const LAST_GENERATION_MATCHES_KEY = "lastGenerationMatches"

/** The run before the last one — the other half of the comparison. */
export const PREVIOUS_GENERATION_MATCHES_KEY = "previousGenerationMatches"

/** A shift strictly above this share of the previous set is a drift. */
export const CONTAINER_DRIFT_THRESHOLD_PERCENT = 10

export type GroupMatches = {
  /** The rule signature the containers were matched under (ruleSignature). */
  rule: string
  /** The container ids the group matched, sorted. */
  containerIds: string[]
}

/** What one generation run matched, keyed by collection group id. */
export type GenerationMatches = Record<string, GroupMatches>

/** The two stamps a scheme record carries — empty objects when it has none. */
export type GenerationMatchHistory = {
  previous: GenerationMatches
  last: GenerationMatches
}

type StoredValues = Record<string, string | boolean | undefined>

/* -------------------------------- signature -------------------------------- */

/**
 * What a rule group's matches depend on besides the container base: the
 * scheme's planning area and the group's fractions, vehicle type and
 * container types. Two runs are compared only when this is unchanged between
 * them. Compared whole, never parsed, so the separators need no escaping.
 */
export function ruleSignature(
  group: Pick<CollectionGroup, "fractions" | "ruleVehicleType" | "containerTypes">,
  areaId: string | undefined,
): string {
  return [
    areaId ?? "",
    [...group.fractions].sort().join(","),
    group.ruleVehicleType ?? "",
    [...(group.containerTypes ?? [])].sort().join(","),
  ].join("|")
}

/* --------------------------------- matches --------------------------------- */

/**
 * The stamp one run leaves: for every rule group, the union of the containers
 * it serves on any of its days (rule matches do not depend on the day; only
 * another group's claims do), sorted so two runs of one set serialize alike.
 * Manual groups are left out — their list is the scheme's own.
 */
export function generationMatchesOf(
  groups: readonly CollectionGroup[],
  resolution: Pick<CollectionGroupResolution, "plans">,
  areaId: string | undefined,
): GenerationMatches {
  const matches: GenerationMatches = {}
  for (const group of groups) {
    if (group.stopSource !== "rule") continue
    const ids = new Set<string>()
    for (const plan of resolution.plans) {
      if (plan.groupId !== group.id) continue
      for (const id of plan.containerIds) ids.add(id)
    }
    matches[group.id] = {
      rule: ruleSignature(group, areaId),
      containerIds: [...ids].sort(),
    }
  }
  return matches
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/**
 * Lenient read of a stored stamp: hand-edited or corrupted storage, a
 * non-object, or an entry without a string rule and a string-array
 * containerIds reads as no history for that group — never a throw at render.
 */
export function parseGenerationMatches(raw: string | undefined): GenerationMatches {
  if (!raw || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const matches: GenerationMatches = {}
  for (const [groupId, candidate] of Object.entries(parsed)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const entry = candidate as { rule?: unknown; containerIds?: unknown }
    if (typeof entry.rule !== "string" || !isStringArray(entry.containerIds)) continue
    matches[groupId] = { rule: entry.rule, containerIds: [...entry.containerIds].sort() }
  }
  return matches
}

/**
 * The stored form: keys and ids sorted so equal matches serialize equal, and
 * the empty string — an absent value — when there is nothing to remember, so
 * a manual scheme never carries a stamp.
 */
export function serializeGenerationMatches(matches: GenerationMatches): string {
  const groupIds = Object.keys(matches).sort()
  if (groupIds.length === 0) return ""
  const ordered: GenerationMatches = {}
  for (const groupId of groupIds) {
    const entry = matches[groupId]
    ordered[groupId] = { rule: entry.rule, containerIds: [...entry.containerIds].sort() }
  }
  return JSON.stringify(ordered)
}

/** Whether two stamps remember the same thing. */
export function sameGenerationMatches(a: GenerationMatches, b: GenerationMatches): boolean {
  return serializeGenerationMatches(a) === serializeGenerationMatches(b)
}

/** The scheme's two stamps as stored (empty when it has none yet). */
export function generationMatchHistoryOf(
  values: StoredValues | undefined,
): GenerationMatchHistory {
  const stored = values ?? {}
  return {
    previous: parseGenerationMatches(stringValue(stored, PREVIOUS_GENERATION_MATCHES_KEY)),
    last: parseGenerationMatches(stringValue(stored, LAST_GENERATION_MATCHES_KEY)),
  }
}

/**
 * The two values a run writes: the last stamp becomes the previous one and
 * the run's matches the last. A run that matches what the last run matched
 * still advances the history, which is what lets a drift clear on the next
 * matching run; the run after that changes nothing (recordGenerationMatches
 * then returns its input, so a quiet Plan Ahead load writes no scheme).
 */
export function generationMatchValues(
  history: GenerationMatchHistory,
  matches: GenerationMatches,
): Record<string, string> {
  return {
    [PREVIOUS_GENERATION_MATCHES_KEY]: serializeGenerationMatches(history.last),
    [LAST_GENERATION_MATCHES_KEY]: serializeGenerationMatches(matches),
  }
}

/* ---------------------------------- drift ---------------------------------- */

export type CollectionGroupContainerDrift = {
  groupId: string
  /** The group's name; absent for the implicit shared group, which the sentence does not name. */
  groupName?: string
  /** How many containers the group matched at the previous run. */
  previous: number
  /** Containers matched now that were not matched before. */
  joined: string[]
  /** Containers matched before that are not matched now. */
  left: string[]
  /** (joined + left) / max(previous, 1) — the share of the previous set that moved. */
  shift: number
}

/**
 * The rule groups whose matched set moved past the threshold between two
 * stamps, in group order. Only a group present in both stamps under the same
 * rule signature is compared: a first run, a group added since, or a rule
 * that changed has nothing honest to compare against. A group no longer on
 * the scheme is not reported — that was an edit, and its run restamps.
 */
export function containerDriftBetween(
  previous: GenerationMatches,
  current: GenerationMatches,
  groups: readonly ResolvedCollectionGroup[],
): CollectionGroupContainerDrift[] {
  const drift: CollectionGroupContainerDrift[] = []
  for (const group of groups) {
    if (group.stopSource !== "rule") continue
    const before = previous[group.id]
    const after = current[group.id]
    if (!before || !after || before.rule !== after.rule) continue
    const beforeIds = new Set(before.containerIds)
    const afterIds = new Set(after.containerIds)
    const joined = [...afterIds].filter((id) => !beforeIds.has(id)).sort()
    const left = [...beforeIds].filter((id) => !afterIds.has(id)).sort()
    const changed = joined.length + left.length
    const base = Math.max(beforeIds.size, 1)
    if (changed * 100 <= base * CONTAINER_DRIFT_THRESHOLD_PERCENT) continue
    drift.push({
      groupId: group.id,
      ...(group.implicit && group.id === IMPLICIT_GROUP_ID ? {} : { groupName: group.name }),
      previous: beforeIds.size,
      joined,
      left,
      shift: changed / base,
    })
  }
  return drift
}

const percentOf = (shift: number): string => `${Math.round(shift * 100)} %`

const movementOf = (drift: CollectionGroupContainerDrift): string =>
  `${drift.joined.length} joined, ${drift.left.length} left of ${drift.previous}`

/** "13 % — 4 joined, 0 left of 30": one group's movement, for a list row the caller labels. */
export function containerDriftMovement(drift: CollectionGroupContainerDrift): string {
  return `${percentOf(drift.shift)} — ${movementOf(drift)}`
}

/**
 * The one Attention sentence for a run's drift, or null when nothing drifted:
 * "Matched containers shifted 13 % since the previous generation run: 4
 * joined, 0 left of 30" for the implicit shared group, one clause per named
 * group otherwise. The same sentence serves the plan preview (this run
 * against the last) and the badge (the last run against the one before).
 */
export function containerDriftWarning(
  drift: readonly CollectionGroupContainerDrift[],
): string | null {
  if (drift.length === 0) return null
  const [only] = drift
  if (drift.length === 1 && only.groupName === undefined) {
    return `Matched containers shifted ${percentOf(only.shift)} since the previous generation run: ${movementOf(only)}`
  }
  const clauses = drift.map(
    (entry) => `${entry.groupName ?? "stop rule"} ${percentOf(entry.shift)} (${movementOf(entry)})`,
  )
  return `Matched containers shifted since the previous generation run: ${clauses.join("; ")}`
}
