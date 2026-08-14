"use client"

import { useEffect, useState } from "react"
import { Check, Copy } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import {
  customThemeColorFields,
  customThemePresets,
  isHexColor,
  parseCustomTheme,
  serializeCustomTheme,
  type CustomThemePalette,
  type CustomThemePreset,
} from "@/lib/app-themes"
import { useAppTheme } from "@/components/app-theme-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function PaletteSwatches({ palette }: { palette: CustomThemePalette }) {
  const colors = [
    palette.background,
    palette.foreground,
    palette.surface,
    palette.surfaceForeground,
    palette.accent,
    palette.accentForeground,
  ]

  return (
    <span className="grid h-4 w-20 grid-cols-6 overflow-hidden rounded-full border border-border">
      {colors.map((color, index) => (
        <span
          key={`${color}-${index}`}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

function ThemeChoice({
  preset,
  selected,
  disabled,
  onSelect,
}: {
  preset: CustomThemePreset
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const colors = [
    preset.palette.background,
    preset.palette.foreground,
    preset.palette.surface,
    preset.palette.surfaceForeground,
    preset.palette.accent,
    preset.palette.accentForeground,
  ]

  return (
    <button
      type="button"
      role="radio"
      aria-label={`Use ${preset.label} theme`}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`min-w-0 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-wait ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/25"
          : "border-border bg-background hover:bg-accent"
      }`}
    >
      <span className="grid h-7 grid-cols-6 overflow-hidden rounded-md border border-border">
        {colors.map((color, index) => (
          <span
            key={`${color}-${index}`}
            style={{ backgroundColor: color }}
          />
        ))}
      </span>
      <span className="mt-2 flex items-center justify-between gap-2">
        <span
          className={`truncate text-xs ${
            selected
              ? "font-medium text-foreground"
              : "text-muted-foreground"
          }`}
        >
          {preset.label}
        </span>
        {selected && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" weight="bold" />
          </span>
        )}
      </span>
    </button>
  )
}

export function ThemeCustomizer() {
  const {
    selection,
    customPalette,
    mounted,
    selectTheme,
    setCustomPalette,
  } = useAppTheme()
  const [draftPalette, setDraftPalette] =
    useState<CustomThemePalette>(customPalette)
  const [themeCode, setThemeCode] = useState(
    serializeCustomTheme(customPalette),
  )

  useEffect(() => {
    setDraftPalette(customPalette)
    setThemeCode(serializeCustomTheme(customPalette))
  }, [customPalette])

  const updateColor = (
    fieldId: keyof CustomThemePalette,
    value: string,
  ) => {
    const nextDraft = { ...draftPalette, [fieldId]: value }
    setDraftPalette(nextDraft)
    if (!isHexColor(value)) return

    const nextPalette = { ...customPalette, [fieldId]: value }
    setCustomPalette(nextPalette)
    if (selection !== "custom") selectTheme("custom")
  }

  const loadPreset = (presetId: string) => {
    const preset = customThemePresets.find((item) => item.id === presetId)
    if (!preset) return
    setCustomPalette(preset.palette)
    selectTheme("custom")
  }

  const applyThemeCode = () => {
    const palette = parseCustomTheme(themeCode)
    if (!palette) {
      toast.error("Invalid theme code", {
        description: "Use six comma-separated hex colors.",
      })
      return
    }
    setCustomPalette(palette)
    selectTheme("custom")
    toast.success("Custom theme applied")
  }

  const copyThemeCode = async () => {
    const code = serializeCustomTheme(customPalette)
    try {
      await navigator.clipboard.writeText(code)
      toast.success("Theme code copied")
    } catch {
      toast.error("Theme code could not be copied")
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Appearance</h3>
      <div className="border-y border-border/60">
        <div className="px-4 py-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                id="account-theme-label"
                className="text-sm font-medium text-foreground"
              >
                Theme
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Personal
              </span>
            </div>
            <p
              id="account-theme-description"
              className="text-xs leading-5 text-muted-foreground"
            >
              Canvas, sidebar, panels, and controls update together.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-labelledby="account-theme-label"
            aria-describedby="account-theme-description"
            className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {customThemePresets.map((preset) => (
              <ThemeChoice
                key={preset.id}
                preset={preset}
                selected={
                  mounted
                    ? selection === preset.id
                    : preset.id === "ash"
                }
                disabled={!mounted}
                onSelect={() => {
                  if (mounted) selectTheme(preset.id)
                }}
              />
            ))}
          </div>
          <button
            type="button"
            aria-pressed={mounted && selection === "custom"}
            disabled={!mounted}
            onClick={() => selectTheme("custom")}
            className={`mt-3 flex w-full items-center justify-between gap-3 border-t border-border/60 pt-3 text-left disabled:cursor-wait ${
              selection === "custom"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="text-xs font-medium">
              {selection === "custom"
                ? "Custom theme active"
                : "Customize theme"}
            </span>
            <span className="flex items-center gap-2">
              <PaletteSwatches palette={customPalette} />
              {selection === "custom" && (
                <Check className="h-3.5 w-3.5 text-primary" weight="bold" />
              )}
            </span>
          </button>
        </div>

        {selection === "custom" && mounted && (
          <div className="space-y-5 border-t border-border/60 px-4 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Custom colors
                </p>
                <p className="text-xs text-muted-foreground">
                  Changes apply and save immediately.
                </p>
              </div>
              <Select onValueChange={loadPreset}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Load preset" />
                </SelectTrigger>
                <SelectContent>
                  {customThemePresets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      <span className="flex items-center gap-2">
                        <PaletteSwatches palette={preset.palette} />
                        {preset.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {customThemeColorFields.map((field) => {
                const value = draftPalette[field.id]
                const isValid = isHexColor(value)
                return (
                  <label key={field.id} className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {field.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <input
                        type="color"
                        value={
                          isValid ? value : customPalette[field.id]
                        }
                        onChange={(event) =>
                          updateColor(field.id, event.target.value)
                        }
                        className="h-9 w-10 cursor-pointer rounded-md border border-input bg-transparent p-1"
                        aria-label={`${field.label} color`}
                      />
                      <Input
                        value={value}
                        onChange={(event) =>
                          updateColor(field.id, event.target.value)
                        }
                        onBlur={() => {
                          if (!isValid) {
                            setDraftPalette((current) => ({
                              ...current,
                              [field.id]: customPalette[field.id],
                            }))
                          }
                        }}
                        className="h-9 font-mono text-xs uppercase"
                        aria-invalid={!isValid}
                      />
                      {isValid && (
                        <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                Theme code
              </span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={themeCode}
                  onChange={(event) => setThemeCode(event.target.value)}
                  className="h-9 min-w-0 flex-1 font-mono text-xs uppercase"
                  aria-label="Shareable theme code"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={applyThemeCode}
                >
                  Apply
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={copyThemeCode}
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
