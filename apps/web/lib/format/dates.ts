// How a day reads at length and in short: "September 16, 2026", a range of
// such days, "18 Sep 2026". Month names are the domain's, so the server's
// render and the browser's agree. Pure functions.
import { MONTH_LABELS, MONTH_SHORT_LABELS } from "@waste/domain/days"

/** "2026-09-16" → "September 16, 2026". */
export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10))
  const monthName = MONTH_LABELS[(month ?? 1) - 1] ?? MONTH_LABELS[0]
  return `${monthName} ${day}, ${year}`
}

/** Inclusive range as "September 16, 2026 – September 22, 2026"; one day reads once. */
export function formatDateRange(range: { from: string; to: string }): string {
  if (range.from === range.to) return formatLongDate(range.from)
  return `${formatLongDate(range.from)} – ${formatLongDate(range.to)}`
}

/** "2026-09-18" → "18 Sep 2026", the registry's own date shape. */
export function formatShortDate(iso: string): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10))
  return `${day} ${MONTH_SHORT_LABELS[(month ?? 1) - 1] ?? MONTH_SHORT_LABELS[0]} ${year}`
}
