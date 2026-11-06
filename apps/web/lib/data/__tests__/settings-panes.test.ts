// Settings' panes as one table (lib/data/settings-panes.ts): which mode
// offers each, where a link to one lands in the mode that does not, the
// panes a page took the place of, and the addresses built from it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getBusinessModuleHref } from "../business-links"
import { migrateLegacyHref } from "../legacy-ids"
import { DEFAULT_SETTINGS_PANE, projectShown, settingsAddressShown, settingsHref, settingsNav, settingsPaneHeading, settingsPaneOf, settingsPaneOffered, SETTINGS_PANES, settingsTabsOffered } from "../settings-panes"
import { footerItems } from "../sidebar"

const shown = (id: string | undefined, configured: boolean, params: Record<string, string> = {}) => settingsAddressShown(id, params, configured)
const paneShown = (id: string | undefined, configured: boolean) => shown(id, configured).pane

const RETIRED = ["ticket-types", "ticket-sla", "ticket-teams", "commercial-ticket-charges", "counting-rules"]

describe("the Settings panes offered", () => {
  test("Master data on the Pilot only, Asset management in fixture mode only", () => {
    assert.equal(settingsPaneOffered("master-data", true), true)
    assert.equal(settingsPaneOffered("master-data", false), false)
    assert.equal(settingsPaneOffered("asset-management", true), false)
    assert.equal(settingsPaneOffered("asset-management", false), true)
    assert.equal(settingsPaneOffered("no-such-pane", false), false)
  })

  test("Company & projects in fixture mode alone: it reads only the browser's organisation store, and a link to it on the Pilot opens the default pane", () => {
    assert.equal(settingsPaneOffered("company", false), true)
    assert.equal(settingsPaneOffered("company", true), false)
    assert.equal(paneShown("company", true), DEFAULT_SETTINGS_PANE)
    assert.equal(paneShown("company", false), "company")
  })

  test("the API's own panes on the Pilot only: Exception charges (M5 of #293), Bulky schedules (O11 of #290), Recycling-centre charges (#393), Message templates (#291 C15)", () => {
    for (const pane of ["pickup-exception-charges", "operations-bulky-schedules", "commercial-visit-rules", "message-templates"]) {
      assert.equal(settingsPaneOffered(pane, true), true, pane)
      assert.equal(settingsPaneOffered(pane, false), false, pane)
    }
  })

  test("Settings › Tickets on the Pilot only, in place of Tickets & communication, whose link opens it there at its deadlines (O4 of #290, #548 of #544)", () => {
    assert.equal(settingsPaneOffered("tickets", true), true)
    assert.equal(settingsPaneOffered("tickets", false), false)
    assert.equal(settingsPaneOffered("ticket-comms", true), false)
    assert.equal(settingsPaneOffered("ticket-comms", false), true)
    assert.deepEqual(shown("ticket-comms", true), { pane: "tickets", params: { tab: "deadlines" } })
    assert.deepEqual(shown("ticket-comms", false), { pane: "ticket-comms", params: {} })
  })

  test("the ticket panes the Tickets page took the place of open it at their tab, so a link made before it reads as it did (#548 of #544)", () => {
    const opened: [string, string][] = [
      ["ticket-types", "types"],
      ["ticket-sla", "deadlines"],
      ["commercial-ticket-charges", "charges"],
      ["counting-rules", "counting-rules"],
    ]
    for (const [paneId, tab] of opened) assert.deepEqual(shown(paneId, true), { pane: "tickets", params: { tab } }, paneId)
    assert.deepEqual(shown("tickets", true), { pane: "tickets", params: {} })
    assert.deepEqual(settingsTabsOffered("tickets", true).map((tab) => tab.label), ["Types", "Default teams", "Deadlines", "Charges", "Counting rules"])
  })

  test("the ticket teams' pane opens Users & roles at its Teams tab on the Pilot, where the teams are kept; the pane's own id opens it at its first tab, and fixture mode has no Teams tab", () => {
    assert.deepEqual(shown("ticket-teams", true), { pane: "access", params: { tab: "teams" } })
    assert.deepEqual(shown("access", true), { pane: "access", params: {} })
    assert.deepEqual(shown("ticket-teams", false), { pane: "access", params: {} })
    assert.deepEqual(shown("access", false, { tab: "teams" }), { pane: "access", params: {} })
    assert.deepEqual(settingsTabsOffered("access", true).map((tab) => tab.label), ["Users", "Roles", "Teams"])
    assert.deepEqual(settingsTabsOffered("access", false).map((tab) => tab.label), ["Users", "Roles"])
  })

  test("the browser's twins and the API's: one pane in each mode, a link to either opening the one its mode has (#291 C4, #487, O16 of #290)", () => {
    for (const [browser, api] of [
      ["finance", "finance-invoicing"],
      ["integrations", "integrations-on-api"],
      ["portals", "portals-on-api"],
      ["notifications", "notifications-on-api"],
    ]) {
      assert.equal(settingsPaneOffered(browser, true), false, browser)
      assert.equal(settingsPaneOffered(browser, false), true, browser)
      assert.equal(settingsPaneOffered(api, true), true, api)
      assert.equal(settingsPaneOffered(api, false), false, api)
      assert.equal(paneShown(browser, true), api, browser)
      assert.equal(paneShown(browser, false), browser, browser)
      assert.equal(paneShown(api, false), browser, api)
      assert.equal(paneShown(api, true), api, api)
    }
    assert.equal(settingsPaneOffered("commercial-price-lists", true), true, "Settings › Commercial keeps its price lists in both modes")
    assert.equal(settingsPaneOffered("commercial-products", true), true)
  })

  test("Operations setup and Commercial defaults, which only this browser keeps, are fixture mode's alone (#487); on the Pilot a link to one opens where its subject lives", () => {
    for (const [pane, landing] of [
      ["operations-setup", "master-data"],
      ["pricing", "commercial-products"],
    ]) {
      assert.equal(settingsPaneOffered(pane, true), false, pane)
      assert.equal(settingsPaneOffered(pane, false), true, pane)
      assert.equal(paneShown(pane, true), landing, pane)
      assert.equal(paneShown(pane, false), pane, pane)
    }
    assert.equal(settingsPaneOffered("account", true), true, "Account & appearance stays: its profile is /me's and its theme is the device's own")
  })

  test("a link to Asset management opens Master data on the Pilot, and Master data's opens Asset management in fixture mode", () => {
    assert.equal(paneShown("asset-management", true), "master-data")
    assert.equal(paneShown("asset-management", false), "asset-management")
    assert.equal(paneShown("master-data", false), "asset-management")
  })

  test("a deep link opens only a pane its mode offers: a Pilot-only pane in fixture mode opens the fixtures' own, or the default pane", () => {
    assert.equal(paneShown("operations-bulky-schedules", false), DEFAULT_SETTINGS_PANE)
    assert.equal(paneShown("commercial-visit-rules", false), DEFAULT_SETTINGS_PANE)
    assert.equal(paneShown("pickup-exception-charges", false), DEFAULT_SETTINGS_PANE)
    assert.equal(paneShown("message-templates", false), "ticket-comms")
    assert.equal(paneShown("tickets", false), "ticket-comms")
    for (const configured of [true, false]) {
      for (const id of [...SETTINGS_PANES.map((pane) => pane.id), ...RETIRED, "no-such-pane", undefined]) {
        const opened = shown(id, configured)
        assert.equal(settingsPaneOffered(opened.pane, configured), true, `${id} with the adapter ${configured ? "configured" : "not"}`)
        if (opened.params.tab !== undefined) assert.ok(settingsTabsOffered(opened.pane, configured).some((tab) => tab.value === opened.params.tab), `${id}: ${opened.params.tab}`)
      }
    }
  })

  test("an address keeps the params its pane reads and no other", () => {
    assert.deepEqual(shown("tickets", true, { type: "3f1c", from: "/tickets", kind: "x" }), { pane: "tickets", params: { type: "3f1c" } })
    assert.deepEqual(shown("master-data", true, { kind: "container-type", record: "fraction-01", tab: "x" }), { pane: "master-data", params: { kind: "container-type", record: "fraction-01" } })
    assert.deepEqual(shown("tickets", true, { tab: "nonsense" }), { pane: "tickets", params: {} })
    assert.deepEqual(shown("ticket-comms", true, { record: "r" }), { pane: "tickets", params: { tab: "deadlines" } }, "a pane landed on instead takes none of the link's own")
  })

  test("every pane a pane names, and every tab, is one the table holds", () => {
    const ids = new Set<string>(SETTINGS_PANES.map((pane) => pane.id))
    assert.equal(ids.size, SETTINGS_PANES.length, "one entry a pane")
    for (const pane of SETTINGS_PANES) {
      if (pane.instead !== undefined) {
        const landing = settingsPaneOf(pane.instead.pane)
        assert.ok(landing, `${pane.id} lands on ${pane.instead.pane}`)
        if (pane.instead.tab !== undefined) assert.ok(landing?.tabs?.some((tab) => tab.value === pane.instead?.tab), `${pane.id}: ${pane.instead.tab}`)
      }
      for (const [retired, tab] of Object.entries(pane.absorbs ?? {})) {
        assert.equal(ids.has(retired), false, `${retired} is retired, not a pane`)
        assert.ok(pane.tabs?.some((candidate) => candidate.value === tab), `${retired}: ${tab}`)
      }
    }
  })
})

describe("the Settings nav", () => {
  test("lists each section's panes its mode offers, one Notifications in each mode", () => {
    const labels = (configured: boolean) => settingsNav(configured, "").flatMap((section) => section.panes.map((pane) => pane.label))
    assert.equal(labels(true).filter((label) => label === "Notifications").length, 1)
    assert.equal(labels(false).filter((label) => label === "Notifications").length, 1)
    assert.ok(!labels(true).includes("Operations setup"))
    assert.ok(labels(false).includes("Operations setup"))
    assert.deepEqual(settingsNav(true, "").map((section) => section.label), ["Personal", "Organization", "Operations", "Administration", "Commercial"])
  })

  test("the search finds a pane by its terms and by what its content says, and drops the sections it finds nothing in", () => {
    const found = (search: string, more: (id: string) => readonly string[] = () => []) => settingsNav(false, search, more).flatMap((section) => section.panes.map((pane) => pane.id))
    assert.deepEqual(found("midnight"), ["account"])
    assert.deepEqual(found("locksmith"), ["asset-management"])
    assert.deepEqual(found("webfleet", (id) => (id === "integrations" ? ["Fleet GPS · Webfleet"] : [])), ["integrations"])
    assert.deepEqual(settingsNav(false, "zzz-nothing"), [])
  })

  test("a pane is headed by its section, or by its own label where its tabs or records title themselves", () => {
    const heading = (id: string) => settingsPaneHeading(settingsPaneOf(id)!)
    assert.equal(heading("operations-bulky-schedules"), "Operations")
    assert.equal(heading("commercial-visit-rules"), "Commercial")
    assert.equal(heading("notifications-on-api"), "Personal")
    assert.equal(heading("tickets"), "Tickets")
    assert.equal(heading("access"), "Users & roles")
    assert.equal(heading("company"), "Company & projects")
  })
})

describe("Settings addresses", () => {
  test("a pane's address carries its own params and where Back to app returns, unless that is the start", () => {
    assert.equal(settingsHref("tickets", { type: "3f1c" }), "/settings?pane=tickets&type=3f1c")
    assert.equal(settingsHref("tickets", { type: "3f1c", from: "/tickets" }), "/settings?pane=tickets&type=3f1c&from=%2Ftickets")
    assert.equal(settingsHref("tickets", { type: null, from: "/" }), "/settings?pane=tickets")
    assert.equal(settingsHref("access", { tab: "teams" }), "/settings?pane=access&tab=teams")
    assert.equal(settingsHref("master-data", { kind: "container-type" }), "/settings?pane=master-data&kind=container-type")
  })

  test("the scheme pages' link to Holiday lists names the pane alone: it reads no project (#564)", () => {
    assert.equal(settingsHref("holiday-lists"), "/settings?pane=holiday-lists")
    assert.equal(settingsHref("holiday-lists", { project: "project-cairo" } as never), "/settings?pane=holiday-lists")
  })

  test("a Configure module's record opens its pane, with the record where the pane reads one", () => {
    assert.equal(getBusinessModuleHref("configure", "areas", "area-1"), "/settings?pane=areas&record=area-1")
    assert.equal(getBusinessModuleHref("configure", "organization", "company-1"), "/settings?pane=company")
    assert.equal(getBusinessModuleHref("configure", "templates"), "/settings?pane=ticket-comms")
    assert.equal(migrateLegacyHref("/plan?module=areas&record=area-1#map"), "/settings?pane=areas&record=area-1#map")
  })

  test("the sidebar's Ticket templates opens Message templates on the Pilot, and the fixtures' Tickets & communication without it", () => {
    const templates = footerItems.find((item) => item.id === "templates")
    assert.ok(templates)
    assert.equal(paneShown(templates.pane, true), "message-templates")
    assert.equal(paneShown(templates.pane, false), "ticket-comms")
    const settings = footerItems.find((item) => item.id === "settings")
    assert.equal(paneShown(settings?.pane, true), "account")
  })
})

describe("the project a per-project pane shows", () => {
  test("the one picked where the pane lists it, else the first by name", () => {
    // The person's projects by the API's id, and the organisation's records by the web's, in different orders.
    const mine = [{ id: "p-2", name: "Copenhagen Central" }, { id: "p-1", name: "Cairo Operations" }]
    const records = [{ id: "project-p-1", name: "Cairo Operations" }, { id: "project-p-2", name: "Copenhagen Central" }].reverse()
    const serverIdOfRecord = (record: { id: string }) => record.id.slice("project-".length)
    assert.equal(projectShown(mine, null, (project) => project.id)?.name, "Cairo Operations")
    assert.equal(projectShown(records, null, serverIdOfRecord)?.name, "Cairo Operations")
    assert.equal(projectShown(mine, "p-2", (project) => project.id)?.name, "Copenhagen Central")
    assert.equal(projectShown(records, "p-2", serverIdOfRecord)?.name, "Copenhagen Central")
    assert.equal(projectShown(mine, "p-9", (project) => project.id)?.name, "Cairo Operations", "a project the pane does not list")
    assert.equal(projectShown([], "p-1", (project: { id: string; name: string }) => project.id), null)
  })
})
