// Marker colours for the planning map (2026-09-16). Waste fractions take the
// colour configured in Settings › Asset management; fractions the Settings
// store does not define (the seeded Plastic and Metal containers, a
// user-typed fraction) fall back to a stable hue from a fixed palette so a
// legend swatch and its markers always agree. Pure data logic.

import { avalancheHash } from "@waste/domain/route-schemes/hash"

export type ConfiguredFractionColor = { name: string; color: string }

/** Hues that stay apart from the configured fraction colours and from the selection ring. */
export const FALLBACK_FRACTION_PALETTE = [
  "#d97706",
  "#7c3aed",
  "#db2777",
  "#0d9488",
  "#4f46e5",
  "#ca8a04",
  "#9333ea",
  "#0369a1",
  "#475569",
] as const

/**
 * Fractions the fixtures use that Settings does not define, pinned so their
 * swatches never drift when the palette or hash changes.
 */
const NAMED_FALLBACKS: Readonly<Record<string, string>> = {
  plastic: "#d97706",
  metal: "#475569",
}

/** The ring a selected marker wears — amber, used by no fraction. */
export const SELECTION_COLOR = "#f59e0b"

/** The neutral a marker takes when it carries no fraction at all. */
export const NO_FRACTION_COLOR = "#a1a1aa"

export function fractionColor(
  name: string,
  configured: readonly ConfiguredFractionColor[],
): string {
  const key = name.trim().toLowerCase()
  if (!key) return NO_FRACTION_COLOR
  const match = configured.find((fraction) => fraction.name.trim().toLowerCase() === key)
  if (match) return match.color
  const named = NAMED_FALLBACKS[key]
  if (named) return named
  return FALLBACK_FRACTION_PALETTE[
    avalancheHash(`fraction:${key}`) % FALLBACK_FRACTION_PALETTE.length
  ]
}
