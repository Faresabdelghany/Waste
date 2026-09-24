import {
  customThemePresets,
  defaultCustomTheme,
} from "@/lib/app-themes"
import {
  APP_THEME_SELECTION_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  persistedKeys,
} from "@/lib/storage-keys"

const presetPalettes = Object.fromEntries(
  customThemePresets.map((preset) => [preset.id, preset.palette]),
)

// This script is inline source, running before any module loads, so it cannot
// call readPersisted; it walks the same key list instead (lib/storage-keys.ts)
// and moves a value written under the previous working name to the current
// key, which is what the provider then finds.
const selectionKeys = persistedKeys(APP_THEME_SELECTION_STORAGE_KEY)
const customThemeKeys = persistedKeys(CUSTOM_THEME_STORAGE_KEY)

const bootstrapTheme = `
(() => {
  try {
    const root = document.documentElement;
    const presets = ${JSON.stringify(presetPalettes)};
    const fallbackCustom = ${JSON.stringify(defaultCustomTheme)};
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const readPersisted = (keys) => {
      for (const key of keys) {
        const value = localStorage.getItem(key);
        if (value === null) continue;
        if (key !== keys[0]) {
          localStorage.setItem(keys[0], value);
          localStorage.removeItem(key);
        }
        return value;
      }
      return null;
    };
    let selection = readPersisted(${JSON.stringify(selectionKeys)});
    if (!presets[selection] && selection !== "custom") {
      if (selection === "light") selection = "ash";
      else if (selection === "dark" || selection === "linear") selection = "midnight";
      else if (selection === "system") selection = prefersDark ? "midnight" : "ash";
      else {
        const legacyTheme = localStorage.getItem("theme");
        selection =
          legacyTheme === "dark" || (legacyTheme === "system" && prefersDark)
            ? "midnight"
            : "ash";
      }
    }

    let palette = presets[selection];
    if (selection === "custom") {
      palette = fallbackCustom;
      try {
        const storedCustom = JSON.parse(
          readPersisted(${JSON.stringify(customThemeKeys)}) || "null"
        );
        if (storedCustom) palette = storedCustom;
      } catch {}
    }

    const fields = [
      ["background", "--custom-background"],
      ["foreground", "--custom-foreground"],
      ["surface", "--custom-surface"],
      ["surfaceForeground", "--custom-surface-foreground"],
      ["accent", "--custom-accent"],
      ["accentForeground", "--custom-accent-foreground"]
    ];
    if (
      !palette ||
      !fields.every(([field]) =>
        typeof palette[field] === "string" &&
        /^#[0-9a-f]{6}$/i.test(palette[field])
      )
    ) {
      selection = "ash";
      palette = presets.ash;
    }

    root.dataset.appTheme = selection;
    fields.forEach(([field, property]) =>
      root.style.setProperty(property, palette[field])
    );

    const rgb = [1, 3, 5].map((start) =>
      Number.parseInt(palette.background.slice(start, start + 2), 16) / 255
    );
    const linear = rgb.map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4)
    );
    const isDark =
      0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] < 0.36;
    const baseTheme = isDark ? "dark" : "light";

    root.classList.toggle("dark", isDark);
    root.style.colorScheme = baseTheme;
    localStorage.setItem(
      ${JSON.stringify(APP_THEME_SELECTION_STORAGE_KEY)},
      selection
    );
    localStorage.setItem("theme", baseTheme);
  } catch {}
})();
`

export function ThemeBootstrapScript() {
  return (
    <script
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: bootstrapTheme }}
    />
  )
}
