// Display formatting for the Selected area panel (2026-09-16): areas,
// weights, volumes, and the long dates the quantities range reads in. Month
// names are hand-rolled like the rest of the prototype so SSR and the
// browser agree. Pure functions.

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const enUS = (value: number, fractionDigits = 0) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })

/** Square metres below a hectare, km² with two decimals above it. */
export function formatArea(squareMetres: number): string {
  if (squareMetres < 10_000) return `${enUS(Math.round(squareMetres))} m²`
  return `${enUS(squareMetres / 1_000_000, 2)} km²`
}

/** Kilograms below a tonne, tonnes with one decimal from a tonne — and "0 t" for nothing. */
export function formatWeight(kilograms: number): string {
  if (kilograms === 0) return "0 t"
  if (kilograms < 1000) return `${enUS(Math.round(kilograms))} kg`
  return `${enUS(kilograms / 1000, 1)} t`
}

/** Litres → cubic metres with one decimal. */
export function formatVolume(litres: number): string {
  if (litres === 0) return "0 m³"
  return `${enUS(litres / 1000, 1)} m³`
}

/** "2026-09-16" → "September 16, 2026". */
export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10))
  const monthName = LONG_MONTHS[(month ?? 1) - 1] ?? LONG_MONTHS[0]
  return `${monthName} ${day}, ${year}`
}

/** Inclusive range as "September 16, 2026 – September 22, 2026"; one day reads once. */
export function formatDateRange(range: { from: string; to: string }): string {
  if (range.from === range.to) return formatLongDate(range.from)
  return `${formatLongDate(range.from)} – ${formatLongDate(range.to)}`
}

const SHORT_MONTHS = LONG_MONTHS.map((month) => month.slice(0, 3))

/** "2026-09-18" → "18 Sep 2026", the registry's own date shape. */
export function formatShortDate(iso: string): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10))
  return `${day} ${SHORT_MONTHS[(month ?? 1) - 1] ?? SHORT_MONTHS[0]} ${year}`
}
