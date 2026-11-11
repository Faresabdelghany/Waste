// How a quantity reads: an area, a weight, a volume, a distance, a duration.
// Hand-rolled in en-US digits like the rest of the prototype so the server's
// render and the browser's agree. Pure functions.
const enUS = (value: number, fractionDigits = 0) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })

export function formatArea(squareMetres: number): string {
  if (squareMetres < 10_000) return `${enUS(Math.round(squareMetres))} m²`
  return `${enUS(squareMetres / 1_000_000, 2)} km²`
}

export function formatWeight(kilograms: number): string {
  if (kilograms === 0) return "0 t"
  if (kilograms < 1000) return `${enUS(Math.round(kilograms))} kg`
  return `${enUS(kilograms / 1000, 1)} t`
}

export const kilograms = (value: number): string => `${new Intl.NumberFormat("en").format(value)} kg`

export function formatVolume(litres: number): string {
  if (litres === 0) return "0 m³"
  return `${enUS(litres / 1000, 1)} m³`
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${enUS(Math.round(metres))} m` : `${enUS(metres / 1000, 1)} km`
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}
