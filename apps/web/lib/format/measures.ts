// How a quantity reads: an area, a weight, a volume, a distance, a duration.
// Hand-rolled in en-US digits like the rest of the prototype so the server's
// render and the browser's agree. Pure functions.
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

/** Whole kilograms as a weighing reads them, with thousands separators: "12,480 kg". */
export const kilograms = (value: number): string => `${new Intl.NumberFormat("en").format(value)} kg`

/** Litres → cubic metres with one decimal. */
export function formatVolume(litres: number): string {
  if (litres === 0) return "0 m³"
  return `${enUS(litres / 1000, 1)} m³`
}

/** "850 m" under a kilometre, "12.4 km" above. */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${enUS(Math.round(metres))} m` : `${enUS(metres / 1000, 1)} km`
}

/** "38 min" under an hour, "1 h 05 min" above; never less than a minute. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}
