// A role that does not view the organisation (Issue #217): only the Company
// Administrator views configure.organization, so for every other role a
// row's project resolved to an id chip, which the workspace's pinned scope
// never matched, and every project-scoped switched module showed nothing.
// `/me` names the person's projects without that grant: the store files them
// where the resolver finds them, under the web id the organisation module
// would give each, and the pinned scope derives from them (the plan on #81).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Vehicle } from "@waste/contracts/fleet"

import { ALL_PROJECTS, isInProjectScope, type ProjectRecordId } from "../../data/project-scope"
import { NOTHING_RESOLVED, webIdOf } from "../records/adapter"
import { ME_PROJECTS, projectScopeOfMe, withMeProjects } from "../records/me-projects"
import { fleetVehiclesModule, vehicleAdapter } from "../records/fleet"
import { loadModule, resolverOver, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, scripted } from "./scripted-fetch"

const copenhagen = { id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central", timezone: "Europe/Copenhagen", currency: "DKK" }
const harbor = { id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial", timezone: "Europe/Copenhagen", currency: "DKK" }
const unnamed = { id: "01a0d2a4-a280-7002-8000-000000000009", name: "Roskilde Pilot", timezone: "Europe/Copenhagen", currency: "DKK" }
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }

const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: "01a0d2a4-a280-7008-8000-000000000001", ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: null, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [] }

describe("the person's projects from /me, where the role does not view the organisation", () => {
  const state: ServerRecordsState = withMeProjects(new Map(), [copenhagen, harbor, unnamed])
  const copenhagenId = webIdOf("project", copenhagen.id) as ProjectRecordId

  test("each is filed under the web id the organisation module gives it, project-<uuid>", () => {
    const resolve = resolverOver(state)
    assert.equal(resolve.byServerId(copenhagen.id)?.id, copenhagenId)
    assert.equal(resolve.byServerId(copenhagen.id)?.name, "Copenhagen Central")
    assert.equal(resolve.byServerId(harbor.id)?.id, `project-${harbor.id}`)
    assert.equal(resolve.byServerId(unnamed.id)?.id, `project-${unnamed.id}`)
    assert.equal(resolve.serverIdOf(copenhagenId), copenhagen.id)
    assert.ok(state.has(ME_PROJECTS))
  })

  test("a row a module loads names its project so, and the pinned scope finds it", async () => {
    const { fetch } = scripted([() => json({ items: [wh24], nextCursor: null })])
    const { records } = await loadModule(clientOver(fetch), fleetVehiclesModule, { state })
    assert.deepEqual(records[0].projectIds, [copenhagenId])
    assert.equal(records[0].facts.Project, "Copenhagen Central")
    assert.ok(isInProjectScope(records[0], copenhagenId))
    const unresolved = vehicleAdapter.toRecord(wh24, { resolve: NOTHING_RESOLVED })
    assert.equal(unresolved.facts.Project, undefined, "without them, the row names no project")
  })

  test("nothing is filed for a person with no project, a provider's user", () => {
    assert.equal(withMeProjects(new Map(), []).get(ME_PROJECTS)?.records.length, 0)
  })
})

describe("the pinned project scope on the Pilot", () => {
  test("is the one project /me names where the person works in exactly one", () => {
    assert.equal(projectScopeOfMe([copenhagen]), webIdOf("project", copenhagen.id))
    assert.equal(projectScopeOfMe([unnamed]), `project-${unnamed.id}`)
  })

  test("is every project for a person who works in several, whatever they are named", () => {
    assert.equal(projectScopeOfMe([harbor, copenhagen]), ALL_PROJECTS)
    assert.equal(projectScopeOfMe([copenhagen, harbor, unnamed]), ALL_PROJECTS)
  })

  test("is every project for a person with none, and until /me is read", () => {
    assert.equal(projectScopeOfMe([]), ALL_PROJECTS)
    assert.equal(projectScopeOfMe(undefined), ALL_PROJECTS)
  })
})
