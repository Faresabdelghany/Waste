// Which Settings panes are offered with the adapter configured and without
// it (Issues #176, #181): Master data holds rows the API alone keeps, so only
// the Pilot offers it; Asset management's browser store retires on the Pilot
// — its container types and fractions are master data there, and its other
// libraries have no API — so only fixture mode offers it, and a link to it
// on the Pilot opens Master data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MASTER_DATA_SETTINGS_PANE_ID } from "../business-links"
import { ASSET_MANAGEMENT_SETTINGS_PANE_ID, settingsPaneOffered, settingsPaneOpened } from "../settings-panes"

describe("the Settings panes offered", () => {
  test("Master data on the Pilot only, Asset management in fixture mode only, every other pane in both", () => {
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered("company", true), true)
    assert.equal(settingsPaneOffered("company", false), true)
  })

  test("a link to Asset management opens Master data on the Pilot, and itself in fixture mode", () => {
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), MASTER_DATA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), ASSET_MANAGEMENT_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened("company", true), "company")
  })
})
