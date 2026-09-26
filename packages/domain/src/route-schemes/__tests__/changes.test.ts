import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  NO_VALUE,
  groupStopsLabel,
  groupSummaryLabel,
  schemeDraftChanges,
  type SchemeDraftNames,
} from "../changes"
import type { CollectionGroup } from "../groups"
import type { GuidedSchemeData } from "../quick-create"

const bins: CollectionGroup = {
  id: "group-bins",
  name: "Residual · bins",
  days: ["monday", "wednesday"],
  fractions: ["Residual"],
  vehicleId: "vehicle-wh-31",
  driverId: "driver-freja",
  stopSource: "rule",
  containerTypes: ["Two-wheel bin · 240 L", "Two-wheel bin · 140 L"],
  containerIds: [],
}

const picked: CollectionGroup = {
  id: "group-picked",
  name: "Harbour picks",
  days: ["friday"],
  fractions: ["Residual"],
  stopSource: "manual",
  containerIds: ["c-1", "c-2", "c-3"],
}

const base: GuidedSchemeData = {
  schemeName: "RS-Central residual",
  projectId: "project-copenhagen",
  planningAreaId: "area-indre-by",
  wasteFraction: "Residual",
  serviceType: "Kerbside collection",
  frequency: "weekly",
  weekRotation: "odd",
  serviceDays: ["monday", "wednesday", "friday"],
  effectiveFrom: "2026-10-05",
  effectiveTo: "",
  plannedStartTime: "06:30",
  holidayPolicy: "skip",
  createAs: "validated",
  editPolicy: "ask",
  depotId: "depot-central",
  unloadingStationId: "station-arc",
  groups: [bins, picked],
}

const names: SchemeDraftNames = {
  project: (id) => ({ "project-copenhagen": "Copenhagen Central" })[id],
  area: (id) => ({ "area-indre-by": "Indre By Operations" })[id],
  depot: (id) => ({ "depot-central": "Central Depot" })[id],
  station: (id) => ({ "station-arc": "ARC Amager Bakke" })[id],
  vehicle: (id) => ({ "vehicle-wh-31": "WH-31" })[id],
  driver: (id) => ({ "driver-freja": "Freja Nielsen" })[id],
}

describe("schemeDraftChanges", () => {
  test("two identical drafts have no changes", () => {
    assert.deepEqual(schemeDraftChanges(base, { ...base, groups: [...base.groups] }, names), [])
  })

  test("a changed scalar reads as label, before, after — ids as names", () => {
    const after: GuidedSchemeData = {
      ...base,
      serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      holidayPolicy: "shift-next",
      effectiveTo: "2027-03-31",
      depotId: undefined,
    }
    assert.deepEqual(schemeDraftChanges(base, after, names), [
      { field: "depotId", label: "Departure depot", before: "Central Depot", after: NO_VALUE },
      { field: "serviceDays", label: "Service days", before: "Mon, Wed, Fri", after: "Mon–Fri" },
      { field: "effectiveTo", label: "Effective to", before: NO_VALUE, after: "31 Mar 2027" },
      {
        field: "holidayPolicy",
        label: "On a public holiday",
        before: "Skip the collection",
        after: "Shift to the next working day",
      },
    ])
  })

  test("the fortnight rotation is part of the frequency reading", () => {
    const after: GuidedSchemeData = { ...base, frequency: "every-2-weeks", weekRotation: "even" }
    assert.deepEqual(schemeDraftChanges(base, after), [
      { field: "frequency", label: "Frequency", before: "Every week", after: "Every 2 weeks (even ISO weeks)" },
    ])
  })

  test("the edit policy reads as its label, after the create option", () => {
    const after: GuidedSchemeData = { ...base, createAs: "effective", editPolicy: "single" }
    assert.deepEqual(schemeDraftChanges(base, after), [
      {
        field: "createAs",
        label: "Create as",
        before: "Validated — routes stay unpublished",
        after: "Effective — routes publish from the first collection",
      },
      {
        field: "editPolicy",
        label: "Changes to a running scheme",
        before: "Ask each time",
        after: "This collection only",
      },
    ])
  })

  test("without a name lookup an id reads as itself", () => {
    const after: GuidedSchemeData = { ...base, projectId: "project-harbor" }
    assert.deepEqual(schemeDraftChanges(base, after), [
      { field: "projectId", label: "Project", before: "project-copenhagen", after: "project-harbor" },
    ])
  })

  test("groups: added, removed, and changed — matched by id, spelled as their summary line", () => {
    const renamed: CollectionGroup = { ...bins, name: "Residual · large bins", containerTypes: ["Two-wheel bin · 240 L"] }
    const glass: CollectionGroup = {
      id: "group-glass",
      name: "Glass igloos",
      days: ["wednesday"],
      fractions: ["Residual"],
      vehicleId: "vehicle-unknown",
      stopSource: "rule",
      containerTypes: [],
      containerIds: [],
    }
    const after: GuidedSchemeData = { ...base, groups: [renamed, glass] }
    assert.deepEqual(schemeDraftChanges(base, after, names), [
      {
        field: "group:group-bins",
        label: "Residual · bins → Residual · large bins",
        before: "Mon, Wed · WH-31 · Freja Nielsen · 240 L, 140 L",
        after: "Mon, Wed · WH-31 · Freja Nielsen · 240 L",
      },
      {
        field: "group:group-glass",
        label: "Glass igloos",
        before: "Added",
        after: "Wed · vehicle-unknown · Unassigned · Any container type",
      },
      {
        field: "group:group-picked",
        label: "Harbour picks",
        before: "Fri · — · Unassigned · 3 containers",
        after: "Removed",
      },
    ])
  })

  test("a group's stops read as its container types or its picked count", () => {
    assert.equal(groupStopsLabel(bins), "240 L, 140 L")
    assert.equal(groupStopsLabel(picked), "3 containers")
    assert.equal(groupStopsLabel({ ...picked, containerIds: ["c-1"] }), "1 container")
    assert.equal(groupStopsLabel({ ...bins, containerTypes: undefined }), "Any container type")
  })

  test("a stored group carries its display names when it has no ids to look up", () => {
    const stored: CollectionGroup = {
      ...bins,
      vehicleId: undefined,
      driverId: undefined,
      vehicleName: "WH-24",
      driverName: "Mads Sørensen",
    }
    assert.equal(groupSummaryLabel(stored, {}), "Mon, Wed · WH-24 · Mads Sørensen · 240 L, 140 L")
    // The display name is never offered to the id lookup — only an id is.
    const asked: string[] = []
    const spying: SchemeDraftNames = {
      vehicle: (id) => {
        asked.push(id)
        return undefined
      },
      driver: (id) => {
        asked.push(id)
        return undefined
      },
    }
    assert.equal(groupSummaryLabel(stored, spying), "Mon, Wed · WH-24 · Mads Sørensen · 240 L, 140 L")
    assert.deepEqual(asked, [])
    groupSummaryLabel(bins, spying)
    assert.deepEqual(asked, ["vehicle-wh-31", "driver-freja"])
  })
})
