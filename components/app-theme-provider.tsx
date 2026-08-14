"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useTheme } from "next-themes"

import {
  APP_THEME_SELECTION_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  defaultCustomTheme,
  defaultThemeSelection,
  getThemePreset,
  isCustomThemePalette,
  isDarkThemeColor,
  migrateThemeSelection,
  normalizeCustomTheme,
  type AppThemeSelection,
  type CustomThemePalette,
} from "@/lib/app-themes"

type AppThemeContextValue = {
  selection: AppThemeSelection
  customPalette: CustomThemePalette
  mounted: boolean
  selectTheme: (selection: AppThemeSelection) => void
  setCustomPalette: (palette: CustomThemePalette) => void
}

const AppThemeContext = createContext<AppThemeContextValue | null>(null)

function applyThemePalette(palette: CustomThemePalette) {
  const root = document.documentElement
  const normalized = normalizeCustomTheme(palette)

  root.style.setProperty("--custom-background", normalized.background)
  root.style.setProperty("--custom-foreground", normalized.foreground)
  root.style.setProperty("--custom-surface", normalized.surface)
  root.style.setProperty(
    "--custom-surface-foreground",
    normalized.surfaceForeground,
  )
  root.style.setProperty("--custom-accent", normalized.accent)
  root.style.setProperty(
    "--custom-accent-foreground",
    normalized.accentForeground,
  )
  root.dataset.customThemeTone = isDarkThemeColor(normalized.background)
    ? "dark"
    : "light"
}

function applyThemeSelection(
  selection: AppThemeSelection,
  customPalette: CustomThemePalette,
  setBaseTheme: (theme: string) => void,
) {
  const root = document.documentElement
  const palette =
    selection === "custom"
      ? customPalette
      : getThemePreset(selection).palette
  const baseTheme = isDarkThemeColor(palette.background) ? "dark" : "light"

  applyThemePalette(palette)
  root.dataset.appTheme = selection
  root.style.colorScheme = baseTheme
  setBaseTheme(baseTheme)
}

function readStoredPalette(): CustomThemePalette {
  try {
    const rawPalette = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)
    if (!rawPalette) return defaultCustomTheme
    const parsed: unknown = JSON.parse(rawPalette)
    return isCustomThemePalette(parsed)
      ? normalizeCustomTheme(parsed)
      : defaultCustomTheme
  } catch {
    return defaultCustomTheme
  }
}

function readStoredSelection(): AppThemeSelection {
  const prefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches

  try {
    const stored = window.localStorage.getItem(
      APP_THEME_SELECTION_STORAGE_KEY,
    )
    const migratedStored = migrateThemeSelection(stored, prefersDark)
    if (migratedStored) return migratedStored

    const existingTheme = window.localStorage.getItem("theme")
    const migratedBaseTheme = migrateThemeSelection(
      existingTheme,
      prefersDark,
    )
    if (migratedBaseTheme) return migratedBaseTheme
  } catch {
    // Use the default when storage is unavailable.
  }
  return prefersDark ? "midnight" : defaultThemeSelection
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const { setTheme: setBaseTheme } = useTheme()
  const [selection, setSelection] =
    useState<AppThemeSelection>(defaultThemeSelection)
  const [customPalette, setCustomPaletteState] =
    useState<CustomThemePalette>(defaultCustomTheme)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const storedPalette = readStoredPalette()
    const storedSelection = readStoredSelection()

    setCustomPaletteState(storedPalette)
    setSelection(storedSelection)
    applyThemeSelection(storedSelection, storedPalette, setBaseTheme)
    try {
      window.localStorage.setItem(
        APP_THEME_SELECTION_STORAGE_KEY,
        storedSelection,
      )
    } catch {
      // The migrated selection still applies for the current session.
    }
    setMounted(true)
  }, [setBaseTheme])

  useEffect(() => {
    const syncStoredTheme = () => {
      const storedPalette = readStoredPalette()
      const storedSelection = readStoredSelection()
      setCustomPaletteState(storedPalette)
      setSelection(storedSelection)
      applyThemeSelection(storedSelection, storedPalette, setBaseTheme)
    }

    window.addEventListener("storage", syncStoredTheme)
    return () => window.removeEventListener("storage", syncStoredTheme)
  }, [setBaseTheme])

  useEffect(() => {
    if (!mounted) return
    applyThemeSelection(selection, customPalette, setBaseTheme)
  }, [customPalette, mounted, selection, setBaseTheme])

  const selectTheme = useCallback(
    (nextSelection: AppThemeSelection) => {
      setSelection(nextSelection)
      applyThemeSelection(nextSelection, customPalette, setBaseTheme)
      try {
        window.localStorage.setItem(
          APP_THEME_SELECTION_STORAGE_KEY,
          nextSelection,
        )
      } catch {
        // The selected theme still applies for the current session.
      }
    },
    [customPalette, setBaseTheme],
  )

  const setCustomPalette = useCallback(
    (nextPalette: CustomThemePalette) => {
      const normalized = normalizeCustomTheme(nextPalette)
      setCustomPaletteState(normalized)
      if (selection === "custom") {
        applyThemeSelection("custom", normalized, setBaseTheme)
      }
      try {
        window.localStorage.setItem(
          CUSTOM_THEME_STORAGE_KEY,
          JSON.stringify(normalized),
        )
      } catch {
        // The custom palette still applies for the current session.
      }
    },
    [selection, setBaseTheme],
  )

  const value = useMemo(
    () => ({
      selection,
      customPalette,
      mounted,
      selectTheme,
      setCustomPalette,
    }),
    [customPalette, mounted, selectTheme, selection, setCustomPalette],
  )

  return (
    <AppThemeContext.Provider value={value}>
      {children}
    </AppThemeContext.Provider>
  )
}

export function useAppTheme() {
  const context = useContext(AppThemeContext)
  if (!context) {
    throw new Error("useAppTheme must be used inside AppThemeProvider")
  }
  return context
}
