// Which kind a record of `service-providers.service-areas` is (#186): an award
// or one of its assignments — the id's prefix, then the kind a form stamped —
// the one rule the adapters own by and the pickers pointing at the module
// filter by, as `masterDataKindOf` is for the master data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { isAssignmentRecord, isServiceAreaRecord, serviceAreaKindForField, serviceAreaKindOf } from "../provider-money"

const of = (id: string, recordKind?: string) => ({ id, recordKind }) as BusinessRecord

describe("a service areas record's kind", () => {
  test("is its id's prefix, then the kind its form stamped on a row minted this session", () => {
    assert.equal(serviceAreaKindOf(of("service-area-01a0d2a4")), "service-area")
    assert.equal(serviceAreaKindOf(of("assignment-01a0d2a4")), "assignment")
    assert.equal(serviceAreaKindOf(of("service-areas-service-area-1700000000000", "Service area")), "service-area")
    assert.equal(serviceAreaKindOf(of("service-areas-assignment-1700000000000", "Service area assignment")), "assignment")
    assert.equal(serviceAreaKindOf(of("service-area-01a0d2a4", "Service area assignment")), "service-area", "the prefix first")
    assert.equal(serviceAreaKindOf(of("ca-o-2", "Contract area")), null, "a fixture of neither")
  })

  test("is what the ownership rules read", () => {
    assert.ok(isServiceAreaRecord(of("service-areas-service-area-1", "Service area")))
    assert.ok(!isServiceAreaRecord(of("assignment-01a0d2a4")))
    assert.ok(isAssignmentRecord(of("service-areas-assignment-1", "Service area assignment")))
    assert.ok(!isAssignmentRecord(of("service-area-01a0d2a4")))
  })

  test("is what a field pointing at the module picks, by its id", () => {
    assert.equal(serviceAreaKindForField("serviceAreaId"), "service-area")
    assert.equal(serviceAreaKindForField("serviceAreaAssignmentId"), "assignment")
    assert.equal(serviceAreaKindForField("notes"), null)
  })
})
