import type { BusinessRecord } from "./business-modules"

/** A record's span within one day, in minutes from midnight, as the Timeline layout draws it. */
export type TimeWindow = {
  startMinutes: number
  endMinutes: number
  label: string
}

const TIME_WINDOW_PATTERN = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/

/** The first `HH:MM–HH:MM` a record's value or facts hold, ending after it starts; null where none does. */
export function timeWindowOf(record: BusinessRecord): TimeWindow | null {
  const candidates = [record.value, ...Object.values(record.facts)]
  for (const candidate of candidates) {
    const match = candidate?.match(TIME_WINDOW_PATTERN)
    if (!match) continue
    const startMinutes = Number(match[1]) * 60 + Number(match[2])
    const endMinutes = Number(match[3]) * 60 + Number(match[4])
    if (endMinutes <= startMinutes) continue
    return { startMinutes, endMinutes, label: match[0] }
  }
  return null
}

/**
 * Whether a list offers the Timeline layout: only where one of its rows, before
 * any search or filter, has a window to place on it. A list none of whose rows
 * can have one offers no empty Timeline (#657).
 */
export const offersTimeline = (records: readonly BusinessRecord[]): boolean => records.some((record) => timeWindowOf(record) !== null)

/** What a Timeline with nothing to place says: the filters only where some are set. */
export const noWindowSentence = (narrowed: boolean): string =>
  narrowed ? "No records with a time window match the current filters." : "No record here has a time window."
