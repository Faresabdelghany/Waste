export const APP_THEME_SELECTION_STORAGE_KEY =
  "wastehero.theme.selection.v1"
export const CUSTOM_THEME_STORAGE_KEY = "wastehero.theme.custom.v1"

export type LinearThemeId = "ash" | "midnight" | "dawn" | "pale"

export type AppThemeSelection = LinearThemeId | "custom"

export type CustomThemePalette = {
  background: string
  foreground: string
  surface: string
  surfaceForeground: string
  accent: string
  accentForeground: string
}

export type CustomThemePreset = {
  id: LinearThemeId
  label: string
  palette: CustomThemePalette
}

export const customThemePresets: readonly CustomThemePreset[] = [
  {
    id: "ash",
    label: "Ash",
    palette: {
      background: "#FFFFFF",
      foreground: "#44494D",
      surface: "#EDEEF3",
      surfaceForeground: "#44494D",
      accent: "#475BA1",
      accentForeground: "#FFFFFF",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    palette: {
      background: "#0F0F10",
      foreground: "#EEEFF1",
      surface: "#151516",
      surfaceForeground: "#EEEFF1",
      accent: "#D25E65",
      accentForeground: "#FFFFFF",
    },
  },
  {
    id: "dawn",
    label: "Dawn",
    palette: {
      background: "#2A222E",
      foreground: "#EEEFF1",
      surface: "#382A3C",
      surfaceForeground: "#EEEFF1",
      accent: "#A84376",
      accentForeground: "#FFFFFF",
    },
  },
  {
    id: "pale",
    label: "Pale",
    palette: {
      background: "#292D3E",
      foreground: "#EEEFF1",
      surface: "#292D3E",
      surfaceForeground: "#EEEFF1",
      accent: "#7D57C1",
      accentForeground: "#FFFFFF",
    },
  },
]

export const defaultCustomTheme = customThemePresets[0].palette
export const defaultThemeSelection: LinearThemeId = "ash"

export function isLinearThemeId(value: unknown): value is LinearThemeId {
  return (
    value === "ash" ||
    value === "midnight" ||
    value === "dawn" ||
    value === "pale"
  )
}

export function getThemePreset(
  id: LinearThemeId,
): CustomThemePreset {
  return (
    customThemePresets.find((preset) => preset.id === id) ??
    customThemePresets[0]
  )
}

export function migrateThemeSelection(
  value: string | null,
  prefersDark = false,
): AppThemeSelection | null {
  if (isLinearThemeId(value) || value === "custom") return value

  if (value === "light") return "ash"
  if (value === "dark" || value === "linear") return "midnight"
  if (value === "system") return prefersDark ? "midnight" : "ash"

  return null
}

export const customThemeColorFields: ReadonlyArray<{
  id: keyof CustomThemePalette
  label: string
}> = [
  { id: "background", label: "Background" },
  { id: "foreground", label: "Text" },
  { id: "surface", label: "Sidebar" },
  { id: "surfaceForeground", label: "Sidebar text" },
  { id: "accent", label: "Accent" },
  { id: "accentForeground", label: "Accent text" },
]

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

export function normalizeHexColor(value: string): string {
  return value.trim().toUpperCase()
}

export function isCustomThemePalette(
  value: unknown,
): value is CustomThemePalette {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false

  const palette = value as Record<string, unknown>
  return customThemeColorFields.every(({ id }) => {
    const color = palette[id]
    return typeof color === "string" && isHexColor(color)
  })
}

export function normalizeCustomTheme(
  palette: CustomThemePalette,
): CustomThemePalette {
  return Object.fromEntries(
    customThemeColorFields.map(({ id }) => [
      id,
      normalizeHexColor(palette[id]),
    ]),
  ) as CustomThemePalette
}

export function serializeCustomTheme(palette: CustomThemePalette): string {
  const normalized = normalizeCustomTheme(palette)
  return customThemeColorFields.map(({ id }) => normalized[id]).join(",")
}

export function parseCustomTheme(value: string): CustomThemePalette | null {
  const colors = value.split(",").map((color) => color.trim())
  if (
    colors.length !== customThemeColorFields.length ||
    !colors.every(isHexColor)
  ) {
    return null
  }

  return normalizeCustomTheme(
    Object.fromEntries(
      customThemeColorFields.map(({ id }, index) => [id, colors[index]]),
    ) as CustomThemePalette,
  )
}

export function isDarkThemeColor(color: string): boolean {
  if (!isHexColor(color)) return false

  const red = Number.parseInt(color.slice(1, 3), 16) / 255
  const green = Number.parseInt(color.slice(3, 5), 16) / 255
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255
  const linearize = (channel: number) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  const luminance =
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue)

  return luminance < 0.36
}
