import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"

import {
  HOLIDAY_LISTS_SETTINGS_PANE_ID,
  HOLIDAY_SETTINGS_HREF,
  holidaySettingsHref,
} from "../business-links"
import {
  FIXTURE_PROJECT_IDS,
  businessWorkspaces,
  type BusinessRecord,
} from "../business-modules"
import { withProjectCalendar } from "../holiday-lists"

const organisation = businessWorkspaces.configure.modules.find(
  (module) => module.id === "organization",
)?.records
if (!organisation) throw new Error("the configure fixtures are missing")

const fixture = (records: readonly BusinessRecord[], id: string): BusinessRecord => {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`no fixture ${id}`)
  return record
}

describe("the pane's address", () => {
  test("the wizard and the scheme detail link to the pane, on the scheme's project when known", () => {
    assert.equal(holidaySettingsHref(), `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}`)
    assert.equal(
      holidaySettingsHref(FIXTURE_PROJECT_IDS.cairo),
      `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}&project=project-cairo`,
    )
    assert.equal(HOLIDAY_SETTINGS_HREF, holidaySettingsHref())
  })
})

describe("withProjectCalendar — the project record's list name and weekend", () => {
  const harbor = fixture(organisation, FIXTURE_PROJECT_IDS.harbor)

  test("writes the typed values resolveProjectCalendar reads and the facts beside them", () => {
    const written = withProjectCalendar(harbor, {
      holidayList: " Danish public holidays ",
      weekend: ["sunday", "saturday"],
    })
    assert.equal(written.submittedValues?.holidayList, "Danish public holidays")
    assert.equal(written.submittedValues?.weekend, "saturday, sunday")
    assert.equal(written.facts["Holiday list"], "Danish public holidays")
    assert.equal(written.facts.Weekend, "Sat–Sun")
    assert.equal(written.facts.Language, "Danish")
    assert.equal(written.updated, "Now")
    const calendar = resolveProjectCalendar(harbor.id, { projects: [written], calendars: [] })
    assert.equal(calendar.list?.name, "Danish public holidays")
    assert.deepEqual(calendar.weekend, ["saturday", "sunday"])
  })

  test("a blank name means no list: the value and the fact go, the weekend stays", () => {
    const copenhagen = fixture(organisation, FIXTURE_PROJECT_IDS.copenhagen)
    const written = withProjectCalendar(copenhagen, { holidayList: "  ", weekend: ["friday", "saturday"] })
    assert.equal("holidayList" in (written.submittedValues ?? {}), false)
    assert.equal("Holiday list" in written.facts, false)
    assert.equal(written.submittedValues?.weekend, "friday, saturday")
    assert.equal(written.facts.Weekend, "Fri–Sat")
    assert.equal(resolveProjectCalendar(copenhagen.id, { projects: [written], calendars: [] }).list, null)
    // The input is left as it was.
    assert.equal(copenhagen.submittedValues?.holidayList, "Danish public holidays")
  })
})
