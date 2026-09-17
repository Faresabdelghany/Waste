"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useTheme } from "next-themes"

import { createExternalStore, type ExternalStore } from "@/lib/external-store"
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

type AppThemeSnapshot = {
  selection: AppThemeSelection
  customPalette: CustomThemePalette
  mounted: boolean
}

type AppThemeStoreHandle = ExternalStore<AppThemeSnapshot> & {
  bindSetBaseTheme: (setBaseTheme: (theme: string) => void) => void
  actions: Pick<AppThemeContextValue, "selectTheme" | "setCustomPalette">
}

// The server (and every hydrating component) sees the default theme state —
// see lib/external-store.ts for why the context carries a stable handle
// instead of the state itself (hydration safety under streaming SSR).
const appThemeServerSnapshot: AppThemeSnapshot = {
  selection: defaultThemeSelection,
  customPalette: defaultCustomTheme,
  mounted: false,
}

const AppThemeContext = createContext<AppThemeStoreHandle | null>(null)

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

function createAppThemeStore(): AppThemeStoreHandle {
  const store = createExternalStore<AppThemeSnapshot>(appThemeServerSnapshot)
  // next-themes' setter comes from a hook, so the provider binds it after
  // mount; the actions always run long after binding.
  let setBaseTheme: (theme: string) => void = () => {}

  const selectTheme = (nextSelection: AppThemeSelection) => {
    store.set((current) => ({ ...current, selection: nextSelection }))
    applyThemeSelection(
      nextSelection,
      store.getSnapshot().customPalette,
      setBaseTheme,
    )
    try {
      window.localStorage.setItem(
        APP_THEME_SELECTION_STORAGE_KEY,
        nextSelection,
      )
    } catch {
      // The selected theme still applies for the current session.
    }
  }

  const setCustomPalette = (nextPalette: CustomThemePalette) => {
    const normalized = normalizeCustomTheme(nextPalette)
    store.set((current) => ({ ...current, customPalette: normalized }))
    if (store.getSnapshot().selection === "custom") {
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
  }

  return {
    ...store,
    bindSetBaseTheme: (next) => {
      setBaseTheme = next
    },
    actions: { selectTheme, setCustomPalette },
  }
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const { setTheme: setBaseTheme } = useTheme()
  const [store] = useState(createAppThemeStore)

  useEffect(() => {
    store.bindSetBaseTheme(setBaseTheme)
  }, [setBaseTheme, store])

  useEffect(() => {
    const storedPalette = readStoredPalette()
    const storedSelection = readStoredSelection()

    store.set({
      selection: storedSelection,
      customPalette: storedPalette,
      mounted: true,
    })
    applyThemeSelection(storedSelection, storedPalette, setBaseTheme)
    try {
      window.localStorage.setItem(
        APP_THEME_SELECTION_STORAGE_KEY,
        storedSelection,
      )
    } catch {
      // The migrated selection still applies for the current session.
    }
  }, [setBaseTheme, store])

  useEffect(() => {
    const syncStoredTheme = () => {
      const storedPalette = readStoredPalette()
      const storedSelection = readStoredSelection()
      store.set((current) => ({
        ...current,
        selection: storedSelection,
        customPalette: storedPalette,
      }))
      applyThemeSelection(storedSelection, storedPalette, setBaseTheme)
    }

    window.addEventListener("storage", syncStoredTheme)
    return () => window.removeEventListener("storage", syncStoredTheme)
  }, [setBaseTheme, store])

  return (
    <AppThemeContext.Provider value={store}>
      {children}
    </AppThemeContext.Provider>
  )
}

export function useAppTheme(): AppThemeContextValue {
  const store = useContext(AppThemeContext)
  if (!store) {
    throw new Error("useAppTheme must be used inside AppThemeProvider")
  }
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  return useMemo(() => ({ ...snapshot, ...store.actions }), [snapshot, store])
}
