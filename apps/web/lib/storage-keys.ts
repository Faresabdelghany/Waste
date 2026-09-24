/**
 * Every browser-storage key the web app writes, and the keys it wrote before
 * the working name changed (2026-09-24: the `wastehero…` prefix became
 * `waste…`, the name the `@waste/*` namespace and the repository already
 * carry).
 *
 * The rename lives in this module alone. A store imports its key constant and
 * reads through `readPersisted`, which returns the value under the current
 * key or, when the browser holds none, moves the first legacy key that has
 * one across and returns that. Nothing is dropped — state persisted under the
 * old name survives the rename — and the move is idempotent, so the next read
 * finds the current key. Writes always go to the current key, so no store
 * needs to know a legacy key exists.
 *
 * The retired key strings are spelled in `LEGACY_STORAGE_KEYS` and nowhere
 * else: the one reader that cannot import this module at run time, the inline
 * theme bootstrap script, interpolates `persistedKeys()` into its source.
 */

/** Records created and edited in the workspace shell, merged over fixtures. */
export const BUSINESS_RECORDS_STORAGE_KEY = "waste-business-records-v1"

/** Routes pinned to a persona's sidebar, by scope. */
export const ACTIVE_ROUTES_STORAGE_KEY = "waste-active-routes-v1"

/** The planning map's chosen base map. */
export const BASE_MAP_STORAGE_KEY = "waste-map-planning-base-map-v1"

/** The planning map's cached OSRM road geometry, oldest first, capped. */
export const ROAD_GEOMETRY_STORAGE_KEY = "waste-map-road-geometry-v1"

/** The planning map's named saved selections. */
export const SAVED_SELECTIONS_STORAGE_KEY = "waste-map-selections-v1"

/** The Settings dialog's control values. */
export const SETTINGS_STORAGE_KEY = "waste.settings.v1"

/** The organization store: tenant, users, roles, access. */
export const ORGANIZATION_STORAGE_KEY = "waste.organization.v1"

/** The asset-management settings store. */
export const ASSET_MANAGEMENT_STORAGE_KEY = "waste.asset-management.v1"

/** The commercial registries settings store. */
export const COMMERCIAL_REGISTRIES_STORAGE_KEY = "waste.commercial-registries.v1"

/** The selected app theme (a preset id or "custom"). */
export const APP_THEME_SELECTION_STORAGE_KEY = "waste.theme.selection.v1"

/** The custom theme palette, read when the selection is "custom". */
export const CUSTOM_THEME_STORAGE_KEY = "waste.theme.custom.v1"

/**
 * Current key → the keys it used to be written under, oldest state last: the
 * first key that holds a value wins, so a browser carrying two generations of
 * one store reads the newer one. Whatever comes back still goes through the
 * store's own shape migration — `waste-active-routes-v1` has two legacy keys
 * holding two different shapes, and `components/waste/active-routes-store.tsx`
 * recognises both.
 */
export const LEGACY_STORAGE_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  [BUSINESS_RECORDS_STORAGE_KEY]: ["wastehero-business-records-v1"],
  // The service provider's pins shipped first under their own key, holding a
  // bare route-id list; the operator scope then moved both scopes into one
  // object under the second key.
  [ACTIVE_ROUTES_STORAGE_KEY]: [
    "wastehero-active-routes-v1",
    "wastehero-contractor-active-routes-v1",
  ],
  [BASE_MAP_STORAGE_KEY]: ["wastehero-map-planning-base-map-v1"],
  [ROAD_GEOMETRY_STORAGE_KEY]: ["wastehero-map-road-geometry-v1"],
  [SAVED_SELECTIONS_STORAGE_KEY]: ["wastehero-map-selections-v1"],
  [SETTINGS_STORAGE_KEY]: ["wastehero.settings.v1"],
  [ORGANIZATION_STORAGE_KEY]: ["wastehero.organization.v1"],
  [ASSET_MANAGEMENT_STORAGE_KEY]: ["wastehero.asset-management.v1"],
  [COMMERCIAL_REGISTRIES_STORAGE_KEY]: ["wastehero.commercial-registries.v1"],
  [APP_THEME_SELECTION_STORAGE_KEY]: ["wastehero.theme.selection.v1"],
  [CUSTOM_THEME_STORAGE_KEY]: ["wastehero.theme.custom.v1"],
}

/**
 * The keys to try for one store, current first. `readPersisted` walks this
 * list; the theme bootstrap script, which runs as inline source before any
 * module loads, interpolates it and walks it the same way.
 */
export function persistedKeys(key: string): readonly string[] {
  return [key, ...legacyKeys(key)]
}

function legacyKeys(key: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(LEGACY_STORAGE_KEYS, key)
    ? LEGACY_STORAGE_KEYS[key]
    : []
}

/**
 * The value a store persisted, whichever generation of the key holds it.
 *
 * The current key wins. Otherwise the legacy keys are read in order and the
 * first value found is moved to the current key (written there, removed from
 * the legacy key) and returned, so the fallback costs one read per store and
 * only until the browser has been through it once. A storage that refuses
 * reads or writes — private mode, a blocked or full store — never fails the
 * caller: the value is still returned and the move is retried next time.
 */
export function readPersisted(
  storage: Storage | null | undefined,
  key: string,
): string | null {
  if (!storage) return null
  try {
    const current = storage.getItem(key)
    if (current !== null) return current
  } catch {
    return null
  }
  for (const legacyKey of legacyKeys(key)) {
    let value: string | null = null
    try {
      value = storage.getItem(legacyKey)
    } catch {
      return null
    }
    if (value === null) continue
    try {
      storage.setItem(key, value)
      storage.removeItem(legacyKey)
    } catch {
      // Keep the value: a store that cannot be written to is still readable,
      // and the move happens on the first load that can write.
    }
    return value
  }
  return null
}
