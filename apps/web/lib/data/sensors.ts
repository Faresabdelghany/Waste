// What a fill-level Sensor's details offer (O26 of #290): the containers a
// sensor may be paired with — its project's, by label — and what the pairing
// dialogs open on. The commands are lib/api/records/sensors.ts's; the rules
// they meet (one container per sensor and one sensor per container at a
// time, a retired sensor paired with nothing new) are the API's, told in its
// words.
import { DEFAULT_FULL_THRESHOLD_PERCENT } from "@waste/domain/resources/sensors"

import type { BusinessRecord } from "@/lib/data/business-modules"

export type PairableContainer = { value: string; label: string }

/** The containers of the sensor's project, by label, in label order: the ones a pairing may name. */
export function pairableContainers(containers: readonly BusinessRecord[], projectId: string | undefined): PairableContainer[] {
  return containers
    .filter((container) => projectId !== undefined && (container.projectIds ?? []).includes(projectId))
    .map((container) => ({ value: container.id, label: container.facts["Container ID"] ?? container.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** What Pair opens on: no container, today, the default threshold, no booking. */
export const pairDraft = (today: string) => ({ containerId: "", validFrom: today, fullThresholdPercent: String(DEFAULT_FULL_THRESHOLD_PERCENT), booksEmptying: false })

/** What Change pairing opens on: the pairing in force as the record carries it, its end the last day in force (blank while it runs). */
export function changeDraft(record: BusinessRecord) {
  const values = record.submittedValues ?? {}
  return {
    fullThresholdPercent: typeof values.fullThresholdPercent === "string" ? values.fullThresholdPercent : String(DEFAULT_FULL_THRESHOLD_PERCENT),
    booksEmptying: values.booksEmptying === true,
    lastDayIn: typeof values.lastDayIn === "string" ? values.lastDayIn : "",
  }
}

/** Whether the sensor can be paired from its details: active, and measuring nothing today. */
export const pairOffered = (record: BusinessRecord): boolean => record.status.toLowerCase() === "active" && (record.submittedValues?.pairingId ?? "") === ""
