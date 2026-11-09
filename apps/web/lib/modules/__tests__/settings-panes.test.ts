// Settings' panes as one table (lib/modules/settings-panes.ts): the one pane
// drawn without an API, the panes a page took the place of, and the
// addresses built from it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { workspaceHref } from "@/lib/data/workspace-href"
import { migrateLegacyHref } from "@/lib/data/legacy-ids"
import { DEFAULT_SETTINGS_PANE, settingsAddressShown, settingsHref, settingsNav, settingsPaneDrawnWithoutApi, settingsPaneHeading, settingsPaneOf, SETTINGS_PANES, settingsTabsOf } from "../settings-panes"
import { footerItems } from "@/lib/data/sidebar"

const shown = (id: string | undefined, params: Record<string, string> = {}) => settingsAddressShown(id, params)
const paneShown = (id: string | undefined) => shown(id).pane

const RETIRED = ["ticket-types", "ticket-sla", "ticket-teams", "commercial-ticket-charges", "counting-rules", "ticket-comms", "notifications", "asset-management", "operations-setup", "finance", "pricing", "integrations", "portals"]

describe("the Settings panes", () => {
  test("Account & appearance alone is drawn without an API: every other pane's subject is kept on the API", () => {
    assert.deepEqual(SETTINGS_PANES.filter(settingsPaneDrawnWithoutApi).map((pane) => pane.id), ["account"])
  })

  test("the browser's twins of the API's panes are gone, a link to one opening the pane that holds its subject", () => {
    for (const [twin, landing] of [
      ["asset-management", "master-data"],
      ["operations-setup", "master-data"],
      ["finance", "finance-invoicing"],
      ["integrations", "integrations-on-api"],
      ["portals", "portals-on-api"],
      ["notifications", "notifications-on-api"],
      ["pricing", "commercial-products"],
    ]) {
      assert.equal(settingsPaneOf(twin), undefined, twin)
      assert.deepEqual(shown(twin), { pane: landing, params: {} }, twin)
    }
    assert.deepEqual(shown("ticket-comms"), { pane: "tickets", params: { tab: "deadlines" } })
  })

  test("Company & projects is gone with the browser's organisation store, a link to it opening the default pane", () => {
    assert.equal(settingsPaneOf("company"), undefined)
    assert.equal(paneShown("company"), DEFAULT_SETTINGS_PANE)
  })

  test("the ticket panes the Tickets page took the place of open it at their tab, so a link made before it reads as it did (#548 of #544)", () => {
    const opened: [string, string][] = [
      ["ticket-types", "types"],
      ["ticket-sla", "deadlines"],
      ["commercial-ticket-charges", "charges"],
      ["counting-rules", "counting-rules"],
    ]
    for (const [paneId, tab] of opened) assert.deepEqual(shown(paneId), { pane: "tickets", params: { tab } }, paneId)
    assert.deepEqual(shown("tickets"), { pane: "tickets", params: {} })
    assert.deepEqual(settingsTabsOf("tickets").map((tab) => tab.label), ["Types", "Default teams", "Deadlines", "Charges", "Counting rules"])
  })

  test("the ticket teams' pane opens Users & roles at its Teams tab, where the teams are kept; the pane's own id opens it at its first tab", () => {
    assert.deepEqual(shown("ticket-teams"), { pane: "access", params: { tab: "teams" } })
    assert.deepEqual(shown("access"), { pane: "access", params: {} })
    assert.deepEqual(settingsTabsOf("access").map((tab) => tab.label), ["Users", "Roles", "Teams"])
  })

  test("a deep link opens a pane the table holds, or the default pane", () => {
    for (const id of [...SETTINGS_PANES.map((pane) => pane.id), ...RETIRED, "no-such-pane", undefined]) {
      const opened = shown(id)
      assert.ok(settingsPaneOf(opened.pane), `${id}`)
      if (opened.params.tab !== undefined) assert.ok(settingsTabsOf(opened.pane).some((tab) => tab.value === opened.params.tab), `${id}: ${opened.params.tab}`)
    }
    assert.equal(paneShown("no-such-pane"), DEFAULT_SETTINGS_PANE)
  })

  test("an address keeps the params its pane reads and no other", () => {
    assert.deepEqual(shown("tickets", { type: "3f1c", from: "/tickets", kind: "x" }), { pane: "tickets", params: { type: "3f1c" } })
    assert.deepEqual(shown("master-data", { kind: "container-type", record: "fraction-01", tab: "x" }), { pane: "master-data", params: { kind: "container-type", record: "fraction-01" } })
    assert.deepEqual(shown("tickets", { tab: "nonsense" }), { pane: "tickets", params: {} })
  })

  test("every pane a pane absorbs is retired, and every tab it opens at is one of its own", () => {
    const ids = new Set<string>(SETTINGS_PANES.map((pane) => pane.id))
    assert.equal(ids.size, SETTINGS_PANES.length, "one entry a pane")
    for (const pane of SETTINGS_PANES) {
      for (const [retired, tab] of Object.entries(pane.absorbs ?? {})) {
        assert.equal(ids.has(retired), false, `${retired} is retired, not a pane`)
        if (tab !== null) assert.ok(pane.tabs?.some((candidate) => candidate.value === tab), `${retired}: ${tab}`)
      }
    }
  })
})

describe("the Settings nav", () => {
  test("lists each section's panes, one Notifications among them", () => {
    const labels = settingsNav("").flatMap((section) => section.panes.map((pane) => pane.label))
    assert.equal(labels.filter((label) => label === "Notifications").length, 1)
    assert.deepEqual(settingsNav("").map((section) => section.label), ["Personal", "Organization", "Operations", "Administration", "Commercial"])
  })

  test("the search finds a pane by its terms and by what its content says, and drops the sections it finds nothing in", () => {
    const found = (search: string, more: (id: string) => readonly string[] = () => []) => settingsNav(search, more).flatMap((section) => section.panes.map((pane) => pane.id))
    assert.deepEqual(found("midnight"), ["account"])
    assert.deepEqual(found("webfleet", (id) => (id === "integrations-on-api" ? ["Fleet GPS · Webfleet"] : [])), ["integrations-on-api"])
    assert.deepEqual(settingsNav("zzz-nothing"), [])
  })

  test("a pane is headed by its section, or by its own label where its tabs or records title themselves", () => {
    const heading = (id: string) => settingsPaneHeading(settingsPaneOf(id)!)
    assert.equal(heading("operations-bulky-schedules"), "Operations")
    assert.equal(heading("commercial-visit-rules"), "Commercial")
    assert.equal(heading("notifications-on-api"), "Personal")
    assert.equal(heading("tickets"), "Tickets")
    assert.equal(heading("access"), "Users & roles")
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
    assert.equal(workspaceHref({ workspaceId: "configure", moduleId: "areas" }, "area-1"), "/settings?pane=areas&record=area-1")
    assert.equal(workspaceHref({ workspaceId: "configure", moduleId: "organization" }, "company-1"), `/settings?pane=${DEFAULT_SETTINGS_PANE}`)
    assert.equal(workspaceHref({ workspaceId: "configure", moduleId: "templates" }), "/settings?pane=tickets")
    assert.equal(workspaceHref({ workspaceId: "configure", moduleId: "finance" }), "/settings?pane=finance-invoicing")
    assert.equal(migrateLegacyHref("/plan?module=areas&record=area-1#map"), "/settings?pane=areas&record=area-1#map")
  })

  // Bug: a ticket type's or a ticket team's link opened Settings › Tickets on a tab of the pane's choosing (once Deadlines), never the record.
  test("a ticket type opens on its own page under Tickets, and a ticket team under Users & roles' Teams", () => {
    const templates = { workspaceId: "configure", moduleId: "templates" } as const
    assert.equal(workspaceHref(templates, "ticket-type-0190a6d2-0000-7000-8000-000000000001"), "/settings?pane=tickets&type=ticket-type-0190a6d2-0000-7000-8000-000000000001")
    assert.equal(workspaceHref(templates, "team-0190a6d2-0000-7000-8000-000000000002"), "/settings?pane=access&tab=teams")
    assert.equal(workspaceHref(templates, "template-1"), "/settings?pane=tickets", "any other record of the module opens the pane")
  })

  test("the sidebar's Ticket templates opens Message templates, and its Settings the account", () => {
    const templates = footerItems.find((item) => item.id === "templates")
    assert.ok(templates)
    assert.equal(paneShown(templates.pane), "message-templates")
    const settings = footerItems.find((item) => item.id === "settings")
    assert.equal(paneShown(settings?.pane), "account")
  })
})
