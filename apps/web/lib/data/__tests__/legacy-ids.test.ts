import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  LEGACY_RECORD_IDS,
  hasLegacyIds,
  migrateLegacyHref,
  migrateLegacyId,
  migrateLegacyRecordBuckets,
  migrateLegacyState,
} from "../legacy-ids"

// The demo tenant's company record was named after the product's old working
// name until 2026-09-24. Its id is persisted — record buckets, relation refs,
// role access maps and `?record=` bookmarks all carry it — so the rename goes
// through the same seam as every other retired id.
const LEGACY_COMPANY_ID = "company-wastehero-dk"
/** The id it migrates to. */
const COMPANY_ID = "company-kystbyen-dk"

describe("the demo tenant's record id: company-wastehero-dk → company-kystbyen-dk", () => {
  test("the map names the fixture company's current id", () => {
    assert.equal(LEGACY_RECORD_IDS[LEGACY_COMPANY_ID], COMPANY_ID)
  })

  test("the id is rewritten, and rewriting it twice changes nothing", () => {
    assert.equal(migrateLegacyId(LEGACY_COMPANY_ID), COMPANY_ID)
    assert.equal(migrateLegacyId(COMPANY_ID), COMPANY_ID)
    // A different company keeps its id: only the listed pair is renamed.
    assert.equal(migrateLegacyId("company-harbor"), "company-harbor")
  })

  test("a bookmark into the organization record is re-pointed", () => {
    assert.equal(
      migrateLegacyHref(`/configure?module=organization&record=${LEGACY_COMPANY_ID}`),
      `/configure?module=organization&record=${COMPANY_ID}`,
    )
  })

  test("persisted state carrying the id is rewritten wherever it sits", () => {
    const stored = {
      companyId: LEGACY_COMPANY_ID,
      relationRefs: [
        {
          fieldId: "companyId",
          workspaceId: "configure",
          moduleId: "organization",
          recordId: LEGACY_COMPANY_ID,
        },
      ],
      access: { [LEGACY_COMPANY_ID]: { projects: ["project-copenhagen"] } },
    }

    assert.deepEqual(migrateLegacyState(stored), {
      companyId: COMPANY_ID,
      relationRefs: [
        {
          fieldId: "companyId",
          workspaceId: "configure",
          moduleId: "organization",
          recordId: COMPANY_ID,
        },
      ],
      access: { [COMPANY_ID]: { projects: ["project-copenhagen"] } },
    })
    // Already-migrated state comes back by reference, so a store can tell
    // that nothing changed.
    const current = migrateLegacyState(stored)
    assert.equal(migrateLegacyState(current), current)
  })

  test("a stored record keeps its place and takes the new id", () => {
    const buckets = {
      "configure.organization": [
        { id: LEGACY_COMPANY_ID, name: "Kystbyen Renovation A/S" },
      ],
    }

    assert.deepEqual(migrateLegacyRecordBuckets(buckets), {
      "configure.organization": [
        { id: COMPANY_ID, name: "Kystbyen Renovation A/S" },
      ],
    })
  })

  test("the pre-check sees the retired id and not the current one", () => {
    assert.equal(hasLegacyIds(JSON.stringify({ id: LEGACY_COMPANY_ID })), true)
    assert.equal(hasLegacyIds(JSON.stringify({ id: COMPANY_ID })), false)
  })
})
