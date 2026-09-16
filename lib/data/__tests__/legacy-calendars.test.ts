import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  hasLegacyIds,
  migrateLegacyHref,
  migrateLegacyRecordBuckets,
  migrateLegacyState,
} from "../legacy-ids"

// Collection Calendars left the Plan workspace for Settings (2026-09-16):
// persisted buckets, relation refs, and bookmarks written before the move
// follow the same seam Areas & Zones used (plan.areas → configure.areas).
describe("Collection Calendars move: plan.calendars → configure.calendars", () => {
  test("a Plan deep link into calendars opens the Settings pane", () => {
    assert.equal(
      migrateLegacyHref("/plan?module=calendars"),
      "/settings?pane=collection-calendars",
    )
    assert.equal(
      migrateLegacyHref("/plan?module=calendars&record=calendar-central"),
      "/settings?pane=collection-calendars&record=calendar-central",
    )
    assert.equal(
      migrateLegacyHref("/plan?module=calendars#holidays"),
      "/settings?pane=collection-calendars#holidays",
    )
  })

  test("the Areas & Zones migration and every other Plan href are unchanged", () => {
    assert.equal(
      migrateLegacyHref("/plan?module=areas&record=area-indreby"),
      "/settings?pane=areas&record=area-indreby",
    )
    assert.equal(migrateLegacyHref("/plan"), "/plan")
    assert.equal(migrateLegacyHref("/plan?module=map-planning"), "/plan?module=map-planning")
  })

  test("a stored relation ref naming the old home is re-pointed", () => {
    const stored = {
      relationRefs: [
        {
          fieldId: "calendarId",
          workspaceId: "plan",
          moduleId: "calendars",
          recordId: "calendar-central",
          label: "Copenhagen Central 2026",
        },
      ],
    }
    const migrated = migrateLegacyState(stored)
    assert.equal(migrated.relationRefs[0].workspaceId, "configure")
    assert.equal(migrated.relationRefs[0].moduleId, "calendars")
    assert.equal(migrated.relationRefs[0].recordId, "calendar-central")
  })

  test("a persisted plan.calendars record bucket moves to configure.calendars", () => {
    const migrated = migrateLegacyRecordBuckets({
      "plan.calendars": [{ id: "calendar-user-1" }],
      "configure.calendars": [{ id: "calendar-central" }],
    })
    assert.deepEqual(Object.keys(migrated).sort(), ["configure.calendars"])
    assert.deepEqual(
      migrated["configure.calendars"].map((record) => record.id).sort(),
      ["calendar-central", "calendar-user-1"],
    )
  })

  test("hasLegacyIds detects both persisted shapes", () => {
    assert.equal(hasLegacyIds('{"plan.calendars":[]}'), true)
    assert.equal(hasLegacyIds('{"workspaceId": "plan", "moduleId": "calendars"}'), true)
    assert.equal(hasLegacyIds('{"configure.calendars":[]}'), false)
  })
})
