// Settings › Portals & branding on the Pilot (#487): a project's public
// pages under its slug, and how many of its drivers may sign in to the
// Driver App.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { driverAppReadingOf, publicPagesOf, publicSlugOf } from "../portals"

const record = (id: string, submittedValues: BusinessRecord["submittedValues"]): BusinessRecord => ({ id, name: id, facts: {}, submittedValues }) as BusinessRecord

describe("a project's public pages", () => {
  test("a project is published under its slug, and not without one", () => {
    assert.equal(publicSlugOf(record("project-copenhagen", { publicSlug: "copenhagen" })), "copenhagen")
    assert.equal(publicSlugOf(record("project-harbor", {})), null)
    assert.equal(publicSlugOf(record("project-harbor", { publicSlug: "" })), null)
  })

  test("its pages are the collection days, the drop-off points and the sorting guide, under the slug", () => {
    assert.deepEqual(publicPagesOf("kystbyen"), [
      { label: "Collection days", href: "/p/kystbyen/calendar" },
      { label: "Drop-off points", href: "/p/kystbyen/drop-off" },
      { label: "Sorting guide", href: "/p/kystbyen/sorting" },
    ])
  })
})

describe("the Driver App", () => {
  test("counts a project's drivers with a login among its drivers, never another project's", () => {
    const drivers = [
      record("driver-1", { projectId: "project-copenhagen", driverAppAccess: true }),
      record("driver-2", { projectId: "project-copenhagen", driverAppAccess: false }),
      record("driver-3", { projectId: "project-harbor", driverAppAccess: true }),
    ]
    assert.equal(driverAppReadingOf(drivers, "project-copenhagen"), "1 of 2 drivers with app access")
    assert.equal(driverAppReadingOf(drivers, "project-harbor"), "1 of 1 driver with app access")
    assert.equal(driverAppReadingOf(drivers, "project-cairo"), "No drivers")
  })
})
