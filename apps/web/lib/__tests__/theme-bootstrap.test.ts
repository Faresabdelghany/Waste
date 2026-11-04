// The theme bootstrap script on a public page (#506): a resident's page takes
// Ash whatever the browser holds — a staff theme saved here, or a dark
// preference — and writes nothing back, so the staff app's saved theme is
// still the staff member's. Off the public pages it reads the saved theme as
// before. The script runs here against a stub document and storage, the way
// the browser runs it before any module loads.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { APP_THEME_SELECTION_STORAGE_KEY } from "../storage-keys"
import { THEME_BOOTSTRAP_SOURCE } from "../theme-bootstrap"

type Ran = { theme: string | undefined; dark: boolean; storage: Map<string, string> }

function run(pathname: string, stored: Record<string, string>, prefersDark = false): Ran {
  const storage = new Map(Object.entries(stored))
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  const classes = new Set<string>()
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: () => {}, colorScheme: "" },
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
  }
  const window = { location: { pathname }, matchMedia: () => ({ matches: prefersDark }) }
  new Function("window", "document", "localStorage", THEME_BOOTSTRAP_SOURCE)(window, { documentElement: root }, localStorage)
  return { theme: root.dataset.appTheme, dark: classes.has("dark"), storage }
}

describe("the theme bootstrap", () => {
  test("gives a public page Ash under a saved staff theme or a dark preference, and writes nothing", () => {
    for (const saved of ["midnight", "dawn", "pale"]) {
      const ran = run("/p/kystbyen/sorting-guide", { [APP_THEME_SELECTION_STORAGE_KEY]: saved })
      assert.deepEqual([ran.theme, ran.dark], ["ash", false], saved)
      assert.equal(ran.storage.get(APP_THEME_SELECTION_STORAGE_KEY), saved, "the staff member's theme is still theirs")
    }
    const dark = run("/p/kystbyen", {}, true)
    assert.deepEqual([dark.theme, dark.dark, dark.storage.size], ["ash", false, 0])
  })

  test("off the public pages, reads the saved theme as before", () => {
    const ran = run("/operate", { [APP_THEME_SELECTION_STORAGE_KEY]: "midnight" })
    assert.deepEqual([ran.theme, ran.dark], ["midnight", true])
    assert.equal(run("/operate", {}).theme, "ash", "nothing saved: the default")
  })
})
