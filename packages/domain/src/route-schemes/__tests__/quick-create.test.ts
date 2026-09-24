// The quick form's seams beside quickSchemeDraftFromValues (draft.test.ts):
// the edit seed, the edit-save write of the scheme's fraction onto the rule
// or the groups, and the two field-id sets (issue #43).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_LICENCE_ON_RECORD, NO_VEHICLE_LICENCE_CLASS } from "../fleet-profiles"
import { COLLECTION_GROUPS_KEY, parseCollectionGroups } from "../groups"
import { matchPlansFromValues } from "../matching"
import {
  GROUP_OWNED_SCHEME_FIELD_IDS,
  QUICK_SCHEME_DRAFT_FIELD_IDS,
  applySchemeWasteFraction,
  quickDriverIssue,
  quickDriverOptions,
  quickPlannedVehicle,
  seedSchemeEditValues,
} from "../quick-create"

describe("the quick form's field ids", () => {
  test("the draft consumes the single fraction and the service type, not the retired list", () => {
    assert.ok(QUICK_SCHEME_DRAFT_FIELD_IDS.has("wasteFraction"))
    assert.ok(QUICK_SCHEME_DRAFT_FIELD_IDS.has("serviceType"))
    assert.ok(QUICK_SCHEME_DRAFT_FIELD_IDS.has("matchContainerTypes"))
    assert.equal(QUICK_SCHEME_DRAFT_FIELD_IDS.has("matchFractions"), false)
  })

  test("a multi-group scheme's groups own the rule's container types; the fraction is the scheme's", () => {
    assert.ok(GROUP_OWNED_SCHEME_FIELD_IDS.has("matchContainerTypes"))
    assert.ok(GROUP_OWNED_SCHEME_FIELD_IDS.has("matchVehicleType"))
    assert.equal(GROUP_OWNED_SCHEME_FIELD_IDS.has("wasteFraction"), false)
    assert.equal(GROUP_OWNED_SCHEME_FIELD_IDS.has("serviceType"), false)
    assert.equal(GROUP_OWNED_SCHEME_FIELD_IDS.has("matchFractions"), false)
  })
})

describe("seedSchemeEditValues: the fraction and service type selects", () => {
  test("a stored scheme-level fraction and service type seed as they are", () => {
    const seeded = seedSchemeEditValues({
      stopSelection: "rule",
      wasteFraction: "Glass",
      serviceType: "Kerbside collection",
      matchFractions: "Glass",
    })
    assert.equal(seeded.wasteFraction, "Glass")
    assert.equal(seeded.serviceType, "Kerbside collection")
    // The retired field is not seeded under its old id.
    assert.equal("matchFractions" in seeded, false)
  })

  test("a rule naming one fraction seeds it for a record that predates the field", () => {
    const seeded = seedSchemeEditValues({ stopSelection: "rule", matchFractions: "Residual" })
    assert.equal(seeded.wasteFraction, "Residual")
  })

  test("a rule naming several fractions blanks for a re-pick", () => {
    const seeded = seedSchemeEditValues({
      stopSelection: "rule",
      wasteFraction: "",
      matchFractions: "Paper, Cardboard",
    })
    assert.equal(seeded.wasteFraction, "")
  })

  test("explicit groups seed the fraction every group shares, else blank", () => {
    const shared = seedSchemeEditValues({
      [COLLECTION_GROUPS_KEY]: JSON.stringify([
        { id: "a", days: ["monday"], fractions: ["Organic"], stopSource: "rule" },
        { id: "b", days: ["tuesday"], fractions: ["Organic"], stopSource: "manual" },
      ]),
    })
    assert.equal(shared.wasteFraction, "Organic")
    const mixed = seedSchemeEditValues({
      [COLLECTION_GROUPS_KEY]: JSON.stringify([
        { id: "a", days: ["monday"], fractions: ["Organic"], stopSource: "rule" },
        { id: "b", days: ["tuesday"], fractions: ["Paper"], stopSource: "rule" },
      ]),
    })
    assert.equal(mixed.wasteFraction, "")
  })

  test("a manual scheme without a fraction, and a round-2 service type, seed blank", () => {
    const seeded = seedSchemeEditValues({ containerIds: "c1,c2", serviceType: "Collection" })
    assert.equal(seeded.wasteFraction, "")
    assert.equal(seeded.serviceType, "")
    assert.equal(seeded.stopSelection, "manual")
  })
})

describe("applySchemeWasteFraction: the edit-save writes the scheme's fraction where the readers look", () => {
  test("a rule scheme gets it on the shared rule, and the rest of the rule is kept", () => {
    const values = applySchemeWasteFraction({
      stopSelection: "rule",
      wasteFraction: "Glass",
      matchFractions: "Residual",
      matchVehicleType: "Glass crane",
      matchContainerTypes: "Igloo · 2,500 L",
    })
    assert.equal(values.matchFractions, "Glass")
    assert.equal(values.matchVehicleType, "Glass crane")
    assert.equal(values.matchContainerTypes, "Igloo · 2,500 L")
    assert.deepEqual(matchPlansFromValues(values).sharedRule, {
      fractions: ["Glass"],
      vehicleType: "Glass crane",
      containerTypes: ["Igloo · 2,500 L"],
    })
    // A record without per-day rules does not gain the key.
    assert.equal("matchRulesByDay" in values, false)
  })

  test("per-day rules follow the scheme's fraction too", () => {
    const values = applySchemeWasteFraction({
      stopSelection: "rule",
      sameAllDays: false,
      wasteFraction: "Organic",
      matchFractions: "Residual",
      matchRulesByDay: JSON.stringify({
        monday: { fractions: ["Residual"], vehicleType: "Rear loader" },
        thursday: { fractions: ["Paper", "Cardboard"] },
      }),
    })
    const plans = matchPlansFromValues(values)
    assert.deepEqual(plans.sharedRule.fractions, ["Organic"])
    assert.deepEqual(plans.rulesByDay, {
      monday: { fractions: ["Organic"], vehicleType: "Rear loader" },
      thursday: { fractions: ["Organic"] },
    })
  })

  test("explicit groups every inherit it, the way draftGroups scopes a draft", () => {
    const values = applySchemeWasteFraction({
      wasteFraction: "Glass",
      stopSelection: "",
      [COLLECTION_GROUPS_KEY]: JSON.stringify([
        { id: "a", name: "Igloos", days: ["monday"], fractions: ["Residual"], stopSource: "rule", vehicleId: "v1" },
        { id: "b", name: "Picked", days: ["tuesday"], fractions: [], stopSource: "manual", containerIds: ["c1"] },
      ]),
    })
    const groups = parseCollectionGroups(String(values[COLLECTION_GROUPS_KEY]))
    assert.deepEqual(
      groups.map((group) => [group.id, group.fractions, group.vehicleId ?? null, group.containerIds]),
      [
        ["a", ["Glass"], "v1", []],
        ["b", ["Glass"], null, ["c1"]],
      ],
    )
    // The legacy keys are not written for an explicit-groups scheme.
    assert.equal("matchFractions" in values, false)
  })

  test("a manual scheme, or no scheme-level fraction, is returned unchanged", () => {
    const manual = { stopSelection: "manual", wasteFraction: "Glass", containerIds: "c1", matchFractions: "" }
    assert.deepEqual(applySchemeWasteFraction(manual), manual)
    const blank = { stopSelection: "rule", wasteFraction: "", matchFractions: "Paper, Cardboard" }
    assert.deepEqual(applySchemeWasteFraction(blank), blank)
    const spaces = { stopSelection: "rule", wasteFraction: "  ", matchFractions: "Residual" }
    assert.deepEqual(applySchemeWasteFraction(spaces), spaces)
  })
})

describe("the quick form's driver select applies the licence rule (issue #37)", () => {
  const fleet = (
    id: string,
    name: string,
    context: string,
    submittedValues?: Record<string, string | boolean>,
  ) => ({ id, name, context, facts: {}, submittedValues })

  const wh24 = fleet("vehicle-wh24", "WH-24 · CN 42 018", "Rear loader 18 t · Nordhavn", {
    requiredLicenceClass: "C",
  })
  const trailer = fleet("trailer-wh12", "WH-T12 · Closed trailer", "18 t trailer · Nordhavn", {
    requiredLicenceClass: "CE",
  })
  const unclassed = fleet("vehicle-old", "WH-40 · AA 11 222", "Rear loader 18 t · Nordhavn")
  const vehicles = [wh24, trailer, unclassed]

  const mads = fleet("driver-mads", "Mads Jensen", "Kystbyen", { licenceClass: "CE" })
  const lars = fleet("driver-lars", "Lars Møller", "NordRen ApS", { licenceClass: "C" })
  const emil = fleet("driver-emil", "Emil Kristensen", "Kystbyen", { licenceClass: "B" })
  const jonas = fleet("driver-jonas", "Jonas Lind", "Kystbyen · onboarding")
  const drivers = [mads, lars, emil, jonas]

  test("quickPlannedVehicle is the fleet record the form's plannedVehicleId names", () => {
    assert.equal(quickPlannedVehicle({ plannedVehicleId: "vehicle-wh24" }, vehicles), wh24)
    assert.equal(quickPlannedVehicle({ plannedVehicleId: "" }, vehicles), undefined)
    assert.equal(quickPlannedVehicle({}, vehicles), undefined)
    assert.equal(quickPlannedVehicle({ plannedVehicleId: "vehicle-gone" }, vehicles), undefined)
  })

  test("every driver is listed; an ineligible one is disabled with the reason, as on Guided Setup step 3", () => {
    assert.deepEqual(
      quickDriverOptions({ plannedVehicleId: "vehicle-wh24" }, drivers, vehicles).map((option) => [
        option.driver.id,
        option.eligible,
        option.reason,
      ]),
      [
        ["driver-mads", true, undefined],
        ["driver-lars", true, undefined],
        ["driver-emil", false, "Needs C licence"],
        ["driver-jonas", false, NO_LICENCE_ON_RECORD],
      ],
    )
    assert.deepEqual(
      quickDriverOptions({ plannedVehicleId: "trailer-wh12" }, drivers, vehicles)
        .filter((option) => option.eligible)
        .map((option) => option.driver.id),
      ["driver-mads"],
    )
  })

  test("without a planned vehicle nothing is judged; a vehicle without a class judges nobody", () => {
    assert.ok(quickDriverOptions({}, drivers, vehicles).every((option) => option.eligible))
    assert.ok(
      quickDriverOptions({ plannedVehicleId: "vehicle-gone" }, drivers, vehicles).every(
        (option) => option.eligible,
      ),
    )
    assert.ok(
      quickDriverOptions({ plannedVehicleId: "vehicle-old" }, drivers, vehicles).every(
        (option) => !option.eligible && option.reason === NO_VEHICLE_LICENCE_CLASS,
      ),
    )
  })

  test("quickDriverIssue is the submit check: the reason when the picked pair may not go out, else nothing", () => {
    assert.equal(
      quickDriverIssue({ plannedVehicleId: "vehicle-wh24", plannedDriverId: "driver-emil" }, drivers, vehicles),
      "Needs C licence",
    )
    assert.equal(
      quickDriverIssue({ plannedVehicleId: "vehicle-wh24", plannedDriverId: "driver-jonas" }, drivers, vehicles),
      NO_LICENCE_ON_RECORD,
    )
    assert.equal(
      quickDriverIssue({ plannedVehicleId: "vehicle-old", plannedDriverId: "driver-mads" }, drivers, vehicles),
      NO_VEHICLE_LICENCE_CLASS,
    )
    assert.equal(
      quickDriverIssue({ plannedVehicleId: "vehicle-wh24", plannedDriverId: "driver-mads" }, drivers, vehicles),
      undefined,
    )
    // Half a pair, or an id naming nothing, is nothing to refuse — the required-field check speaks then.
    assert.equal(quickDriverIssue({ plannedDriverId: "driver-jonas" }, drivers, vehicles), undefined)
    assert.equal(quickDriverIssue({ plannedVehicleId: "vehicle-wh24" }, drivers, vehicles), undefined)
    assert.equal(
      quickDriverIssue({ plannedVehicleId: "vehicle-wh24", plannedDriverId: "driver-gone" }, drivers, vehicles),
      undefined,
    )
  })
})
