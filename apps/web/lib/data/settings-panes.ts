// Which Settings panes are offered with the adapter configured and without it
// (Issues #176, #181). Master data holds rows the API alone keeps, so only
// the Pilot offers it. Asset management's browser store retires on the Pilot:
// its container types and waste fractions are master data there, and its
// other libraries — spare parts, part types, property equipment, key types —
// have no API, and a list only one browser sees is no Pilot list; so only
// fixture mode offers it, and a link to it on the Pilot (the containers
// view's "Asset settings") opens Master data. Fixture mode is unchanged.
import { MASTER_DATA_SETTINGS_PANE_ID } from "./business-links"

export const ASSET_MANAGEMENT_SETTINGS_PANE_ID = "asset-management"

/** Whether the Settings nav offers a pane, with the adapter configured or not. */
export function settingsPaneOffered(paneId: string, configured: boolean): boolean {
  if (paneId === MASTER_DATA_SETTINGS_PANE_ID) return configured
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID) return !configured
  return true
}

/** The pane a link to one opens: on the Pilot, Asset management's is Master data's. */
export function settingsPaneOpened(paneId: string, configured: boolean): string {
  return configured && paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID ? MASTER_DATA_SETTINGS_PANE_ID : paneId
}
