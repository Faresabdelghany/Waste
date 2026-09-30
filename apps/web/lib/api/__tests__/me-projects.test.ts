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

import { getModuleDefinition } from "../../data/business-modules"
import { ALL_PROJECTS, isInProjectScope } from "../../data/project-scope"
import { NOTHING_RESOLVED } from "../records/adapter"
import { ME_PROJECTS, projectScopeOfMe, withMeProjects } from "../records/me-projects"
import { fleetVehiclesModule, vehicleAdapter } from "../records/fleet"
import { loadModule, resolverOver, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, scripted } from "./scripted-fetch"

const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const copenhagen = { id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central" }
const harbor = { id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial" }
const unnamed = { id: "01a0d2a4-a280-7002-8000-000000000009", name: "Roskilde Pilot" }
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }

const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: "01a0d2a4-a280-7008-8000-000000000001", ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: null, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [] }

describe("the person's projects from /me, where the role does not view the organisation", () => {
  const state: ServerRecordsState = withMeProjects(new Map(), [copenhagen, harbor, unnamed], organisationFixtures)

  test("each is filed under the web id the organisation module gives it: the fixture's of its name, else project-<uuid>", () => {
    const resolve = resolverOver(state)
    assert.equal(resolve.byServerId(copenhagen.id)?.id, "project-copenhagen")
    assert.equal(resolve.byServerId(copenhagen.id)?.name, "Copenhagen Central")
    assert.equal(resolve.byServerId(harbor.id)?.id, "project-harbor")
    assert.equal(resolve.byServerId(unnamed.id)?.id, `project-${unnamed.id}`)
    assert.equal(resolve.serverIdOf("project-copenhagen"), copenhagen.id)
    assert.ok(state.has(ME_PROJECTS))
  })

  test("a row a module loads names its project so, and the pinned scope finds it", async () => {
    const { fetch } = scripted([() => json({ items: [wh24], nextCursor: null })])
    const { records } = await loadModule(clientOver(fetch), fleetVehiclesModule, { fixtures: [], state })
    assert.deepEqual(records[0].projectIds, ["project-copenhagen"])
    assert.equal(records[0].facts.Project, "Copenhagen Central")
    assert.ok(isInProjectScope(records[0], "project-copenhagen"))
    // Without them, the chip the scope never matched (the defect).
    const unresolved = vehicleAdapter.toRecord(wh24, { fixtures: [], resolve: NOTHING_RESOLVED })
    assert.equal(isInProjectScope(unresolved, "project-copenhagen"), false)
  })

  test("nothing is filed for a person with no project, a provider's user", () => {
    assert.equal(withMeProjects(new Map(), [], organisationFixtures).get(ME_PROJECTS)?.records.length, 0)
  })
})

describe("the pinned project scope on the Pilot", () => {
  test("stays the default where the person works in it", () => {
    assert.equal(projectScopeOfMe([copenhagen, harbor], organisationFixtures, "project-copenhagen"), "project-copenhagen")
  })

  test("is the person's first project where the default is not among theirs", () => {
    assert.equal(projectScopeOfMe([harbor], organisationFixtures, "project-copenhagen"), "project-harbor")
    assert.equal(projectScopeOfMe([unnamed], organisationFixtures, "project-copenhagen"), `project-${unnamed.id}`)
  })

  test("is every project for a person with none, and the default until /me is read", () => {
    assert.equal(projectScopeOfMe([], organisationFixtures, "project-copenhagen"), ALL_PROJECTS)
    assert.equal(projectScopeOfMe(undefined, organisationFixtures, "project-copenhagen"), "project-copenhagen")
  })
})
